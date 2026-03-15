import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk';
import { join } from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import type { McpServerConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './types.js';

const log = logger('opencode');

type OpencodeAgentOptions = {
  model?: {
    providerID: string;
    modelID: string;
  };
  systemPrompt?: string;
  /** Workspaces directory path */
  cwd?: string | null;
  /** MCP servers to expose to the agent (fallback if config file is unavailable) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Directory containing skill subdirectories (each with a SKILL.md) */
  skillsDir?: string;
};

export class OpencodeAgent implements Agent {
  readonly kind = 'opencode';

  private _client: OpencodeClient | null = null;

  private _server: { url: string; close: () => void } | null = null;

  /**
   * conversationId → sessionId mapping
   */
  private _sessions = new Map<string, string>();

  constructor(private _options: OpencodeAgentOptions = {}) {}

  async run(request: RunRequest): Promise<RunResponse> {
    let response: RunResponse = { text: '' };
    for await (const event of this.stream(request)) {
      if (event.type === 'done') response = event.response;
    }
    return response;
  }

  async *stream(request: RunRequest): AsyncGenerator<AgentStreamEvent> {
    const t0 = Date.now();
    const client = await this._getClient();
    const conversationDir = this._getConversationDir(request.conversationId);
    const sessionId = await this._getSession(request.conversationId, conversationDir);

    // Subscribe to events BEFORE sending prompt to avoid missing early events
    const events = await client.event.subscribe({ query: { directory: conversationDir } });

    // Send prompt asynchronously (returns immediately)
    const promptResult = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: request.text }],
        model: this._options.model,
        system: this._options.systemPrompt,
      },
      query: {
        directory: conversationDir,
      },
    });
    if (promptResult.error) {
      throw new Error(`Failed to send prompt: ${JSON.stringify(promptResult.error)}`);
    }

    const textByPart = new Map<string, string>();
    const thinkingByPart = new Map<string, string>();
    const assistantMessageIds = new Set<string>();
    let costUsd: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let model: string | null = null;

    for await (const event of events.stream) {
      switch (event.type) {
        case 'message.part.updated': {
          const { part, delta } = event.properties;
          switch (part.type) {
            case 'text':
              if (assistantMessageIds.has(part.messageID) && !part.synthetic && !part.ignored) {
                textByPart.set(part.id, part.text);
              }
              if (delta) {
                yield { type: 'text_delta', text: delta };
              }
              break;
            case 'reasoning':
              thinkingByPart.set(part.id, part.text);
              if (delta) yield { type: 'thinking_delta', text: delta };
              break;
            case 'tool':
              yield { type: 'tool_use', name: part.tool, input: part.state.input };
              break;
          }
          break;
        }
        case 'message.updated': {
          const { info: msg } = event.properties;
          if (msg.role === 'assistant') {
            assistantMessageIds.add(msg.id);
            costUsd = msg.cost;
            inputTokens = msg.tokens.input;
            outputTokens = msg.tokens.output;
            model = msg.modelID;
          }
          break;
        }
        case 'session.idle': {
          if (event.properties.sessionID === sessionId) {
            yield {
              type: 'done',
              response: {
                text: Array.from(textByPart.values()).join(''),
                thinking: Array.from(thinkingByPart.values()).join(''),
                sessionId: sessionId,
                costUsd,
                inputTokens,
                outputTokens,
                elapsedMs: Date.now() - t0,
                model,
              },
            };
          }
          return;
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['opencode', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    const sessionId = this._sessions.get(conversationId);
    if (!sessionId || !this._client) return;
    this._sessions.delete(conversationId);
    try {
      await this._client.session.delete({ path: { id: sessionId } });
    } catch (err) {
      log.warn(`Failed to delete opencode session ${sessionId}:`, err);
    }
  }

  async dispose(): Promise<void> {
    this._server?.close();
    log.info('Opencode agent disposed');
  }

  // --- Internals ───────────────────────────────────────────

  private async _getClient(): Promise<OpencodeClient> {
    if (this._client) return this._client;

    const { client, server } = await createOpencode();
    this._client = client;
    this._server = server;
    log.info(`Opencode server started at ${server.url}`);
    return client;
  }

  private async _getSession(
    conversationId: string,
    conversationDir: string | undefined
  ): Promise<string> {
    if (this._sessions.has(conversationId)) {
      return this._sessions.get(conversationId)!;
    }

    // Create new session for conversation
    const client = await this._getClient();
    const sessionResult = await client.session.list({ query: { directory: conversationDir } });
    // Session history is sorted by updated time descending, so the first item is the most recently updated session
    const sessionHistory =
      sessionResult.data?.toSorted((a, b) => b.time.updated - a.time.updated) ?? [];

    let sessionId = sessionHistory.length > 0 ? sessionHistory[0]!.id : undefined;
    // Create a new session if there is no existing one
    if (!sessionId) {
      const createResult = await client.session.create({
        query: { directory: conversationDir },
      });
      if (createResult.error || !createResult.data) {
        throw new Error(`Failed to create opencode session: ${JSON.stringify(createResult.error)}`);
      }
      sessionId = createResult.data.id;
    }

    // Persist sessionId in memory for quick lookup, avoiding the need to query session list on every message
    this._sessions.set(conversationId, sessionId);

    log.debug(`Created session ${sessionId} for conversation ${conversationId}`);
    return sessionId;
  }

  private _getConversationDir(conversationId: string): string | undefined {
    if (!this._options.cwd) return;

    // Sanitize conversationId for use as a directory name (replace ':' with '_')
    const dirName = conversationId.replace(/:/g, '_');
    const conversationDir = join(this._options.cwd, dirName);

    mkdirSync(conversationDir, { recursive: true });
    this._prepareWorkspace(conversationDir);

    return conversationDir;
  }

  private _prepareWorkspace(cwd: string): void {
    this._syncMcpServers(cwd);
    this._syncSkills(cwd);
  }

  /** Sync skill symlinks into .opencode/skills/: create new, update changed, remove stale. */
  private _syncSkills(cwd: string): void {
    const skillsDir = this._options.skillsDir;
    if (!skillsDir || !existsSync(skillsDir)) return;

    const destSkillsDir = join(cwd, '.opencode', 'skills');
    mkdirSync(destSkillsDir, { recursive: true });

    let srcEntries: string[];
    try {
      srcEntries = readdirSync(skillsDir);
    } catch {
      return;
    }

    const validSkills = new Set<string>();
    for (const name of srcEntries) {
      const srcSkill = join(skillsDir, name);
      try {
        if (!lstatSync(srcSkill).isDirectory()) continue;
        if (!existsSync(join(srcSkill, 'SKILL.md'))) continue;
      } catch {
        continue;
      }
      validSkills.add(name);

      const destLink = join(destSkillsDir, name);
      try {
        if (lstatSync(destLink).isSymbolicLink()) {
          if (readlinkSync(destLink) === srcSkill) continue; // already correct
          unlinkSync(destLink); // target changed, re-create
        } else {
          continue; // real dir/file exists, don't overwrite
        }
      } catch {
        // destLink doesn't exist — will create below
      }

      try {
        symlinkSync(srcSkill, destLink);
        log.info(`Linked skill "${name}" → ${destLink}`);
      } catch (err) {
        log.warn(`Failed to symlink skill "${name}": ${err}`);
      }
    }

    // Remove stale symlinks that no longer correspond to a valid skill
    let destEntries: string[];
    try {
      destEntries = readdirSync(destSkillsDir);
    } catch {
      return;
    }
    for (const name of destEntries) {
      if (validSkills.has(name)) continue;
      const destLink = join(destSkillsDir, name);
      try {
        if (!lstatSync(destLink).isSymbolicLink()) continue;
        unlinkSync(destLink);
        log.info(`Removed stale skill symlink "${name}" from ${destSkillsDir}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private _syncMcpServers(cwd: string): void {
    let mcpServers: Record<string, McpServerConfig> | undefined;
    try {
      const freshConfig = loadConfig();
      mcpServers = freshConfig.mcpServers;
    } catch {
      mcpServers = this._options.mcpServers;
    }

    // Inject built-in memory MCP server
    const memoryDir = join(homedir(), '.neoclaw', 'memory');
    const mcpServerScript = join(import.meta.dir, '..', 'memory', 'mcp-server.ts');
    const allServers: Record<string, McpServerConfig> = {
      ...mcpServers,
      'neoclaw-memory': {
        type: 'stdio',
        command: 'bun',
        args: ['run', mcpServerScript],
        env: { NEOCLAW_MEMORY_DIR: memoryDir },
      },
    };

    // Convert McpServerConfig to opencode's mcp format:
    // - "stdio" → type "local", command array = [command, ...args], environment = env
    // - "http"/"sse" → type "remote", url, headers
    const mcp: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(allServers)) {
      if (cfg.type === 'stdio') {
        mcp[name] = {
          type: 'local',
          command: [cfg.command!, ...(cfg.args ?? [])],
          ...(cfg.env ? { environment: cfg.env } : {}),
        };
      } else {
        mcp[name] = {
          type: 'remote',
          url: cfg.url!,
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        };
      }
    }

    const configPath = join(cwd, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({ mcp }, null, 2));
    log.info(`Wrote opencode.json to ${cwd}`);
  }
}
