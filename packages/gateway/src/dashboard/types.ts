/**
 * Types for Dashboard Gateway communication
 */

import type { AgentStreamEvent, RunResponse } from '@neoclaw/core';

/**
 * Messages sent from the client (frontend) to the server
 */
export interface ClientMessage {
  type: 'message' | 'command';
  sessionId: string;
  content: string;
}

/**
 * Messages sent from the server (backend) to the client
 */
export interface ServerMessage {
  type: 'response' | 'stream_start' | 'stream_delta' | 'stream_end' | 'error' | 'sessions_update';
  sessionId: string;
  data: ServerMessageData;
}

export type ServerMessageData =
  | RunResponse // For 'response' type
  | AgentStreamEvent // For 'stream_delta' type
  | Record<string, never> // For 'stream_start', 'stream_end' (empty object)
  | { message: string } // For 'error' type
  | { sessions: Session[] }; // For 'sessions_update' type

/**
 * Session information shared with the client
 */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Message handlers for WebSocket server
 */
export interface MessageHandlers {
  onMessage: (
    sessionId: string,
    text: string,
    replyFn: (response: RunResponse) => void,
    streamFn: (stream: AsyncIterable<AgentStreamEvent>) => void
  ) => Promise<void>;
  onDisconnect: (sessionId: string) => void;
}
