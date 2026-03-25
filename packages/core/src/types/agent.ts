/**
 * Agent interface and shared types.
 *
 * An Agent is an AI backend that processes messages and returns responses.
 */

// ── Request / Response ────────────────────────────────────────

/** A binary attachment (image, file, etc.) carried through the message pipeline. */
export interface Attachment {
  /** Raw binary content. */
  buffer: Buffer;
  /**
   * Media category inferred from the source platform
   * (e.g. 'image', 'file', 'audio', 'video', 'sticker').
   */
  mediaType: string;
  /** Original file name, if available. */
  fileName?: string;
}

export interface RunRequest {
  /** User message text. */
  text: string;
  /**
   * Stable identifier for the conversation (e.g. chatId or chatId_thread_threadId).
   * Used to route messages to the correct process in the agent pool.
   */
  conversationId: string;
  /** The originating chat room ID (from InboundMessage). */
  chatId: string;
  /** The originating gateway kind (from InboundMessage). */
  gatewayKind: string;
  /** Binary attachments (images, files, etc.) from the originating message. */
  attachments?: Attachment[];
  /** Opaque metadata passed through from the channel. */
  extra?: Record<string, unknown>;
}

/** Outbound image payload to send via the gateway (base64-encoded binary). */
export interface OutboundImage {
  /** Base64-encoded image bytes. Data URL prefix is also accepted. */
  base64: string;
  /** Optional MIME type hint (e.g. image/png). */
  mimeType?: string;
  /** Optional filename used during upload. */
  fileName?: string;
}

export interface RunResponse {
  text: string;
  thinking?: string | null;
  sessionId?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  elapsedMs?: number | null;
  model?: string | null;
  /** Optional outbound images for the gateway to send as real media messages. */
  outboundImages?: OutboundImage[];
}

// ── Streaming event types ─────────────────────────────────────

/** A single question item from Claude Code's AskUserQuestion tool. */
export type AskQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

/** Events emitted by Agent.stream() during incremental response generation. */
export type AgentStreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'text_delta'; text: string }
  /** Emitted when Claude Code uses AskUserQuestion and the gateway should render an interactive form. */
  | { type: 'ask_questions'; questions: AskQuestion[]; conversationId: string }
  | { type: 'done'; response: RunResponse };

// ── Agent interface ───────────────────────────────────────────

export interface Agent {
  /**
   * Short identifier for this agent type (e.g. "claude_code").
   * Used for registration and logging.
   */
  readonly kind: string;

  /** Process a message and return a complete response. */
  run(request: RunRequest): Promise<RunResponse>;

  /**
   * Stream a response incrementally, yielding deltas as they arrive.
   * Implementations should yield thinking_delta and text_delta events,
   * followed by a single done event containing the full RunResponse.
   */
  stream?(request: RunRequest): AsyncGenerator<AgentStreamEvent>;

  /** Returns true if the agent binary / service is reachable. */
  healthCheck(): Promise<boolean>;

  /** Clear the conversation context for a given conversationId. */
  clearConversation(conversationId: string): Promise<void>;

  /** Shut down all background processes managed by this agent. */
  dispose(): Promise<void>;
}
