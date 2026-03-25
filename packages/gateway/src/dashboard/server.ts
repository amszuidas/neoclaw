/**
 * HTTP/WebSocket Server for Dashboard Gateway
 *
 * Provides an HTTP server with WebSocket support for the dashboard gateway.
 */

import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentStreamEvent, RunResponse } from '@neoclaw/core';
import { logger } from '@neoclaw/core/utils/logger';
import type { MessageHandlers, ServerMessage } from './types.js';

const log = logger('dashboard-server');

export interface ServerConfig {
  /** CORS enabled */
  cors?: boolean;
  /** Message handlers */
  onMessage: MessageHandlers['onMessage'];
  /** Disconnect handler */
  onDisconnect: MessageHandlers['onDisconnect'];
  /** Called when a new WebSocket connects, allows gateway to register the connection */
  onConnect?: (sessionId: string, ws: WebSocket, connectionId: string) => void;
  /** Called to update the session ID for an existing connection */
  onSessionChange?: (
    oldSessionId: string | null,
    newSessionId: string,
    ws: WebSocket,
    connectionId: string
  ) => void;
}

export interface DashboardServer {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
}

/**
 * Create HTTP and WebSocket servers
 */
export async function createServer(port: number, config: ServerConfig): Promise<DashboardServer> {
  const httpServer = createHttpServer((req, res) => {
    // Set CORS headers
    if (config.cors !== false) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', gateway: 'local' }));
      return;
    }

    // 404 for other endpoints
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Create WebSocket server
  const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' });

  wsServer.on('connection', (ws: WebSocket) => {
    // Track WebSocket connection - each message can have a different sessionId
    let currentSessionId: string | null = null;
    const wsClientId = Math.random().toString(36).slice(2);
    log.info(`WebSocket client connected (ws_${wsClientId})`);

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'register') {
          // Session registration - register the session but don't process any message
          const newSessionId = message.sessionId;

          log.debug(`Registering session: ${newSessionId}, connection: ws_${wsClientId}`);

          // Always call onConnect/update to ensure the WebSocket is registered for this session
          if (config.onConnect) {
            config.onConnect(newSessionId, ws, wsClientId);
          }

          // Handle session change
          if (currentSessionId !== newSessionId) {
            if (config.onSessionChange && currentSessionId !== null) {
              config.onSessionChange(currentSessionId, newSessionId, ws, wsClientId);
            }
            currentSessionId = newSessionId;
            log.info(`Session registered for ws_${wsClientId}: ${currentSessionId}`);
          }
        } else if (message.type === 'message') {
          const newSessionId = message.sessionId;

          log.debug(
            `Received message for session: ${newSessionId}, previous session: ${currentSessionId}, connection: ws_${wsClientId}`
          );

          // Always call onConnect/update to ensure the WebSocket is registered for this session
          // This handles both new connections and session switches
          if (config.onConnect) {
            config.onConnect(newSessionId, ws, wsClientId);
          }

          // Handle session change (when user switches sessions in the UI)
          if (currentSessionId !== newSessionId) {
            if (config.onSessionChange && currentSessionId !== null) {
              config.onSessionChange(currentSessionId, newSessionId, ws, wsClientId);
            }
            currentSessionId = newSessionId;
            log.info(`Session switched for ws_${wsClientId}: ${currentSessionId}`);
          }

          await config.onMessage(
            message.sessionId,
            message.content,
            (response: RunResponse) => {
              // Non-streaming response
              sendToClient(ws, {
                type: 'response',
                sessionId: message.sessionId,
                data: response,
              } as ServerMessage);
            },
            async (stream: AsyncIterable<AgentStreamEvent>) => {
              // Streaming response
              sendToClient(ws, {
                type: 'stream_start',
                sessionId: message.sessionId,
                data: {},
              } as ServerMessage);

              for await (const event of stream) {
                sendToClient(ws, {
                  type: 'stream_delta',
                  sessionId: message.sessionId,
                  data: event,
                } as ServerMessage);
              }

              sendToClient(ws, {
                type: 'stream_end',
                sessionId: message.sessionId,
                data: {},
              } as ServerMessage);
            }
          );
        }
      } catch (error) {
        log.error('Error handling WebSocket message:', error);
        sendToClient(ws, {
          type: 'error',
          sessionId: currentSessionId || 'unknown',
          data: { message: 'Failed to process message' },
        } as ServerMessage);
      }
    });

    ws.on('close', () => {
      if (currentSessionId) {
        log.info(`WebSocket client disconnected: ${currentSessionId}`);
        config.onDisconnect(currentSessionId);
      }
    });

    ws.on('error', (error) => {
      log.error(`WebSocket error${currentSessionId ? ` for ${currentSessionId}` : ''}:`, error);
    });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => resolve());
    httpServer.on('error', reject);
  });

  log.info(`HTTP server listening on port ${port}`);
  log.info(`WebSocket server ready at ws://localhost:${port}/ws`);

  return { httpServer, wsServer };
}

/**
 * Send a message to a WebSocket client
 */
function sendToClient(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
