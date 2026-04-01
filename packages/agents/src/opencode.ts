import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '@neoclaw/core/utils/logger';
import type { McpServerConfig } from '@neoclaw/core/config';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from '@neoclaw/core';
import { WorkspaceManager, WriteMcpConfig } from './workspace-manager.js';

const log = logger('opencode');
const MODEL_OVERRIDE_FILENAME = 'model-override.json';

type OpencodeModel = {
  providerID: string;
  modelID: string;
};

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

const writeMcpConfig: WriteMcpConfig = (cwd, servers) => {
  const mcp: Record<string, unknown> = {};
  // Convert McpServerConfig to opencode's mcp format:
  // - "stdio" → type "local", command array = [command, ...args], environment = env
  // - "http"/"sse" → type "remote", url, headers
  for (const [name, cfg] of Object.entries(servers)) {
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
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ mcp }, null, 2));
  log.info(`Wrote opencode.json to ${cwd}`);
};

export class OpencodeAgent implements Agent {
  readonly kind = 'opencode';

  private _client: OpencodeClient | null = null;

  private _server: { url: string; close: () => void } | null = null;

  /**
   * conversationId → sessionId mapping
   */
  private _sessions = new Map<string, string>();
  private _modelOverrides = new Map<string, OpencodeModel>();

  private _workspace: WorkspaceManager;

  constructor(private _options: OpencodeAgentOptions = {}) {
    this._workspace = new WorkspaceManager(
      {
        workspacesDir: this._options.cwd,
        mcpServers: this._options.mcpServers,
        skillsDir: this._options.skillsDir,
      },
      {
        writeMcpConfig,
        agentSkillsDir: '.opencode/skills',
      }
    );
  }

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
    const workspaceDir = this._workspace.prepareWorkspace(request.conversationId);
    const sessionId = await this._getSession(request.conversationId, workspaceDir);
    const activeModel = this._resolveModelForConversation(request.conversationId);

    // Subscribe to events BEFORE sending prompt to avoid missing early events
    const events = await client.event.subscribe({ query: { directory: workspaceDir } });

    log.info(
      `Prompt with dir: ${workspaceDir}, model: ${
        activeModel ? `${activeModel.providerID}/${activeModel.modelID}` : 'default'
      }, text: ${request.text}`
    );

    // Send prompt asynchronously (returns immediately)
    const promptResult = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: request.text }],
        model: activeModel,
        system: this._options.systemPrompt,
      },
      query: {
        directory: workspaceDir,
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
    this._sessions.delete(conversationId);
    if (!sessionId || !this._client) return;
    try {
      await this._client.session.delete({ path: { id: sessionId } });
    } catch (err) {
      log.warn(`Failed to delete opencode session ${sessionId}:`, err);
    }
  }

  listModels(conversationId: string): string[] {
    const models = new Set<string>();
    const current = this.getModel(conversationId);
    if (current) models.add(current);
    if (this._options.model) {
      models.add(`${this._options.model.providerID}/${this._options.model.modelID}`);
    }
    return [...models];
  }

  getModel(conversationId: string): string | null {
    const model = this._resolveModelForConversation(conversationId);
    if (!model) return null;
    return `${model.providerID}/${model.modelID}`;
  }

  setModel(conversationId: string, model: string): boolean {
    const parsed = parseModelString(model);
    if (!parsed) {
      log.warn(`Invalid model format: ${model}, expected providerID/modelID`);
      return false;
    }

    this._modelOverrides.set(conversationId, parsed);
    try {
      writeModelOverride(this._modelOverridePath(conversationId), parsed);
      log.info(`Model override saved for ${conversationId}: ${model}`);
      return true;
    } catch (err) {
      log.warn(`Failed to persist model override for ${conversationId}: ${err}`);
      return false;
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

  private _resolveModelForConversation(conversationId: string): OpencodeModel | undefined {
    const cached = this._modelOverrides.get(conversationId);
    if (cached) return cached;

    const persisted = readModelOverride(this._modelOverridePath(conversationId));
    if (persisted) {
      this._modelOverrides.set(conversationId, persisted);
      return persisted;
    }

    return this._options.model;
  }

  private _modelOverridePath(conversationId: string): string {
    const workspaceDir = this._workspace.prepareWorkspace(conversationId) ?? process.cwd();
    const metaDir = join(workspaceDir, '.neoclaw');
    if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
    return join(metaDir, MODEL_OVERRIDE_FILENAME);
  }
}

function parseModelString(model: string): OpencodeModel | null {
  const trimmed = model.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const providerID = parts[0];
  const modelID = parts[1];
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function readModelOverride(path: string): OpencodeModel | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<OpencodeModel>;
    if (
      typeof parsed.providerID !== 'string' ||
      parsed.providerID.trim().length === 0 ||
      typeof parsed.modelID !== 'string' ||
      parsed.modelID.trim().length === 0
    ) {
      return undefined;
    }
    return {
      providerID: parsed.providerID.trim(),
      modelID: parsed.modelID.trim(),
    };
  } catch {
    return undefined;
  }
}

function writeModelOverride(path: string, model: OpencodeModel): void {
  writeFileSync(path, JSON.stringify(model, null, 2), 'utf-8');
}
