/**
 * Dispatcher — routes inbound messages to the active Agent.
 *
 * Responsibilities:
 * - Register Gateways and Agents
 * - Start/stop all gateways
 * - Serialize per-conversation message handling (prevent race conditions)
 * - Manage conversation sessions (stable session IDs for multi-turn context)
 * - Handle built-in slash commands (/clear, /status, /restart, /help)
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './agents/types.js';
import type {
  Gateway,
  InboundMessage,
  MessageHandler,
  ReplyFn,
  StreamHandler,
} from './gateway/types.js';
import type { MemoryManager } from './memory/manager.js';
import { logger } from './utils/logger.js';
import { Mutex } from './utils/mutex.js';

const log = logger('dispatcher');

// ── Dispatcher ────────────────────────────────────────────────

/** Callback invoked when the /restart command is received. */
export type RestartCallback = (info: { chatId: string; gatewayKind: string }) => void;

export class Dispatcher {
  private _agents = new Map<string, Agent>();
  private _defaultAgentKind = 'claude_code';
  private _gateways: Gateway[] = [];
  /** Per-conversation serial queues to prevent concurrent handling. */
  private _queues = new Map<string, Mutex>();
  private _workspacesDir: string | null = null;
  private _memoryManager: MemoryManager | null = null;
  private _onRestart: RestartCallback | null = null;

  // ── Registration ──────────────────────────────────────────

  addAgent(agent: Agent): void {
    this._agents.set(agent.kind, agent);
    log.info(`Agent registered: "${agent.kind}"`);
  }

  addGateway(gateway: Gateway): void {
    this._gateways.push(gateway);
    log.info(`Gateway registered: "${gateway.kind}"`);
  }

  setDefaultAgent(kind: string): void {
    this._defaultAgentKind = kind;
    log.info(`Default agent set: "${kind}"`);
  }

  setWorkspacesDir(dir: string): void {
    this._workspacesDir = dir;
    log.info(`Workspaces base set: "${dir}"`);
  }

  /** Inject memory manager for session summarization on /clear and /new. */
  setMemoryManager(mgr: MemoryManager): void {
    this._memoryManager = mgr;
    log.info('Memory manager set');
  }

  /** Register a callback for when the /restart command is received. */
  onRestart(cb: RestartCallback): void {
    this._onRestart = cb;
    log.info('Restart callback set');
  }

  // ── Handler (passed to gateways) ──────────────────────────

