/**
 * Gateway interface and shared message types.
 *
 * A Gateway is a messaging platform adapter. It listens for inbound messages
 * and provides a reply function to send responses back to the originating
 * conversation. Protocol-level concerns (formatting, reactions, dedup) live
 * inside the Gateway implementation, not in the Dispatcher.
 */

import type { AgentStreamEvent, Attachment, RunResponse } from './agent.js';

// ── Inbound message ───────────────────────────────────────────

export interface InboundMessage {
  /** Original text extracted from the platform payload before gateway decoration. */
  rawText?: string;
  /** Platform-specific unique message ID (for deduplication). */
  id: string;
  /** Text content of the message. */
  text: string;
  /** Chat room / conversation identifier. */
  chatId: string;
  /**
   * For threaded conversations, the root message ID.
   * The Dispatcher uses this to create an isolated session for the thread.
   */
  threadRootId?: string;
  /** Author's platform user ID. */
  authorId?: string;
  /** Author's display name (best-effort). */
  authorName?: string;
  /** Gateway kind that produced this message (matches Gateway.kind). */
  gatewayKind: string;
  /** Binary attachments (images, files, etc.). */
  attachments?: Attachment[];
  /** Platform-specific metadata. */
  meta?: Record<string, unknown>;
  /** Chat type: 'private' for direct messages, 'group' for group chats. */
  chatType?: 'private' | 'group';
}

export type BuiltinSlashCommand = 'clear' | 'new' | 'status' | 'restart' | 'help' | 'model';

const BUILTIN_SLASH_COMMAND_SET = new Set<BuiltinSlashCommand>([
  'clear',
  'new',
  'status',
  'restart',
  'help',
  'model',
]);

/**
 * Parse and normalize built-in slash commands from user input.
 *
 * Compatibility behavior:
 * - accepts canonical slash form, e.g. "/status"
 * - accepts bare "status" (legacy compatibility) and normalizes it to "/status"
 */
export function parseBuiltinSlashCommand(input: string): {
  command: BuiltinSlashCommand;
  normalizedText: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const slashMatch = trimmed.match(/^\/([a-z]+)(?:\s+(.+))?$/i);
  if (slashMatch) {
    const name = slashMatch[1]?.toLowerCase() as BuiltinSlashCommand | undefined;
    if (!name || !BUILTIN_SLASH_COMMAND_SET.has(name)) return null;
    const arg = slashMatch[2]?.trim();
    return { command: name, normalizedText: arg ? `/${name} ${arg}` : `/${name}` };
  }

  if (/^status$/i.test(trimmed)) {
    return { command: 'status', normalizedText: '/status' };
  }

  return null;
}

// ── Reply / Handler ───────────────────────────────────────────

/**
 * Sends a response back to the conversation this message came from.
 * Created by the Gateway with protocol context already bound
 * (chatId, replyToMessageId, etc.).
 */
export type ReplyFn = (response: RunResponse) => Promise<void>;

/**
 * Streaming variant of ReplyFn: receives an async iterable of agent stream
 * events and renders them progressively (e.g. via a Feishu streaming card).
 * The gateway creates this with protocol context already bound.
 */
export type StreamHandler = (stream: AsyncIterable<AgentStreamEvent>) => Promise<void>;

/**
 * Called by the Gateway for each inbound message.
 * The handler owns dispatching the message and must call reply() (or streamHandler
 * when provided) with the result.
 */
export type MessageHandler = (
  msg: InboundMessage,
  reply: ReplyFn,
  streamHandler?: StreamHandler
) => Promise<void>;

// ── Gateway interface ─────────────────────────────────────────

export interface Gateway {
  /**
   * Short identifier for this gateway type (e.g. "feishu").
   * Must be stable across restarts.
   */
  readonly kind: string;

  /**
   * Start listening for messages. Resolves only after the gateway stops.
   * The handler is called for each inbound message.
   */
  start(handler: MessageHandler): Promise<void>;

  /** Gracefully stop listening. */
  stop(): Promise<void>;

  /**
   * Proactively send a message to a chat (e.g. restart notifications).
   * Unlike reply(), this is not tied to an inbound message.
   */
  send(chatId: string, response: RunResponse): Promise<void>;
}
