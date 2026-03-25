/**
 * WeCom WebSocket Client
 *
 * 企业微信智能机器人长连接客户端。
 * 连接到 wss://openws.work.weixin.qq.com
 *
 * 协议参考：
 * - 握手后发送 aibot_subscribe 进行鉴权
 * - 入站消息：aibot_msg_callback / aibot_event_callback
 * - 出站消息：aibot_respond_msg
 * - 心跳：每 30 秒 ping/pong
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { logger } from '@neoclaw/core/utils/logger';

const log = logger('wework-ws-client');

/**
 * WeCom WebSocket 配置
 */
export interface WeworkWsConfig {
  botId: string;
  secret: string;
  url?: string;
  pingIntervalMs?: number;
}

/**
 * 生成请求 ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * 消息回调
 */
export interface MessageCallback {
  msgId: string;
  msgType: string;
  content?: string;
  fromUser: string;
  chatType: 'single' | 'group';
  chatId: string;
  aibotId?: string;
  reqId: string; // 请求 ID，回复消息时需要透传
  quote?: {
    msgType: string;
    content: string;
  } | null;
  imageUrl?: string;
  imageUrls?: string[];
  fileUrl?: string;
  fileName?: string;
}

/**
 * 事件回调
 */
export interface EventCallback {
  eventType: string;
  [key: string]: unknown;
}

/**
 * 入站消息类型
 */
export type InboundMessage = MessageCallback | EventCallback;

/**
 * WeCom WebSocket 客户端事件
 */
export interface WeworkWsClientEvents {
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (error: Error) => void;
  message: (msg: InboundMessage) => void;
  subscribed: () => void;
}

/**
 * WeCom WebSocket 客户端
 *
 * 连接到企业微信智能机器人长连接服务。
 */
export class WeworkWsClient extends EventEmitter {
  private _ws: WebSocket | null = null;
  private _config: Required<WeworkWsConfig>;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay: number = 5000;
  private _maxReconnectDelay: number = 60000;
  private _subscribed: boolean = false;
  private _manualClose: boolean = false;

  // 默认配置
  private readonly DEFAULT_URL = 'wss://openws.work.weixin.qq.com';
  private readonly DEFAULT_PING_INTERVAL = 30000;

  constructor(config: WeworkWsConfig) {
    super();
    this._config = {
      url: config.url || this.DEFAULT_URL,
      botId: config.botId,
      secret: config.secret,
      pingIntervalMs: config.pingIntervalMs || this.DEFAULT_PING_INTERVAL,
    };
  }

