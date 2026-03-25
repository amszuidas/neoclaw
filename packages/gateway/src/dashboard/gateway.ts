/**
 * DashboardGateway - Web-based messaging gateway
 *
 * Provides a dashboard web interface for interacting with NeoClaw
 * via WebSocket connections. Supports streaming responses.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { AgentStreamEvent, RunResponse } from '@neoclaw/core';
import type { DashboardConfig } from '@neoclaw/core/config';
import { logger } from '@neoclaw/core/utils/logger';
import type {
  Gateway,
  InboundMessage,
  MessageHandler,
  ReplyFn,
  StreamHandler,
} from '@neoclaw/core/types/gateway';
import { createServer } from './server.js';
import { SessionManager } from './session-manager.js';

const log = logger('dashboard-gateway');

// Get the web directory path (src/web relative to project root)
const CURRENT_DIR = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(CURRENT_DIR, '../../web');

export class DashboardGateway implements Gateway {
  readonly kind = 'dashboard';

  private _stopped = false;
  private _handler: MessageHandler | null = null;
  private _httpServer: HttpServer | null = null;
  private _wsServer: WebSocketServer | null = null;
  private _sessionManager: SessionManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _clients: Map<string, any> = new Map(); // sessionId -> WebSocket
  private _frontendProcess: ReturnType<typeof spawn> | null = null;

  constructor(private readonly _config: DashboardConfig) {
    this._sessionManager = new SessionManager();
  }

  async start(handler: MessageHandler): Promise<void> {
    this._handler = handler;

    const port = this._config.port ?? 3000;

    // Check if web directory exists
    const webDirExists = existsSync(WEB_DIR);
    if (!webDirExists) {
      log.warn('Web directory not found, frontend will not be available');
    } else {
      // Check if node_modules exists
      const nodeModulesExists = existsSync(join(WEB_DIR, 'node_modules'));
      if (!nodeModulesExists) {
        log.info('Frontend dependencies not installed, installing...');
        await this._installFrontendDeps();
      }

      // Start frontend dev server
      await this._startFrontendDevServer();
    }

    // Create HTTP and WebSocket servers
    const { httpServer, wsServer } = await createServer(port, {
      cors: this._config.cors ?? true,
      onMessage: this._handleClientMessage.bind(this),
      onDisconnect: this._handleClientDisconnect.bind(this),
      onConnect: this._handleClientConnect.bind(this),
      onSessionChange: this._handleSessionChange.bind(this),
    });

    this._httpServer = httpServer;

    // Store wsServer reference for send() method
    this._wsServer = wsServer;

    log.info(`Dashboard gateway started on http://localhost:${port}`);
    log.info(`WebSocket endpoint: ws://localhost:${port}/ws`);

    // start() must remain resolved until stop() is called
    return new Promise<void>(() => {});
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._handler = null;

    // Kill frontend dev server
    if (this._frontendProcess) {
      log.info('Stopping frontend dev server...');
      this._frontendProcess.kill('SIGTERM');
      this._frontendProcess = null;
    }

    if (this._httpServer) {
      await new Promise<void>((resolve) => {
        this._httpServer!.close(() => resolve());
      });
    }

    log.info('Dashboard gateway stopped');
  }

  async send(chatId: string, response: RunResponse): Promise<void> {
    // Proactively send a message to a chat (e.g. restart notifications)
    // Find the WebSocket client for this chatId and send the message
    const ws = this._clients.get(chatId);
    if (ws && ws.readyState === 1) {
      // OPEN
      ws.send(
        JSON.stringify({
          type: 'response',
          sessionId: chatId,
          data: response,
        })
      );
    }
  }

  /**
   * Handle incoming message from client
   */
  private async _handleClientMessage(
    sessionId: string,
    text: string,
    replyFn: (response: RunResponse) => void,
    streamFn: (stream: AsyncIterable<AgentStreamEvent>) => void
  ): Promise<void> {
    if (!this._handler) return;

    log.info(
      `[handleMessage] Processing message for session: ${sessionId}, text: "${text.slice(0, 50)}..."`
    );

    // Update or create session
    this._sessionManager.createOrUpdate(sessionId, text);

    const msg: InboundMessage = {
      id: `dashboard_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text,
      chatId: sessionId,
      authorId: 'dashboard_user',
      gatewayKind: this.kind,
      attachments: [],
    };

    log.debug(
      `[handleMessage] Created InboundMessage with chatId: ${msg.chatId}, conversationKey will be: ${msg.chatId}`
    );

    const reply: ReplyFn = async (response) => {
      replyFn(response);
    };

    const streamHandler: StreamHandler = async (stream) => {
      streamFn(stream);
    };

    await this._handler(msg, reply, streamHandler);
  }

  /**
   * Handle client disconnect
   */
  private _handleClientDisconnect(sessionId: string): void {
    this._sessionManager.disconnect(sessionId);
    this._clients.delete(sessionId);
  }

  /**
   * Handle new client connection or session re-registration
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _handleClientConnect(sessionId: string, ws: any, connectionId: string): void {
    log.info(`[onConnect] Registering WebSocket (conn_${connectionId}) for session: ${sessionId}`);

    // Clean up any existing WebSocket for this session (replace with new connection)
    const existingWs = this._clients.get(sessionId);
    if (existingWs && existingWs !== ws && existingWs.readyState === 1) {
      log.debug(`[onConnect] Closing old WebSocket for session: ${sessionId}`);
      existingWs.close();
    }

    this._clients.set(sessionId, ws);
  }

  /**
   * Handle session change (when user switches sessions in the UI)
   */
  private _handleSessionChange(
    oldSessionId: string | null,
    newSessionId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws: any,
    connectionId: string
  ): void {
    log.info(
      `[onSessionChange] Session change (conn_${connectionId}): ${oldSessionId} -> ${newSessionId}`
    );

    // Remove old session mapping
    if (oldSessionId) {
      this._clients.delete(oldSessionId);
      log.debug(`[onSessionChange] Removed mapping for old session: ${oldSessionId}`);
    }

    // Add new session mapping
    this._clients.set(newSessionId, ws);
    log.debug(`[onSessionChange] Added mapping for new session: ${newSessionId}`);
    log.debug(`[onSessionChange] Current clients map size: ${this._clients.size}`);
  }

  /**
   * Install frontend dependencies
   */
  private async _installFrontendDeps(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log.info('Installing frontend dependencies with npm...');
      const npm = spawn('npm', ['install', '--legacy-peer-deps'], {
        cwd: WEB_DIR,
        stdio: 'inherit',
        shell: true,
      });

      npm.on('close', (code) => {
        if (code === 0) {
          log.info('Frontend dependencies installed successfully');
          resolve();
        } else {
          log.warn(`npm install exited with code ${code}`);
          reject(new Error(`npm install failed with code ${code}`));
        }
      });

      npm.on('error', (err) => {
        log.error('Failed to start npm install:', err);
        reject(err);
      });
    });
  }

  /**
   * Start frontend dev server
   */
  private async _startFrontendDevServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log.info('Starting frontend dev server...');

      // Try npm first, fallback to bun
      const command =
        process.env.BUN_INSTALL?.endsWith('bun') || existsSync(join(WEB_DIR, 'package.json'))
          ? 'npm'
          : 'bun';

      const args = command === 'npm' ? ['run', 'dev'] : ['run', 'dev'];

      this._frontendProcess = spawn(command, args, {
        cwd: WEB_DIR,
        stdio: 'pipe',
        shell: true,
      });

      this._frontendProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        // Log frontend output only if it contains useful info
        if (output.includes('Local:') || output.includes('ready')) {
          log.info(`Frontend: ${output.trim()}`);
        }
      });

      this._frontendProcess.stderr?.on('data', (data) => {
        log.error(`Frontend error: ${data.toString()}`);
      });

      this._frontendProcess.on('error', (err) => {
        log.error('Failed to start frontend dev server:', err);
        reject(err);
      });

      // Give it a moment to start
      setTimeout(() => {
        if (this._frontendProcess && !this._frontendProcess.killed) {
          log.info('Frontend dev server started');
          resolve();
        } else {
          reject(new Error('Frontend dev server failed to start'));
        }
      }, 2000);
    });
  }
}
