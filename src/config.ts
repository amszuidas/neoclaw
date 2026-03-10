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

export interface AgentConfig {
  /** Which agent backend to use. Currently only "claude_code" is supported. */
  type: string;
  /** Model override (e.g. "claude-opus-4-5"). Defaults to claude CLI's default. */
  model?: string;
  /** Model used for session summarization. Default: ANTHROPIC_SMALL_FAST_MODEL or haiku. */
  summaryModel?: string;
  /** Extra system prompt appended to the agent's default prompt. */
  systemPrompt?: string;
  /**
   * List of allowed tools for the agent. If empty, all tools are permitted
   * (using --dangerously-skip-permissions).
   */
  allowedTools?: string[];
  /** Max seconds to wait for an agent response before timing out. Default: 300. */
  timeoutSecs?: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  /** "feishu" (default), "lark", or a custom base URL. */
  domain?: string;
  /** Chat IDs that the bot should reply to without being @mentioned. */
  groupAutoReply?: string[];
}

export interface WeworkConfig {
  /** Bot ID - 企业微信智能机器人 ID */
  botId: string;
  /** Secret - 企业微信智能机器人密钥 */
  secret: string;
  /** WebSocket URL（可选，默认 wss://openws.work.weixin.qq.com） */
  websocketUrl?: string;
  /** 自动回复的群聊 ID 列表 */
  groupAutoReply?: string[];
}

export interface McpServerConfig {
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface NeoClawConfig {
  agent: AgentConfig;
  feishu: FeishuConfig;
  /** 企业微信配置（可选） */
  wework?: WeworkConfig;
  /** MCP servers to expose to agents. Keyed by server name. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Directory for agent workspaces. Default: ~/.neoclaw/workspaces. */
  workspacesDir?: string;
  /** Directory containing skill subdirectories. Default: ~/.neoclaw/skills. */
  skillsDir?: string;
  /** Minimum log level to output. Default: "info". */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

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
  agent: {
    type: 'claude_code',
    model: 'sonnet',
    summaryModel: 'haiku',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    allowedTools: [],
    timeoutSecs: 600,
  },
  feishu: {
    appId: '',
    appSecret: '',
    verificationToken: '',
    encryptKey: '',
    domain: 'feishu',
    groupAutoReply: [],
  },
  wework: {
    botId: '',
    secret: '',
    groupAutoReply: [],
  },
  mcpServers: {},
  skillsDir: join(NEOCLAW_HOME, 'skills'),
  workspacesDir: join(NEOCLAW_HOME, 'workspaces'),
  logLevel: 'info',
};

// ── Loader ────────────────────────────────────────────────────

function readFileConfig(): Partial<NeoClawConfig> {
  const configPath = process.env['NEOCLAW_CONFIG'] ?? join(NEOCLAW_HOME, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<NeoClawConfig>;
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

  return {
    agent: {
      type: str('NEOCLAW_AGENT_TYPE', file.agent?.type, DEFAULTS.agent.type),
      model: opt('NEOCLAW_MODEL', file.agent?.model),
      summaryModel: opt('NEOCLAW_SUMMARY_MODEL', file.agent?.summaryModel),
      systemPrompt:
        opt('NEOCLAW_SYSTEM_PROMPT', file.agent?.systemPrompt) ?? DEFAULTS.agent.systemPrompt,
      allowedTools: arr('NEOCLAW_ALLOWED_TOOLS', file.agent?.allowedTools, []),
      timeoutSecs: num('NEOCLAW_TIMEOUT_SECS', file.agent?.timeoutSecs, 600),
    },
    feishu: {
      appId: str('FEISHU_APP_ID', file.feishu?.appId, ''),
      appSecret: str('FEISHU_APP_SECRET', file.feishu?.appSecret, ''),
      verificationToken: opt('FEISHU_VERIFICATION_TOKEN', file.feishu?.verificationToken),
      encryptKey: opt('FEISHU_ENCRYPT_KEY', file.feishu?.encryptKey),
      domain: str('FEISHU_DOMAIN', file.feishu?.domain, 'feishu'),
      groupAutoReply: arr('FEISHU_GROUP_AUTO_REPLY', file.feishu?.groupAutoReply, []),
    },
    wework: {
      botId: str('WEWORK_BOT_ID', file.wework?.botId, ''),
      secret: str('WEWORK_SECRET', file.wework?.secret, ''),
      websocketUrl: opt('WEWORK_WEBSOCKET_URL', file.wework?.websocketUrl),
      groupAutoReply: arr('WEWORK_GROUP_AUTO_REPLY', file.wework?.groupAutoReply, []),
    },
    mcpServers: file.mcpServers ?? {},
    workspacesDir: str(
      'NEOCLAW_WORKSPACES_DIR',
      file.workspacesDir,
      join(NEOCLAW_HOME, 'workspaces')
    ),
    skillsDir: str('NEOCLAW_SKILLS_DIR', file.skillsDir, join(NEOCLAW_HOME, 'skills')),
    logLevel: str('NEOCLAW_LOG_LEVEL', file.logLevel, 'info') as NeoClawConfig['logLevel'],
  };
}
