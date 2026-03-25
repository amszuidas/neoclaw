import { z } from 'zod';
import { AgentSchema, LogLevelSchema } from './schemas';

const intSchema = z.coerce.number().int().nonnegative();
const csvArraySchema = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const ENV_SCHEMAS = {
  NEOCLAW_CONFIG: z.string().nonempty(),
  NEOCLAW_AGENT_TYPE: AgentSchema,
  /** Append extra instructions to the default system prompt. */
  NEOCLAW_SYSTEM_PROMPT: z.string().nonempty(),
  /** Max seconds to wait for an agent response. */
  NEOCLAW_TIMEOUT_SECS: intSchema,
  /** Max seconds to wait for session summarization. */
  NEOCLAW_SUMMARY_TIMEOUT_SECS: z.coerce.number().int().nonnegative(),
  /** Directory used to store agent workspaces. */
  NEOCLAW_WORKSPACES_DIR: z.string().nonempty(),
  /** Directory used to discover installed skills. */
  NEOCLAW_SKILLS_DIR: z.string().nonempty(),
  /** Minimum log level to emit. */
  NEOCLAW_LOG_LEVEL: LogLevelSchema,
  /** Comma-separated file path blacklist entries. */
  NEOCLAW_FILE_BLACKLIST: csvArraySchema,
  /** Override the primary Claude Code model. */
  NEOCLAW_MODEL: z.string().nonempty(),
  /** Override the Claude Code summarization model. */
  NEOCLAW_SUMMARY_MODEL: z.string().nonempty(),
  /** Comma-separated list of allowed Claude Code tools. */
  NEOCLAW_ALLOWED_TOOLS: csvArraySchema,
  /** Enable or disable the dashboard. */
  NEOCLAW_DASHBOARD_ENABLED: z.coerce.boolean(),
  /** Dashboard HTTP port. */
  NEOCLAW_DASHBOARD_PORT: intSchema,
  /** Enable or disable dashboard CORS. */
  NEOCLAW_DASHBOARD_CORS: z.coerce.boolean(),
  /** Feishu/Lark app ID. */
  FEISHU_APP_ID: z.string().nonempty(),
  /** Feishu/Lark app secret. */
  FEISHU_APP_SECRET: z.string().nonempty(),
  /** Feishu/Lark verification token. */
  FEISHU_VERIFICATION_TOKEN: z.string().nonempty(),
  /** Feishu/Lark encrypt key. */
  FEISHU_ENCRYPT_KEY: z.string().nonempty(),
  /** Feishu/Lark domain preset or custom base URL. */
  FEISHU_DOMAIN: z.string().nonempty(),
  /** Comma-separated Feishu group IDs for auto reply. */
  FEISHU_GROUP_AUTO_REPLY: csvArraySchema,
  /** WeWork bot ID. */
  WEWORK_BOT_ID: z.string().nonempty(),
  /** WeWork bot secret. */
  WEWORK_SECRET: z.string().nonempty(),
  /** WeWork websocket endpoint override. */
  WEWORK_WEBSOCKET_URL: z.string().nonempty(),
  /** Comma-separated WeWork group IDs for auto reply. */
  WEWORK_GROUP_AUTO_REPLY: csvArraySchema,
};

type EnvSchemaMap = typeof ENV_SCHEMAS;
type EnvKey = keyof typeof ENV_SCHEMAS;

/**
 * Preserve the value type for each literal env name so callers get parsed types
 * directly from readEnv('...').
 */
export function readEnv<K extends EnvKey>(key: K): z.output<EnvSchemaMap[K]> | undefined {
  // return readers[key]();
  const schema = ENV_SCHEMAS[key];

  const parsed = schema.safeParse(process.env[key]);

  if (parsed.success) {
    return parsed.data as z.output<EnvSchemaMap[K]>;
  }

  // console.warn(
  //   `[neoclaw] Ignoring invalid environment variable ${key}: ${formatZodError(parsed.error)}`
  // );
  return undefined;
}
