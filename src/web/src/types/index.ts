/**
 * Frontend type definitions
 */

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  timestamp: number;
  isStreaming?: boolean;
  stats?: MessageStats;
}

export interface MessageStats {
  model?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

// WebSocket message types
export interface ClientMessage {
  type: 'message' | 'command';
  sessionId: string;
  content: string;
}

export interface ServerMessage {
  type: 'response' | 'stream_start' | 'stream_delta' | 'stream_end' | 'error' | 'sessions_update';
  sessionId: string;
  data: unknown;
}

export interface StreamEvent {
  type: 'thinking_delta' | 'text_delta' | 'done';
  text?: string;
  response?: {
    text?: string;
    model?: string;
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}
