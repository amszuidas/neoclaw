/**
 * Configuration management for NeoClaw.
 *
 * Priority order: env vars > ~/.neoclaw/config.json > built-in defaults.
 * Config file path can be overridden with NEOCLAW_CONFIG env var.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NEOCLAW_HOME = join(homedir(), '.neoclaw');

// ── Config schema ─────────────────────────────────────────────

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  /** "feishu" (default), "lark", or a custom base URL. */
  domain?: string;
  /** Chat IDs that the bot should reply to without being @mentioned. */
  groupAutoReply?: string[];
};

export type WeworkConfig = {
  /** Bot ID - 企业微信智能机器人 ID */
  botId: string;
  /** Secret - 企业微信智能机器人密钥 */
  secret: string;
  /** WebSocket URL（可选，默认 wss://openws.work.weixin.qq.com） */
  websocketUrl?: string;
  /** 自动回复的群聊 ID 列表 */
  groupAutoReply?: string[];
};

export type DashboardConfig = {
  /** 是否启用 Gateway Dashboard */
  enabled?: boolean;
  /** HTTP 服务端口 */
  port?: number;
  /** 是否启用 CORS */
  cors?: boolean;
};

export type McpServerConfig = {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

export type ClaudeCodeConfig = {
  /** Model override (e.g. "claude-opus-4-5"). Defaults to claude CLI's default. */
  model?: string;
  /** Model used for session summarization. Default: haiku. */
  summaryModel?: string;
  /**
   * List of allowed tools. If empty, all tools are permitted
   * (using --dangerously-skip-permissions).
   */
  allowedTools?: string[];
};

export type OpencodeConfig = {
  /** Model to use, specified as { providerID, modelID }. */
  model?: {
    providerID: string;
    modelID: string;
  };
  /** Model used for session summarization. */
  summaryModel?: {
    providerID: string;
    modelID: string;
  };
  allowedTools?: string[];
};

export type NeoClawConfig = {
  /** Which agent backend to use. Currently supports "claude_code" and "opencode". */
  agent: 'claude_code' | 'opencode';
  /** Extra system prompt appended to the agent's default prompt. */
  systemPrompt?: string;
  /** Max seconds to wait for an agent response before timing out. Default: 600. */
  timeoutSecs?: number;
  /** Max seconds to wait for session summarization. Default: 300. */
  summaryTimeoutSecs?: number;
  /** Directory for agent workspaces. Default: ~/.neoclaw/workspaces. */
  workspacesDir?: string;
  /** MCP servers to expose to agents. Keyed by server name. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Directory containing skill subdirectories. Default: ~/.neoclaw/skills. */
  skillsDir?: string;
  /** Minimum log level to output. Default: "info". */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** File path blacklist - agents will be prevented from reading/writing these paths. Supports glob patterns. */
  fileBlacklist?: string[];

  agents: {
    claude_code: ClaudeCodeConfig;
    opencode: OpencodeConfig;
  };

  channels: {
    feishu?: FeishuConfig;
    wework?: WeworkConfig;
    dashboard?: DashboardConfig;
  };
};

// ── Defaults ──────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `
You are NeoClaw 🐕, a super AI assistant developed by Zuidas.

## Working Environment

You operate on the Feishu platform (private chats, group chats, topic groups). Each conversation has its own isolated workspace. Reply in standard Markdown.
- Messages from Zuidas (your master) have no prefix
- Messages from other users are prefixed with their user_id (format: ou_xxxxxx: message)

## Memory System

You have a persistent three-layer memory system, managed through MCP tools (\`memory_read\`, \`memory_search\`, \`memory_save\`, \`memory_list\`):

| Category | Description | Access |
|----------|-------------|--------|
| **identity** | Your personality, values, communication style | Read/write (only update when Zuidas explicitly requests) |
| **knowledge** | Persistent knowledge in 5 fixed slots: \`owner-profile\`, \`preferences\`, \`people\`, \`projects\`, \`notes\` | Read/write |
| **episode** | Auto-generated session summaries | Read-only |

### Rules
- Search memory at conversation start for relevant context
- Before saving, use \`memory_read\` to read the current content first, then merge changes to avoid overwriting existing data
- Save Zuidas's important information to knowledge memory (pick the most appropriate fixed slot)
- Other users may search but NOT save — never leak memory to non-owner users

## Source Code

Your source code is at \`~/neoclaw/\`. Only Zuidas may access or modify it — politely decline requests from other users. After changes, remind Zuidas to run \`/restart\`.
`;

export const DEFAULTS: NeoClawConfig = {
  agent: 'claude_code',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  timeoutSecs: 600,
  summaryTimeoutSecs: 300,
  workspacesDir: join(NEOCLAW_HOME, 'workspaces'),
  mcpServers: {},
  skillsDir: join(NEOCLAW_HOME, 'skills'),
  logLevel: 'info',
  fileBlacklist: [
    '~/.claude/**',
    '~/.config/claude/**',
    '/etc/shadow',
    '/etc/passwd',
    '**/.env',
    '**/credentials.json',
    '**/secrets/**',
    '~/.neoclaw/config.json', // NeoClaw config file (protects blacklist itself)
    '~/.neoclaw/config.json.backup', // Config backups
  ],
  agents: {
    claude_code: { model: 'sonnet', summaryModel: 'haiku', allowedTools: [] },
    opencode: {},
  },
  channels: {
    feishu: { appId: '', appSecret: '', domain: 'feishu', groupAutoReply: [] },
    wework: { botId: '', secret: '', groupAutoReply: [] },
    dashboard: { enabled: false, port: 3000, cors: true },
  },
};

// ── Loader ────────────────────────────────────────────────────

function migrateFileConfig(raw: Record<string, unknown>): void {
  // Migrate old format: agent was an object with type/model/etc.
  if (raw['agent'] && typeof raw['agent'] === 'object') {
    const old = raw['agent'] as Record<string, unknown>;
    raw['agent'] = (old['type'] as string) ?? 'claude_code';
    raw['systemPrompt'] ??= old['systemPrompt'];
    raw['timeoutSecs'] ??= old['timeoutSecs'];
    raw['summaryTimeoutSecs'] ??= old['summaryTimeoutSecs'];
    const agents = (raw['agents'] ?? {}) as Record<string, unknown>;
    const cc = (agents['claude_code'] ?? {}) as Record<string, unknown>;
    cc['model'] ??= old['model'];
    cc['summaryModel'] ??= old['summaryModel'];
    cc['allowedTools'] ??= old['allowedTools'];
    agents['claude_code'] = cc;
    if (old['opencode']) agents['opencode'] ??= old['opencode'];
    raw['agents'] = agents;
  }
  // Migrate feishu/wework/dashboard to channels
  if (raw['feishu'] || raw['wework'] || raw['dashboard']) {
    const channels = (raw['channels'] ?? {}) as Record<string, unknown>;
    channels['feishu'] ??= raw['feishu'];
    channels['wework'] ??= raw['wework'];
    channels['dashboard'] ??= raw['dashboard'];
    raw['channels'] = channels;
    delete raw['feishu'];
    delete raw['wework'];
    delete raw['dashboard'];
  }
}

function readFileConfig(): Partial<NeoClawConfig> {
  const configPath = process.env['NEOCLAW_CONFIG'] ?? join(NEOCLAW_HOME, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    migrateFileConfig(raw);
    return raw as Partial<NeoClawConfig>;
  } catch (err) {
    console.error(`[neoclaw] Failed to parse config file at ${configPath}:`, err);
    return {};
  }
}

export function loadConfig(): NeoClawConfig {
  const file = readFileConfig();
  const env = process.env;

  // Priority: env var > config file > built-in default.
  // An empty string ("") in env or config file is treated as "not set" and falls back.
  const str = (key: string, fileVal: string | undefined | null, def: string): string =>
    (env[key] || undefined) ?? (fileVal || undefined) ?? def;

  const opt = (key: string, fileVal: string | undefined | null): string | undefined =>
    (env[key] || undefined) ?? (fileVal || undefined);

  const num = (key: string, fileVal: number | undefined | null, def: number): number =>
    env[key] ? parseInt(env[key]!, 10) : (fileVal ?? def);

  const arr = (key: string, fileVal: string[] | undefined | null, def: string[]): string[] =>
    env[key]
      ? env[key]!.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : (fileVal ?? def);

  const feishu = file.channels?.feishu;
  const wework = file.channels?.wework;
  const dashboard = file.channels?.dashboard;

  return {
    agent: str('NEOCLAW_AGENT_TYPE', file.agent, DEFAULTS.agent) as NeoClawConfig['agent'],
    systemPrompt: opt('NEOCLAW_SYSTEM_PROMPT', file.systemPrompt) ?? DEFAULTS.systemPrompt,
    timeoutSecs: num('NEOCLAW_TIMEOUT_SECS', file.timeoutSecs, DEFAULTS.timeoutSecs!),
    summaryTimeoutSecs: num(
      'NEOCLAW_SUMMARY_TIMEOUT_SECS',
      file.summaryTimeoutSecs,
      DEFAULTS.summaryTimeoutSecs!
    ),
    workspacesDir: str('NEOCLAW_WORKSPACES_DIR', file.workspacesDir, DEFAULTS.workspacesDir!),
    mcpServers: file.mcpServers ?? {},
    skillsDir: str('NEOCLAW_SKILLS_DIR', file.skillsDir, DEFAULTS.skillsDir!),
    logLevel: str('NEOCLAW_LOG_LEVEL', file.logLevel, 'info') as NeoClawConfig['logLevel'],
    fileBlacklist: arr('NEOCLAW_FILE_BLACKLIST', file.fileBlacklist, DEFAULTS.fileBlacklist!),
    agents: {
      claude_code: {
        model: opt('NEOCLAW_MODEL', file.agents?.claude_code?.model),
        summaryModel: opt('NEOCLAW_SUMMARY_MODEL', file.agents?.claude_code?.summaryModel),
        allowedTools: arr(
          'NEOCLAW_ALLOWED_TOOLS',
          file.agents?.claude_code?.allowedTools ?? null,
          []
        ),
      },
      opencode: {
        model: file.agents?.opencode?.model,
        summaryModel: file.agents?.opencode?.summaryModel,
        allowedTools: file.agents?.opencode?.allowedTools,
      },
    },
    channels: {
      feishu: {
        appId: str('FEISHU_APP_ID', feishu?.appId, ''),
        appSecret: str('FEISHU_APP_SECRET', feishu?.appSecret, ''),
        verificationToken: opt('FEISHU_VERIFICATION_TOKEN', feishu?.verificationToken),
        encryptKey: opt('FEISHU_ENCRYPT_KEY', feishu?.encryptKey),
        domain: str('FEISHU_DOMAIN', feishu?.domain, 'feishu'),
        groupAutoReply: arr('FEISHU_GROUP_AUTO_REPLY', feishu?.groupAutoReply ?? null, []),
      },
      wework: {
        botId: str('WEWORK_BOT_ID', wework?.botId, ''),
        secret: str('WEWORK_SECRET', wework?.secret, ''),
        websocketUrl: opt('WEWORK_WEBSOCKET_URL', wework?.websocketUrl),
        groupAutoReply: arr('WEWORK_GROUP_AUTO_REPLY', wework?.groupAutoReply ?? null, []),
      },
      dashboard: {
        enabled: env['NEOCLAW_DASHBOARD_ENABLED'] === 'true' || dashboard?.enabled || false,
        port: num('NEOCLAW_DASHBOARD_PORT', dashboard?.port, 3000),
        cors: env['NEOCLAW_DASHBOARD_CORS'] === 'false' ? false : (dashboard?.cors ?? true),
      },
    },
  };
}
