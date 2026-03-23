import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NeoClawConfigSchema, type NeoClawConfig } from './schemas';
import { readEnv } from './env';
import { DeepPartial } from './utils';
import { DEFAULT_SYSTEM_PROMPT } from '../promts/default';
import { merge, mergeWith } from 'es-toolkit';

export const NEOCLAW_HOME = join(homedir(), '.neoclaw');

/**
 * File path blacklist - agents will be prevented from reading/writing these paths. Supports glob patterns.
 */
const defaultFileBlackList = [
  '~/.claude/**',
  '~/.config/claude/**',
  '/etc/shadow',
  '/etc/passwd',
  '**/.env',
  '**/credentials.json',
  '**/secrets/**',
  '~/.neoclaw/config.json',
  '~/.neoclaw/config.json.backup',
];

export const DEFAULT_CONFIG: NeoClawConfig = {
  agent: 'claude_code',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  timeoutSecs: 600,
  summaryTimeoutSecs: 300,
  workspacesDir: join(NEOCLAW_HOME, 'workspaces'),
  mcpServers: {},
  skillsDir: join(NEOCLAW_HOME, 'skills'),
  logLevel: 'info',
  fileBlacklist: [...defaultFileBlackList],
  agents: {
    claude_code: {
      model: 'sonnet',
      allowedTools: [],
    },
    opencode: {},
  },
  channels: {
    feishu: {
      appId: '',
      appSecret: '',
      domain: 'feishu',
      groupAutoReply: [],
    },
    wework: {
      botId: '',
      secret: '',
      groupAutoReply: [],
    },
    dashboard: {
      enabled: false,
      port: 3000,
      cors: true,
    },
  },
};

export function loadConfig(): NeoClawConfig {
  // Load config from `config.json`
  const path = readEnv('NEOCLAW_CONFIG') ?? join(NEOCLAW_HOME, 'config.json');
  const fileConfig = JSON.parse(readFileSync(path, 'utf-8')) as NeoClawConfig;

  // Build config from `process.env`
  const envConfig: DeepPartial<NeoClawConfig> = {
    agent: readEnv('NEOCLAW_AGENT_TYPE'),
    systemPrompt: readEnv('NEOCLAW_SYSTEM_PROMPT'),
    timeoutSecs: readEnv('NEOCLAW_TIMEOUT_SECS'),
    summaryTimeoutSecs: readEnv('NEOCLAW_SUMMARY_TIMEOUT_SECS'),
    workspacesDir: readEnv('NEOCLAW_WORKSPACES_DIR'),
    skillsDir: readEnv('NEOCLAW_SKILLS_DIR'),
    logLevel: readEnv('NEOCLAW_LOG_LEVEL'),
    fileBlacklist: readEnv('NEOCLAW_FILE_BLACKLIST'),

    agents: {
      claude_code: {
        model: readEnv('NEOCLAW_MODEL'),
        summaryModel: readEnv('NEOCLAW_SUMMARY_MODEL'),
        allowedTools: readEnv('NEOCLAW_ALLOWED_TOOLS'),
      },
    },
    channels: {
      feishu: {
        appId: readEnv('FEISHU_APP_ID'),
        appSecret: readEnv('FEISHU_APP_SECRET'),
        verificationToken: readEnv('FEISHU_VERIFICATION_TOKEN'),
        encryptKey: readEnv('FEISHU_ENCRYPT_KEY'),
        domain: readEnv('FEISHU_DOMAIN'),
        groupAutoReply: readEnv('FEISHU_GROUP_AUTO_REPLY'),
      },
      wework: {
        botId: readEnv('WEWORK_BOT_ID'),
        secret: readEnv('WEWORK_SECRET'),
        websocketUrl: readEnv('WEWORK_WEBSOCKET_URL'),
        groupAutoReply: readEnv('WEWORK_GROUP_AUTO_REPLY'),
      },
      dashboard: {
        enabled: readEnv('NEOCLAW_DASHBOARD_ENABLED'),
        port: readEnv('NEOCLAW_DASHBOARD_PORT'),
        cors: readEnv('NEOCLAW_DASHBOARD_CORS'),
      },
    },
  };

  // Priority: env > file > default
  // 先用用户配置和默认配置合并，用户配置覆盖默认配置
  const base = merge(DEFAULT_CONFIG, fileConfig);
  // 再和环境变量合并，环境变量（如果有）覆盖用户配置
  const merged = mergeWith(base, envConfig, (target, source) => {
    if (target === undefined) {
      return source;
    }
  });

  console.dir(merged, { depth: null, colors: true });

  return NeoClawConfigSchema.parse(merged);
}

let cache: NeoClawConfig | null = null;

export const Config = {
  get: () => {
    if (!cache) {
      cache = loadConfig();
    }
    return cache;
  },

  reset: () => {
    cache = null;
  },
};
