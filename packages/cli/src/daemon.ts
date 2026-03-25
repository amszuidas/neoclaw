/**
 * NeoClaw Daemon — manages the process lifecycle.
 *
 * Responsibilities:
 * - PID file management (prevents duplicate instances)
 * - Signal handling (SIGTERM / SIGINT for graceful shutdown)
 * - Workspaces directory initialization
 * - Component assembly (Dispatcher + Agent + Gateway)
 * - Restart coordination (spawns new process, saves notification context)
 * - Startup notification (informs user after a /restart-triggered restart)
 *
 * Self-daemonizes on first launch (forks to background, redirects I/O to log file).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeCodeAgent } from '@neoclaw/agents/claude-code';
import { OpencodeAgent } from '@neoclaw/agents/opencode';
import { createFileBlockedAgent } from '@neoclaw/agents/file-blocked-agent';
import { BUILDIN_AGENTS } from '@neoclaw/core';
import type { NeoClawConfig } from '@neoclaw/core/config';
import { CronScheduler } from '@neoclaw/cron/scheduler';
import { Dispatcher } from '@neoclaw/core/dispatcher';
import { FeishuGateway } from '@neoclaw/gateway/feishu';
import { MemoryManager, MemoryStore } from '@neoclaw/core/memory';
import { initFileLogs, logger, setLogLevel } from '@neoclaw/core/utils/logger';
import { NEOCLAW_HOME } from '@neoclaw/core/config';

const log = logger('daemon');

/** Build the system prompt section that describes the neoclaw cron CLI to Claude. */
function buildCronCliSystemPrompt(): string {
  return `\
## Cron Job Management

Use \`neoclaw cron\` to manage scheduled tasks. When a job triggers, its --message is sent to you in the current session.

### Commands
\`\`\`bash
# One-time task
neoclaw cron create --message "prompt" --run-at "2024-03-01T09:00:00+08:00" [--label "name"]

# Recurring task (cron format: min hour day month weekday)
neoclaw cron create --message "prompt" --cron-expr "0 9 * * 1-5" [--label "name"]

# List / delete / update
neoclaw cron list [--include-disabled]
neoclaw cron delete --job-id <id>
neoclaw cron update --job-id <id> [--label ".."] [--message ".."] [--enabled true|false] [--run-at ".."] [--cron-expr ".."]
\`\`\`

All commands output JSON.`;
}

// Path where the restart notification is persisted between process generations
const RESTART_NOTIFY_PATH = join(NEOCLAW_HOME, 'cache', 'restart-notify.json');

export class NeoClawDaemon {
  private _abort = new AbortController();
  private _memoryManager: MemoryManager | null = null;

  constructor(private readonly config: NeoClawConfig) {}

  // ── Main entry point ──────────────────────────────────────

