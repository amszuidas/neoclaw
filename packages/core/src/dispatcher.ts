/**
 * Dispatcher — routes inbound messages to the active Agent.
 *
 * Responsibilities:
 * - Register Gateways and Agents
 * - Start/stop all gateways
 * - Serialize per-conversation message handling (prevent race conditions)
 * - Manage conversation sessions (stable session IDs for multi-turn context)
 * - Handle built-in slash commands (/clear, /status, /restart, /help, /model)
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './types/agent.js';
import {
  Gateway,
  InboundMessage,
  MessageHandler,
  parseBuiltinSlashCommand,
  ReplyFn,
  StreamHandler,
} from './types/gateway.js';
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
  private _pendingModelSelection = new Set<string>();

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
      const commandInput = this._normalizePendingModelSelection(msg.rawText ?? msg.text, key);
      const command = parseBuiltinSlashCommand(commandInput);
      if (command) {
        log.info(`Executing command: ${command.command}`);
        const commandMsg: InboundMessage = {
          ...msg,
          rawText: commandInput,
          text: command.normalizedText,
        };
        const response = await this._execCommand(command.command, commandMsg, key);
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
          extra: {
            chatType: msg.chatType,
          },
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

  private _normalizePendingModelSelection(text: string, conversationKey: string): string {
    const trimmed = text.trim();
    const builtin = parseBuiltinSlashCommand(trimmed);
    if (builtin?.command === 'model') return builtin.normalizedText;
    if (!this._pendingModelSelection.has(conversationKey)) return text;

    if (/^\d+$/.test(trimmed) || /^[a-z0-9._:/-]+$/i.test(trimmed)) {
      this._pendingModelSelection.delete(conversationKey);
      return `/model ${trimmed}`;
    }

    this._pendingModelSelection.delete(conversationKey);
    return text;
  }

  private async _execCommand(
    name: 'clear' | 'new' | 'status' | 'restart' | 'help' | 'model',
    msg: InboundMessage,
    key: string
  ): Promise<RunResponse> {
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
          '- `/model` — Show or switch model',
          '- `/help` — Show this help message',
        ];
        return { text: lines.join('\n') };
      }

      case 'model': {
        const agent = this._getAgent();
        const currentModel = (await agent.getModel?.(key)) ?? 'default';
        const availableModels = [...new Set((await agent.listModels?.(key)) ?? [])].sort((a, b) =>
          a.localeCompare(b)
        );
        const args = msg.text.trim().split(/\s+/).slice(1);

        if (args.length === 0) {
          if (!agent.setModel) {
            return { text: 'Current agent does not support model switching.' };
          }

          this._pendingModelSelection.add(key);
          const lines = ['**Available Models**', `(Current: ${currentModel})`, ''];
          if (availableModels.length > 0) {
            availableModels.forEach((model, index) => lines.push(`${index + 1}. ${model}`));
          } else {
            lines.push('No discovered model list is available for this agent.');
          }
          lines.push('', 'Reply with a number or model name to switch model.');
          return { text: lines.join('\n') };
        }

        this._pendingModelSelection.delete(key);
        if (!agent.setModel) {
          return { text: 'Current agent does not support model switching.' };
        }

        const rawArg = args.join(' ').trim();
        let selectedModel: string | undefined;

        const numericIndex = Number.parseInt(rawArg, 10);
        if (Number.isInteger(numericIndex)) {
          if (availableModels.length === 0) {
            this._pendingModelSelection.add(key);
            return {
              text: 'No discovered model list is available for this agent. Reply with a model name to switch model.',
            };
          }
          if (numericIndex >= 1 && numericIndex <= availableModels.length) {
            selectedModel = availableModels[numericIndex - 1];
          } else {
            this._pendingModelSelection.add(key);
            return {
              text: `Invalid selection. Please reply with a number (1-${availableModels.length}) or a model name.`,
            };
          }
        } else {
          const exactMatches = availableModels.filter((model) => model.toLowerCase() === rawArg.toLowerCase());
          if (exactMatches.length === 1) {
            selectedModel = exactMatches[0];
          } else {
            const partialMatches = availableModels.filter((model) =>
              model.toLowerCase().includes(rawArg.toLowerCase())
            );
            if (partialMatches.length === 1) {
              selectedModel = partialMatches[0];
            } else if (partialMatches.length > 1) {
              this._pendingModelSelection.add(key);
              const lines = ['Ambiguous model name, please choose one:'];
              partialMatches.forEach((model, index) => lines.push(`${index + 1}. ${model}`));
              return { text: lines.join('\n') };
            }
          }
        }

        if (!selectedModel) {
          selectedModel = rawArg;
        }

        const success = await agent.setModel(key, selectedModel);
        if (!success) {
          this._pendingModelSelection.add(key);
          return { text: `Failed to switch model to: ${selectedModel}` };
        }

        await agent.clearConversation(key);
        return {
          text: `Model switched to: **${selectedModel}**\n\nStarted a fresh session for this conversation so the new model takes effect.`,
        };
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
