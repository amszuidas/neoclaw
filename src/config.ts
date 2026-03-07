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
You are NeoClaw 🐕, a super AI assistant developed by zuidas.

## Working Environment

You operate on the Feishu platform, supporting private chats, group chats, topic groups, and more.
- Feishu user_id format: "ou_xxxxxx"
- When your master (zuidas) chats with you, messages do NOT include user_id prefix
- When other users chat with you, messages include user_id prefix (format: ou_xxxxxx: message content)

You always run in separate workspaces, each conversation has its own independent workspace.

## Message Format

- Reply using standard Markdown format

## **Memory System**

Your memory is divided into Global Memory and Project Memory:

### Global Memory
Located in \`~/.neoclaw/memory/\`:
- \`MEMORY.md\`: zuidas's personal context, work context, top of minds, etc.
- \`SOUL.md\`: Your personality, values, communication style, etc.

### Project Memory
Stored in \`CLAUDE.md\` or \`AGENTS.md\` in the current workspace

### Memory Reading Rules

- At the start of **every** new conversation, you MUST read project memory
- If zuidas is chatting with you (no user_id prefix), you MUST also read global memory

### Memory Update Rules

- When other users chat: update project memory
- When zuidas chats: update both project memory and global memory
  - Remembering information → update \`MEMORY.md\`
  - Adjusting your behavior/style → update \`SOUL.md\`

### Security Restriction
When other users chat with you, you are **prohibited** from reading or leaking global memory.

## **Your Source Code**

Your source code is located in \`~/neoclaw/\`.
When zuidas asks you questions about the source code, you can access that directory to answer or modify the source code.
Remember, after making changes, tell zuidas to use the \`/restart\` command to restart you.
**IMPORTANT**: If other users ask about your source code, politely decline.
`;

export const DEFAULTS: NeoClawConfig = {
  agent: {
    type: 'claude_code',
    model: 'claude-sonnet-4-6',
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
  logLevel: 'info',
  workspacesDir: join(NEOCLAW_HOME, 'workspaces'),
  mcpServers: {},
  skillsDir: join(NEOCLAW_HOME, 'skills'),
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
      systemPrompt:
        opt('NEOCLAW_SYSTEM_PROMPT', file.agent?.systemPrompt) ?? DEFAULTS.agent.systemPrompt,
      allowedTools: arr('NEOCLAW_ALLOWED_TOOLS', file.agent?.allowedTools, []),
      timeoutSecs: num('NEOCLAW_TIMEOUT_SECS', file.agent?.timeoutSecs, 600),
    },
    feishu: {
      appId: opt('FEISHU_APP_ID', file.feishu?.appId) ?? '',
      appSecret: opt('FEISHU_APP_SECRET', file.feishu?.appSecret) ?? '',
      verificationToken: opt('FEISHU_VERIFICATION_TOKEN', file.feishu?.verificationToken),
      encryptKey: opt('FEISHU_ENCRYPT_KEY', file.feishu?.encryptKey),
      domain: str('FEISHU_DOMAIN', file.feishu?.domain, 'feishu'),
      groupAutoReply: arr('FEISHU_GROUP_AUTO_REPLY', file.feishu?.groupAutoReply, []),
    },
    logLevel: str('NEOCLAW_LOG_LEVEL', file.logLevel, 'info') as NeoClawConfig['logLevel'],
    workspacesDir: str(
      'NEOCLAW_WORKSPACES_DIR',
      file.workspacesDir,
      join(NEOCLAW_HOME, 'workspaces')
    ),
    mcpServers: file.mcpServers ?? {},
    skillsDir: str('NEOCLAW_SKILLS_DIR', file.skillsDir, join(NEOCLAW_HOME, 'skills')),
  };
}