  readonly handle: MessageHandler = async (
    msg: InboundMessage,
    reply: ReplyFn,
    streamHandler?: StreamHandler
  ): Promise<void> => {
    const key = this._conversationKey(msg);
    log.info(`Handling message for conversation key: ${key}`);

    const queue = this._getQueue(key);
    await queue.acquire();

    try {
      let responseText = '';

      // Slash commands are always non-streaming
      const command = this._tryParseCommand(msg.text);
      if (command) {
        log.info(`Executing command: ${command}`);
        const response = await this._execCommand(command, msg, key);
        responseText = response.text;
        await reply(response);
      } else {
        const agent = this._getAgent();
        const request: RunRequest = {
          text: msg.text,
          conversationId: key,
          chatId: msg.chatId,
          gatewayKind: msg.gatewayKind,
          attachments: msg.attachments,
        };

        if (streamHandler && agent.stream) {
          // Streaming path: gateway renders content progressively
          const agentStream = agent.stream(request);
          async function* tracked(): AsyncGenerator<AgentStreamEvent> {
            for await (const event of agentStream) {
              if (event.type === 'done') responseText = event.response.text;
              yield event;
            }
          }
          await streamHandler(tracked());
        } else {
          // Non-streaming fallback
          const response = await agent.run(request);
          responseText = response.text;
          await reply(response);
        }
      }

      log.info(`Response text: "${responseText}"`);
      this._appendHistory(key, 'user', msg.text);
      this._appendHistory(key, 'neoclaw', responseText);
    } finally {
      queue.release();
    }
  };

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._agents.size === 0) throw new Error('No agents registered');
    if (this._gateways.length === 0) throw new Error('No gateways registered');

    await Promise.all(this._gateways.map((gw) => gw.start(this.handle)));
  }

  async stop(): Promise<void> {
    for (const gw of this._gateways) {
      await gw.stop().catch((e) => log.warn(`Gateway "${gw.kind}" stop error: ${e}`));
    }
    for (const agent of this._agents.values()) {
      await agent.dispose().catch((e) => log.warn(`Agent "${agent.kind}" dispose error: ${e}`));
    }
  }

  /** Proactively send a message to a gateway (e.g. restart notifications). */
  async sendTo(gatewayKind: string, chatId: string, response: RunResponse): Promise<void> {
    const gateway = this._gateways.find((g) => g.kind === gatewayKind);
    if (!gateway) {
      log.warn(`sendTo: gateway "${gatewayKind}" not found`);
      return;
    }
    await gateway.send(chatId, response);
    log.info(
      `Message sent to gateway "${gatewayKind}" proactively, chatId="${chatId}" response="${response.text}"`
    );
  }

  // ── Internals ──────────────────────────────────────────────

  private _conversationKey(msg: InboundMessage): string {
    // Thread messages get an isolated session to avoid polluting the main chat context
    if (msg.threadRootId) return `${msg.chatId}_thread_${msg.threadRootId}`;
    return msg.chatId;
  }

  private _getQueue(key: string): Mutex {
    let q = this._queues.get(key);
    if (!q) {
      q = new Mutex();
      this._queues.set(key, q);
    }
    return q;
  }

  private _getAgent(): Agent {
    const agent = this._agents.get(this._defaultAgentKind);
    if (!agent) {
      const available = [...this._agents.keys()].join(', ');
      throw new Error(`Agent "${this._defaultAgentKind}" not registered. Available: ${available}`);
    }
    return agent;
  }

  // ── Built-in slash commands ──────────────────────────────

  private static readonly COMMANDS = new Set(['clear', 'new', 'status', 'restart', 'help']);

  private _tryParseCommand(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const end = trimmed.indexOf(' ');
    const name = (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)).toLowerCase();
    return Dispatcher.COMMANDS.has(name) ? name : null;
  }

  private async _execCommand(name: string, msg: InboundMessage, key: string): Promise<RunResponse> {
    const isThread = key !== msg.chatId;

    switch (name) {
      case 'clear':
      case 'new': {
        // Generate session summary before clearing (best-effort, non-blocking on failure)
        if (this._memoryManager && this._workspacesDir) {
          await this._memoryManager
            .summarizeSession(key, this._workspacesDir)
            .catch((err) => log.warn(`Failed to summarize session: ${err}`));
        }
        const agent = this._getAgent();
        await agent.clearConversation(key);
        return { text: 'Context cleared, ready for a new conversation.' };
      }

      case 'restart': {
        if (this._onRestart) {
          // Delay slightly so reply() is called before the restart fires
          setTimeout(
            () => this._onRestart!({ chatId: msg.chatId, gatewayKind: msg.gatewayKind }),
            5_000
          );
        }
        return { text: 'Restarting NeoClaw, please wait...' };
      }

      case 'status': {
        const agents = [...this._agents.keys()].join(', ');
        const gateways = this._gateways.map((g) => g.kind).join(', ');
        const lines = [
          '**NeoClaw Status**',
          `- Context: ${isThread ? 'Thread (isolated)' : 'Main chat'}`,
          `- Agents: ${agents}`,
          `- Gateways: ${gateways}`,
        ];
        return { text: lines.join('\n') };
      }

      case 'help': {
        const lines = [
          '**Available Commands**',
          '- `/clear` or `/new` — Start a fresh conversation',
          '- `/status` — Show current session and system info',
          '- `/restart` — Restart the NeoClaw daemon',
          '- `/help` — Show this help message',
        ];
        return { text: lines.join('\n') };
      }

      default:
        return { text: `Unknown command: /${name}` };
    }
  }

  // ── Conversation history ──────────────────────────────────

  private _appendHistory(conversationKey: string, role: 'user' | 'neoclaw', text: string): void {
    if (!this._workspacesDir) return;
    const sanitized = conversationKey.replace(/:/g, '_');
    const historyDir = join(this._workspacesDir, sanitized, '.neoclaw', '.history');
    try {
      if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      appendFileSync(join(historyDir, `${date}.txt`), `[${role}] ${text}\n\n`, 'utf-8');
    } catch (err) {
      log.warn(`Failed to write conversation history: ${err}`);
    }
  }
}