  /**
   * 连接到 WebSocket 服务器
   */
  connect(): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      log.warn('WebSocket already connected');
      return;
    }

    this._manualClose = false;
    this._subscribed = false;

    log.info(`Connecting to WeCom WebSocket: ${this._config.url}`);

    try {
      this._ws = new WebSocket(this._config.url);
      this._setupWebSocketHandlers();
    } catch (err) {
      log.error('Failed to create WebSocket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this._scheduleReconnect();
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this._manualClose = true;
    this._stopPing();
    this._clearReconnectTimer();

    if (this._ws) {
      log.info('Disconnecting WebSocket...');
      this._ws.close(1000, 'Manual disconnect');
      this._ws = null;
    }
  }

  /**
   * 发送文本响应
   */
  sendText(message: {
    reqId: string; // 请求 ID，来自消息回调
    text: string;
  }): boolean {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._subscribed) {
      log.warn('Cannot send message: WebSocket not ready or not subscribed');
      return false;
    }

    const payload = {
      cmd: 'aibot_respond_msg',
      headers: {
        req_id: message.reqId,
      },
      body: {
        msgtype: 'text',
        text: {
          content: message.text,
        },
      },
    };

    return this._send(payload);
  }

  /**
   * 发送 Markdown 响应
   */
  sendMarkdown(message: {
    reqId: string; // 请求 ID，来自消息回调
    content: string;
  }): boolean {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._subscribed) {
      log.warn('Cannot send markdown message: WebSocket not ready or not subscribed');
      return false;
    }

    const payload = {
      cmd: 'aibot_respond_msg',
      headers: {
        req_id: message.reqId,
      },
      body: {
        msgtype: 'markdown',
        markdown: {
          content: message.content,
        },
      },
    };

    return this._send(payload);
  }

  /**
   * 发送流式消息
   */
  sendStream(message: {
    reqId: string; // 请求 ID，来自消息回调
    streamId: string; // 流 ID
    content: string;
    finish?: boolean; // 是否结束流式消息
  }): boolean {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._subscribed) {
      log.warn('Cannot send stream message: WebSocket not ready or not subscribed');
      return false;
    }

    const payload = {
      cmd: 'aibot_respond_msg',
      headers: {
        req_id: message.reqId,
      },
      body: {
        msgtype: 'stream',
        stream: {
          id: message.streamId,
          content: message.content,
          finish: message.finish ?? false,
        },
      },
    };

    return this._send(payload);
  }

  /**
   * 设置 WebSocket 事件处理器
   */
  private _setupWebSocketHandlers(): void {
    if (!this._ws) return;

    this._ws.on('open', () => {
      log.info('WebSocket connection established');
      this._reconnectDelay = 5000; // Reset reconnect delay on successful connection
      this.emit('open');
      this._subscribe();
      this._startPing();
    });

    this._ws.on('message', (data: Buffer) => {
      const raw = data.toString('utf-8');
      try {
        const message = JSON.parse(raw);
        this._handleMessage(message);
      } catch (err) {
        log.error('Failed to parse WebSocket message', {
          error: err instanceof Error ? err.message : String(err),
          data: raw.substring(0, 500),
        });
      }
    });

    this._ws.on('error', (err: Error) => {
      log.error('WebSocket error', { error: err.message });
      this.emit('error', err);
    });

    this._ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString('utf-8');
      log.info('WebSocket closed', { code, reason: reasonStr });
      this._stopPing();
      this._subscribed = false;
      this.emit('close', code, reasonStr);

      if (!this._manualClose) {
        this._scheduleReconnect();
      }
    });

    this._ws.on('ping', () => {
      // Respond to ping with pong
      if (this._ws) {
        this._ws.pong();
      }
    });

    this._ws.on('pong', () => {
      // Received pong, connection is alive
      log.debug('Received pong from server');
    });
  }

  /**
   * 发送订阅请求
   */
  private _subscribe(): void {
    const reqId = generateRequestId();
    const subscribePayload = {
      cmd: 'aibot_subscribe',
      headers: {
        req_id: reqId,
      },
      body: {
        bot_id: this._config.botId,
        secret: this._config.secret,
      },
    };

    log.debug('Sending aibot_subscribe...', { reqId });
    this._send(subscribePayload);
  }

  /**
   * 处理收到的消息
   */
  private _handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      log.warn('Received invalid message type', { type: typeof message });
      return;
    }

    const msg = message as Record<string, unknown>;
    const cmd = msg.cmd as string;

    log.debug('Received message', { cmd });

    switch (cmd) {
      case 'aibot_msg_callback':
        this._handleMessageCallback(msg);
        break;

      case 'aibot_event_callback':
        this._handleEventCallback(msg);
        break;

      case 'ping':
        // Server ping, respond with pong
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          this._ws.pong();
        }
        break;

      default:
        // 处理其他响应（带有 errcode/errmsg 的通用响应格式，包括订阅响应）
        if ('errcode' in msg && 'errmsg' in msg) {
          this._handleCommonResponse(msg);
        } else {
          log.debug('Unknown message type', { cmd });
        }
    }
  }

  /**
   * 处理通用响应（带有 errcode/errmsg）
   * 包括：订阅响应、命令执行响应等
   */
  private _handleCommonResponse(msg: Record<string, unknown>): void {
    const headers = msg.headers as Record<string, unknown> | null;
    const errCode = msg.errcode as number;
    const errMsg = msg.errmsg as string;
    const reqId = headers?.req_id as string | undefined;

    if (errCode === 0) {
      log.debug('Command executed successfully', { reqId });

      // 检查是否是订阅响应（通过当前未订阅状态判断）
      if (!this._subscribed && reqId) {
        log.info('Successfully subscribed to WeCom bot');
        this._subscribed = true;
        this.emit('subscribed');
      }
    } else {
      log.warn('Command execution failed', { errCode, errMsg, reqId });

      // 如果是订阅失败，触发错误事件并断开连接
      if (!this._subscribed) {
        log.error('Subscription failed', { errCode, errMsg });
        this.emit('error', new Error(`Subscription failed: ${errMsg} (${errCode})`));
        this.disconnect();
      }
    }
  }

  /**
   * 处理消息回调
   */
  private _handleMessageCallback(msg: Record<string, unknown>): void {
    const headers = msg.headers as Record<string, unknown> | null;
    const body = msg.body as Record<string, unknown> | null;
    if (!body) return;

    const reqId = headers?.req_id as string | undefined;
    if (!reqId) {
      log.error('Message callback missing req_id', { body });
      return;
    }

    const msgId = (body.msgid as string) || '';
    const from = body.from as { userid?: string } | null;
    const fromUser = from?.userid || '';
    const chatType = (body.chattype as string) || 'single';
    const chatId = (body.chatid as string) || '';
    const aibotId = (body.aibotid as string) || '';

    // 解析不同类型的消息
    const textData = body.text as { content?: string } | null;
    const content = textData?.content || '';

    const imageData = body.image as { url?: string; aeskey?: string } | null;
    const imageUrl = imageData?.url;

    const mixedData = body.mixed as { msg_item?: Array<unknown> } | null;
    const fileData = body.file as { url?: string; name?: string; aeskey?: string } | null;

    const quoteData = body.quote as { msgtype?: string; text?: { content?: string } } | null;
    const quote = quoteData
      ? {
          msgType: quoteData.msgtype || '',
          content: quoteData.text?.content || '',
        }
      : null;

    let msgType: string;
    let messageCallback: MessageCallback;

    if (mixedData && mixedData.msg_item) {
      // 混合消息
      const textParts: string[] = [];
      const imageUrls: string[] = [];

      for (const item of mixedData.msg_item) {
        if (typeof item === 'object' && item !== null) {
          const itemType = (item as { msgtype?: string }).msgtype;
          if (itemType === 'text') {
            const textContent = (item as { text?: { content?: string } }).text?.content ?? '';
            if (textContent) textParts.push(textContent);
          } else if (itemType === 'image') {
            const url = (item as { image?: { url?: string } }).image?.url ?? '';
            if (url) imageUrls.push(url);
          }
        }
      }

      msgType = 'mixed';
      messageCallback = {
        msgId,
        msgType,
        content: textParts.join('\n'),
        imageUrls,
        fromUser,
        chatType: chatType as 'single' | 'group',
        chatId,
        aibotId,
        reqId,
      };
    } else if (imageUrl) {
      msgType = 'image';
      messageCallback = {
        msgId,
        msgType,
        imageUrl,
        fromUser,
        chatType: chatType as 'single' | 'group',
        chatId,
        reqId,
      };
    } else if (fileData) {
      msgType = 'file';
      messageCallback = {
        msgId,
        msgType,
        fileUrl: fileData.url || '',
        fileName: fileData.name || '',
        fromUser,
        chatType: chatType as 'single' | 'group',
        chatId,
        reqId,
      };
    } else {
      msgType = 'text';
      messageCallback = {
        msgId,
        msgType,
        content,
        fromUser,
        chatType: chatType as 'single' | 'group',
        chatId,
        aibotId,
        reqId,
        quote,
      };
    }

    log.info('Received message callback', {
      msgId,
      msgType,
      fromUser,
      chatType,
      chatId: chatId || '(private)',
      reqId,
      contentPreview: msgType === 'text' ? content.substring(0, 50) : undefined,
    });

    this.emit('message', messageCallback);
  }

  /**
   * 处理事件回调
   */
  private _handleEventCallback(msg: Record<string, unknown>): void {
    const headers = msg.headers as Record<string, unknown> | null;
    const body = msg.body as Record<string, unknown> | null;
    if (!body) return;

    const eventData = body.event as { eventtype?: string } | null;
    const eventType = eventData?.eventtype || '';
    const reqId = (headers?.req_id as string) || '';

    log.info('Received event callback', { eventType, reqId });

    this.emit('message', {
      eventType,
      reqId,
      ...body,
    } as EventCallback);
  }

  /**
   * 发送消息到 WebSocket
   */
  private _send(payload: Record<string, unknown>): boolean {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      log.warn('Cannot send: WebSocket not open');
      return false;
    }

    try {
      const data = JSON.stringify(payload);
      this._ws.send(data);
      return true;
    } catch (err) {
      log.error('Failed to send message', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 启动心跳
   */
  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        const reqId = generateRequestId();
        const pingPayload = {
          cmd: 'ping',
          headers: {
            req_id: reqId,
          },
        };
        this._send(pingPayload);
        log.debug('Sent ping to server', { reqId });
      }
    }, this._config.pingIntervalMs);
  }

  /**
   * 停止心跳
   */
  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /**
   * 安排重连
   */
  private _scheduleReconnect(): void {
    if (this._manualClose) return;

    this._clearReconnectTimer();

    log.info(`Scheduling reconnect in ${this._reconnectDelay}ms`);

    this._reconnectTimer = setTimeout(() => {
      log.info('Attempting to reconnect...');
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
      this.connect();
    }, this._reconnectDelay);
  }

  /**
   * 清除重连定时器
   */
  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * 获取连接状态
   */
  get isConnected(): boolean {
    return this._ws !== null && this._ws.readyState === WebSocket.OPEN && this._subscribed;
  }

  /**
   * 获取订阅状态
   */
  get isSubscribed(): boolean {
    return this._subscribed;
  }
}
