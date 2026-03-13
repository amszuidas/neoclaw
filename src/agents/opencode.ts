import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './types.js';

const log = logger('opencode');

type OpencodeAgentOptions = {
  model?: string;
  systemPrompt?: string;
  /** Workspaces directory path */
  cwd?: string | null;
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
        model: this._parseModel(this._options.model),
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
                model: this._options.model ?? null,
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

    // Create directory if it doesn't exist
    if (!existsSync(conversationDir)) {
      mkdirSync(conversationDir, { recursive: true });
      // TODO: Prepare config files for opencode mcp and skills
    }

    return conversationDir;
  }

  /**
   * Parses a model string into the { providerID, modelID } format required by OpenCode.
   * Only "providerID/modelID" format is supported (e.g. "anthropic/claude-sonnet-4-6").
   * Throws if the string does not contain '/'.
   */
  private _parseModel(model?: string): { providerID: string; modelID: string } | undefined {
    if (!model) return undefined;
    const slash = model.indexOf('/');
    if (slash === -1) {
      throw new Error(
        `Invalid model format: "${model}". Expected "providerID/modelID" (e.g. "anthropic/claude-sonnet-4-6")`
      );
    }
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
}