  async run(): Promise<void> {
    // Self-daemonize: if this is the first launch (not the background child),
    // fork to background with I/O redirected to the log file, then exit.
    if (!process.env['NEOCLAW_DAEMON']) {
      const env: Record<string, string | undefined> = { ...process.env, NEOCLAW_DAEMON: '1' };
      delete env['CLAUDECODE'];
      delete env['CLAUDE_CODE_ENTRYPOINT'];
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env,
      });
      child.unref();
      console.log('NeoClaw daemon started in background. Logs:', join(NEOCLAW_HOME, 'logs'));
      process.exit(0);
    }

    // Enable daily-rotating file logging before anything else so that even
    // takeover / PID messages land in the right file.
    initFileLogs(join(NEOCLAW_HOME, 'logs'));
    setLogLevel(this.config.logLevel ?? 'info');
    this._takeover();
    this._writePid();
    this._registerSignals();
    this._ensureDirs();

    const dispatcher = await this._buildDispatcher();
    const scheduler = new CronScheduler(dispatcher);

    log.info('='.repeat(60));
    log.info(`NeoClaw daemon starting — pid=${process.pid}`);

    // Wait a few seconds for gateways to initialize before sending restart notification
    setTimeout(() => this._sendStartupNotification(dispatcher), 5000);

    try {
      scheduler.start();
      this._memoryManager?.startPeriodicReindex();
      await Promise.race([
        dispatcher.start(),
        // Resolve when abort is signaled
        new Promise<never>((_, reject) => {
          this._abort.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        }),
      ]);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
    } finally {
      this._memoryManager?.stopPeriodicReindex();
      scheduler.stop();
      await dispatcher.stop();
      log.info('NeoClaw daemon stopped.');
    }
  }

  // ── PID management ────────────────────────────────────────

  private _pidPath(): string {
    return join(NEOCLAW_HOME, 'cache', 'neoclaw.pid');
  }

  private _writePid(): void {
    const dir = dirname(this._pidPath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this._pidPath(), String(process.pid));
    log.info(`PID written: ${this._pidPath()} (pid=${process.pid})`);
  }

  private _removePid(): void {
    try {
      if (existsSync(this._pidPath())) unlinkSync(this._pidPath());
      log.info(`PID file removed: ${this._pidPath()}`);
    } catch {
      /* ignore */
      log.warn(`Failed to remove PID file: ${this._pidPath()}`);
    }
  }

  /**
   * If an existing daemon is running, send SIGTERM and wait for it to exit
   * before this process claims the PID file.
   */
  private _takeover(): void {
    const pidPath = this._pidPath();
    if (!existsSync(pidPath)) return;

    let oldPid: number;
    try {
      oldPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      log.info(`Existing PID file found: ${pidPath} (pid=${oldPid})`);
    } catch {
      log.warn(`Failed to parse PID file: ${pidPath}`);
      this._removePid();
      return;
    }
    if (isNaN(oldPid)) {
      log.warn(`Invalid PID value in file: ${pidPath}`);
      this._removePid();
      return;
    }

    // Check if the old process is still running
    try {
      process.kill(oldPid, 0);
      log.info(`Old daemon (pid=${oldPid}) is still running.`);
    } catch {
      // Stale PID file
      log.warn(`Stale PID file found: ${pidPath} (pid=${oldPid})`);
      this._removePid();
      return;
    }

    // Gracefully terminate the old daemon
    try {
      log.info(`Existing daemon found (pid=${oldPid}), sending SIGTERM...`);
      process.kill(oldPid, 'SIGTERM');
    } catch {
      /* already gone */
      log.warn(`Failed to send SIGTERM to old daemon (pid=${oldPid})`);
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(oldPid, 0);
        log.info(`Old daemon (pid=${oldPid}) is still running.`);
      } catch {
        log.info(`Old daemon (pid=${oldPid}) exited.`);
        this._removePid();
        return;
      }
      Bun.sleepSync(1000);
    }

    try {
      log.info(`Sending SIGKILL to old daemon (pid=${oldPid})`);
      process.kill(oldPid, 'SIGKILL');
    } catch {
      /* ignore */
      log.warn(`Failed to send SIGKILL to old daemon (pid=${oldPid})`);
    }

    Bun.sleepSync(1000);
    this._removePid();
  }

  // ── Signal handling ───────────────────────────────────────

  private _registerSignals(): void {
    const shutdown = (sig: string) => {
      log.info(`Received ${sig}, shutting down...`);
      this._abort.abort();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ── Directory setup ───────────────────────────────────────

  private _ensureDirs(): void {
    const dirs = [
      NEOCLAW_HOME,
      join(NEOCLAW_HOME, 'bin'),
      join(NEOCLAW_HOME, 'cache'),
      join(NEOCLAW_HOME, 'cron'),
      join(NEOCLAW_HOME, 'logs'),
      join(NEOCLAW_HOME, 'memory'),
      join(NEOCLAW_HOME, 'memory', 'episodes'),
      join(NEOCLAW_HOME, 'memory', 'knowledge'),
      this.config.skillsDir ?? join(NEOCLAW_HOME, 'skills'),
      this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    log.info(`Needed directories created: ${dirs.join(', ')}`);
  }

  // ── Component assembly ────────────────────────────────────

  private async _buildDispatcher(): Promise<Dispatcher> {
    const dispatcher = new Dispatcher();

    // Build and register the agent
    const agentType = this.config.agent;
    if (!BUILDIN_AGENTS.includes(agentType)) {
      log.error(
        `Unsupported agent type in config: "${agentType}". Supported types: ${BUILDIN_AGENTS.join(', ')}`
      );
      throw new Error(
        `Unsupported agent type in config: "${agentType}". Supported types: ${BUILDIN_AGENTS.join(', ')}`
      );
    }

    // Merge base system prompt with cron CLI instructions before constructing the agent.
    const cronPrompt = buildCronCliSystemPrompt();

    // Build file access restriction prompt
    let fileAccessPrompt = '';
    const blacklist = this.config.fileBlacklist ?? [];
    if (blacklist.length > 0) {
      fileAccessPrompt = `## File Access Restrictions\n\nYou are explicitly **PROHIBITED** from accessing the following files and directories:\n\n`;
      for (const pattern of blacklist) {
        fileAccessPrompt += `- \`${pattern}\`\n`;
      }
      fileAccessPrompt += `\nThese paths contain sensitive information (API keys, credentials, system files, or configuration). **Never** attempt to read, write, or modify these files, even if the user requests it. Politely decline and explain that these paths are protected for security reasons.\n`;
    }

    const systemPrompt =
      [this.config.systemPrompt, cronPrompt, fileAccessPrompt].filter(Boolean).join('\n\n') ||
      undefined;

    // Supported agents
    const agents = [
      new ClaudeCodeAgent({
        model: this.config.agents.claude_code?.model,
        allowedTools: this.config.agents.claude_code?.allowedTools,
        systemPrompt,
        cwd: this.config.workspacesDir,
        mcpServers: this.config.mcpServers,
        skillsDir: this.config.skillsDir,
      }),
      new OpencodeAgent({
        model: this.config.agents.opencode?.model,
        systemPrompt,
        cwd: this.config.workspacesDir,
        skillsDir: this.config.skillsDir,
      }),
    ];

    // Wrap agent with file blacklist enforcement
    const agentsWithWrapped = agents.map((agent) => createFileBlockedAgent(agent, blacklist));

    // Initialize memory system (used for session summarization and periodic reindex)
    const memoryDir = join(NEOCLAW_HOME, 'memory');
    const memoryStore = new MemoryStore(join(memoryDir, 'index.sqlite'));
    const memoryManager = new MemoryManager(memoryDir, memoryStore);
    memoryManager.reindex();
    this._memoryManager = memoryManager;

    agentsWithWrapped.forEach((agent) => dispatcher.addAgent(agent));
    dispatcher.setDefaultAgent(agentType);
    dispatcher.setWorkspacesDir(this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'));
    dispatcher.setMemoryManager(memoryManager);

    // Register Feishu gateway if credentials are present
    if (this.config.channels.feishu?.appId && this.config.channels.feishu?.appSecret) {
      const feishu = new FeishuGateway(this.config.channels.feishu);
      dispatcher.addGateway(feishu);
      log.info('Feishu gateway registered');
    } else {
      log.warn('Feishu credentials not configured — Feishu gateway not started');
    }

    // Register Wework gateway if credentials are present
    if (this.config.channels.wework?.botId && this.config.channels.wework?.secret) {
      const { WeworkWsGateway } = await import('@neoclaw/gateway/wework');
      const weworkConfig = {
        botId: this.config.channels.wework.botId,
        secret: this.config.channels.wework.secret,
        websocketUrl: this.config.channels.wework.websocketUrl,
      };
      const wework = new WeworkWsGateway(weworkConfig);
      dispatcher.addGateway(wework);
      log.info('Wework WebSocket gateway registered');
    } else {
      log.warn('Wework WebSocket credentials not configured — Wework gateway not started');
    }

    // Register Dashboard gateway if enabled
    if (this.config.channels.dashboard?.enabled) {
      const { DashboardGateway } = await import('@neoclaw/gateway/dashboard');
      const dashboard = new DashboardGateway(this.config.channels.dashboard);
      const port = this.config.channels.dashboard.port ?? 3000;
      dispatcher.addGateway(dashboard);
      log.info(`Dashboard gateway registered on http://localhost:${port}`);
    } else {
      log.info('Dashboard gateway not enabled — skip starting dashboard web interface');
    }

    // Ensure at least one gateway is configured
    const hasFeishu = this.config.channels.feishu?.appId && this.config.channels.feishu?.appSecret;
    const hasWework = this.config.channels.wework?.botId && this.config.channels.wework?.secret;
    const hasDashboard = this.config.channels.dashboard?.enabled;

    if (!hasFeishu && !hasWework && !hasDashboard) {
      log.error(
        'No gateway configured — at least one of Feishu, Wework, or Dashboard gateway must be configured'
      );
      throw new Error(
        'No gateway configured — at least one of Feishu, Wework, or Dashboard gateway must be configured'
      );
    }

    // Wire up restart handler
    dispatcher.onRestart((info) => this._triggerRestart(info));

    return dispatcher;
  }

  // ── Restart ───────────────────────────────────────────────

  private _triggerRestart(info: { chatId: string; gatewayKind: string }): void {
    log.info('Restart requested — forking new process...');

    // Persist notification context so the new process can inform the user
    this._saveRestartNotify(info);

    // Strip Claude Code env vars that would interfere with the child's agent
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env,
    });
    child.unref();

    // Gracefully shut down the current process
    this._abort.abort();
  }

  private _saveRestartNotify(info: { chatId: string; gatewayKind: string }): void {
    const dir = dirname(RESTART_NOTIFY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(RESTART_NOTIFY_PATH, JSON.stringify(info));
    log.info(`Restart notify saved: ${RESTART_NOTIFY_PATH}`);
  }

  private async _sendStartupNotification(dispatcher: Dispatcher): Promise<void> {
    if (!existsSync(RESTART_NOTIFY_PATH)) return;

    let info: { chatId: string; gatewayKind: string };
    try {
      info = JSON.parse(readFileSync(RESTART_NOTIFY_PATH, 'utf-8'));
      unlinkSync(RESTART_NOTIFY_PATH);
      log.info(`Restart notify: gateway=${info.gatewayKind} chatId=${info.chatId}`);
    } catch (err) {
      log.warn(`Failed to read restart notification: ${err}`);
      if (existsSync(RESTART_NOTIFY_PATH)) unlinkSync(RESTART_NOTIFY_PATH);
      return;
    }

    const response = { text: 'NeoClaw restarted successfully!' };
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await dispatcher.sendTo(info.gatewayKind, info.chatId, response);
        log.info(`Startup notification delivered to ${info.gatewayKind}:${info.chatId}`);
        return;
      } catch (err) {
        log.warn(`Startup notification attempt ${attempt}/${maxAttempts} failed: ${err}`);
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    log.error('Startup notification failed after all attempts.');
  }
}
