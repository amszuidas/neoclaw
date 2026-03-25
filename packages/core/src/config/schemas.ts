import { z } from 'zod';

export const AgentSchema = z.enum(['claude_code', 'opencode']);
export type AgentType = z.infer<typeof AgentSchema>;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const FeishuConfigSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  /** "feishu" (default), "lark", or a custom base URL. */
  domain: z.string().optional(),
  /** Chat IDs that the bot should reply to without being @mentioned. */
  groupAutoReply: z.array(z.string()).optional(),
});
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

export const WeworkConfigSchema = z.object({
  /** Bot ID - 企业微信智能机器人 ID */
  botId: z.string(),
  /** Secret - 企业微信智能机器人密钥 */
  secret: z.string(),
  /** WebSocket URL（可选，默认 wss://openws.work.weixin.qq.com） */
  websocketUrl: z.string().optional(),
  /** 自动回复的群聊 ID 列表 */
  groupAutoReply: z.array(z.string()).optional(),
});
export type WeworkConfig = z.infer<typeof WeworkConfigSchema>;

export const DashboardConfigSchema = z.object({
  /** 是否启用 Gateway Dashboard */
  enabled: z.boolean().optional(),
  /** HTTP 服务端口 */
  port: z.number().int().min(0).max(65535).optional(),
  /** 是否启用 CORS */
  cors: z.boolean().optional(),
});
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;

export const McpServerConfigSchema = z.object({
  type: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const ClaudeCodeConfigSchema = z.object({
  /** Model override (e.g. "claude-opus-4-5"). Defaults to claude CLI's default. */
  model: z.string().optional(),
  /** Model used for session summarization. Default: haiku. */
  summaryModel: z.string().optional(),
  /**
   * List of allowed tools. If empty, all tools are permitted
   * (using --dangerously-skip-permissions).
   */
  allowedTools: z.array(z.string()).optional(),
});
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;

export const OpencodeModelSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});
export type OpencodeModelConfig = z.infer<typeof OpencodeModelSchema>;

export const OpencodeConfigSchema = z.object({
  /** Model to use, specified as { providerID, modelID }. */
  model: OpencodeModelSchema.optional(),
  /** Model used for session summarization. */
  summaryModel: OpencodeModelSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
});
export type OpencodeConfig = z.infer<typeof OpencodeConfigSchema>;

export const NeoClawConfigSchema = z.object({
  /** For json schema */
  $schema: z.string().optional(),
  /** Which agent backend to use. Currently supports "claude_code" and "opencode". */
  agent: AgentSchema,
  /** Extra system prompt appended to the agent's default prompt. */
  systemPrompt: z.string().optional(),
  /** Max seconds to wait for an agent response before timing out. Default: 600. */
  timeoutSecs: z.number().int().nonnegative().optional(),
  /** Max seconds to wait for session summarization. Default: 300. */
  summaryTimeoutSecs: z.number().int().nonnegative().optional(),
  /** Directory for agent workspaces. Default: ~/.neoclaw/workspaces. */
  workspacesDir: z.string().optional(),
  /** MCP servers to expose to agents. Keyed by server name. */
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  /** Directory containing skill subdirectories. Default: ~/.neoclaw/skills. */
  skillsDir: z.string().optional(),
  /** Minimum log level to output. Default: "info". */
  logLevel: LogLevelSchema.optional(),
  /** File path blacklist - agents will be prevented from reading/writing these paths. Supports glob patterns. */
  fileBlacklist: z.array(z.string()).optional(),
  agents: z.object({
    claude_code: ClaudeCodeConfigSchema.optional(),
    opencode: OpencodeConfigSchema.optional(),
  }),
  channels: z.object({
    feishu: FeishuConfigSchema.optional(),
    wework: WeworkConfigSchema.optional(),
    dashboard: DashboardConfigSchema.optional(),
  }),
});
export type NeoClawConfig = z.infer<typeof NeoClawConfigSchema>;

// const zWithJsonSchema = z as typeof z & {
//   toJSONSchema?: (schema: z.ZodTypeAny) => Record<string, unknown>;
// };

/**
 * JSON schema generated from Zod, used for editor intellisense on config.json.
 */
export const NeoClawConfigJsonSchema = z.toJSONSchema(NeoClawConfigSchema);

// export const partialNeoClawConfigSchema = z.object({
//   agent: agentSchema.optional(),
//   systemPrompt: z.string().optional(),
//   timeoutSecs: z.number().int().nonnegative().optional(),
//   summaryTimeoutSecs: z.number().int().nonnegative().optional(),
//   workspacesDir: z.string().optional(),
//   mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
//   skillsDir: z.string().optional(),
//   logLevel: logLevelSchema.optional(),
//   fileBlacklist: z.array(z.string()).optional(),
//   agents: z
//     .object({
//       claude_code: claudeCodeConfigSchema.partial().optional(),
//       opencode: opencodeConfigSchema.partial().optional(),
//     })
//     .partial()
//     .optional(),
//   channels: z
//     .object({
//       feishu: feishuConfigSchema.partial().optional(),
//       wework: weworkConfigSchema.partial().optional(),
//       dashboard: dashboardConfigSchema.partial().optional(),
//     })
//     .partial()
//     .optional(),
// });
// export type PartialNeoClawConfig = z.infer<typeof partialNeoClawConfigSchema>;
