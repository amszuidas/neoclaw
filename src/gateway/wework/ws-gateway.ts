/**
 * WeCom WebSocket Gateway
 *
 * 企业微信智能助手 WebSocket 网关实现。
 *
 * 使用 WebSocket 长连接模式：
 * - 连接到 wss://openws.work.weixin.qq.com
 * - 使用 Bot ID 和 Secret 进行鉴权
 * - 支持消息去重和防抖
 * - 支持流式响应
 */

import type { AgentStreamEvent, RunResponse } from '../../agents/types.js';
import { logger } from '../../utils/logger.js';
import type { Gateway, InboundMessage, MessageHandler, ReplyFn, StreamHandler } from '../types.js';
import { WeworkWsClient, type InboundMessage as WsInboundMessage, type MessageCallback } from './ws-client.js';

const log = logger('wework-ws-gateway');

/**
 * 思考占位符（显示在 LLM 处理时）
 */
const THINKING_PLACEHOLDER = '思考中...';

/**
 * 生成流 ID
 */
function generateStreamId(): string {
  return `stream_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * 智能助手配置
 */
export interface WeworkWsConfig {
  botId: string;
  secret: string;
  websocketUrl?: string;
}

/**
 * 消息缓冲区（用于防抖）
 */
interface MessageBuffer {
  messages: MessageCallback[];
  timestamp: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 企业微信智能助手 WebSocket 网关
 */
export class WeworkWsGateway implements Gateway {
  readonly kind = 'wework';

  private _stopped = false;
  private _handler: MessageHandler | null = null;
  private _client: WeworkWsClient;
  private _config: WeworkWsConfig;

  // 防抖相关
  private readonly DEBOUNCE_MS = 2000;
  private readonly messageBuffers = new Map<string, MessageBuffer>();

  // 消息去重
  private readonly seenMsgIds = new Set<string>();
  private readonly MAX_SEEN_MSG_IDS = 10000;

  // 活动流跟踪（用于主动发送消息）
  private readonly activeStreams = new Map<string, string>();

  constructor(config: WeworkWsConfig) {
    this._config = config;
    this._client = new WeworkWsClient({
      botId: config.botId,
      secret: config.secret,
      url: config.websocketUrl,
    });
  }

  async start(handler: MessageHandler): Promise<void> {
    if (!this._config.botId || !this._config.secret) {
      throw new Error('Wework WebSocket gateway: botId and secret are required');
    }
    this._handler = handler;

    log.info('Starting Wework WebSocket gateway...');

    // 设置客户端事件处理器
    this._setupClientHandlers();

    // 连接到 WebSocket 服务器
    this._client.connect();

    // start() 必须在 stop() 被调用前一直 resolve
    return new Promise<void>(() => {});
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._handler = null;

    // 清理防抖计时器
    for (const [, buf] of this.messageBuffers) {
      clearTimeout(buf.timer);
    }
    this.messageBuffers.clear();

    // 清理去重缓存
    this.seenMsgIds.clear();

    // 断开 WebSocket 连接
    this._client.disconnect();
  }

  /** 主动发送消息到会话（如重启通知） */
  async send(userId: string, response: RunResponse): Promise<void> {
    // WebSocket 模式下，主动发送需要找到活动的流
    const streamId = this.activeStreams.get(userId);
    if (streamId && this._client.isConnected) {
      // 这里我们使用 msgId 作为 streamId
      // 如果有 streamId，说明有正在处理的请求
      // 我们可以尝试发送响应
      log.warn('Wework WebSocket send:主动发送在 WebSocket 模式下需要通过现有流');
    } else {
      log.warn('Wework WebSocket send: no active stream for user', { userId });
    }
  }

  /**
   * 设置客户端事件处理器
   */
  private _setupClientHandlers(): void {
    this._client.on('open', () => {
      log.info('WeCom WebSocket connection opened');
    });

    this._client.on('subscribed', () => {
      log.info('WeCom bot subscription successful');
    });

    this._client.on('message', (msg: WsInboundMessage) => {
      if ('eventType' in msg) {
        // 事件消息
        log.info('Wework event received', { event: msg.eventType });
      } else {
        // 普通消息
        this._handleInboundMessage(msg).catch((err) => {
          log.error('Wework message processing failed', { error: err.message });
        });
      }
    });

    this._client.on('close', (code: number, reason: string) => {
      log.warn('WeCom WebSocket connection closed', { code, reason });
    });

    this._client.on('error', (error: Error) => {
      log.error('WeCom WebSocket error', { error: error.message });
    });
  }

  /**
   * 处理入站消息
   */
  private async _handleInboundMessage(wsMsg: MessageCallback): Promise<void> {
    const { msgId, msgType, fromUser, chatId } = wsMsg;

    // 检查重复消息
    if (this.seenMsgIds.has(msgId)) {
      log.debug('Duplicate message ignored', { msgId });
      return;
    }
    this.seenMsgIds.add(msgId);

    // 防止去重缓存无限增长
    if (this.seenMsgIds.size > this.MAX_SEEN_MSG_IDS) {
      const first = this.seenMsgIds.values().next().value;
      if (first) this.seenMsgIds.delete(first);
    }

    // 获取流键（用户 ID 或群聊 ID）
    const streamKey = this._getStreamKey(wsMsg);
    const isCommand =
      msgType === 'text' && wsMsg.content ? wsMsg.content.trim().startsWith('/') : false;

    // 命令绕过防抖 - 立即处理
    if (isCommand) {
      this._processMessage(wsMsg, streamKey);
    } else {
      // 防抖：缓冲非命令消息
      const existing = this.messageBuffers.get(streamKey);
      if (existing) {
        // 之前的消息仍在缓冲 - 合并这条消息
        existing.messages.push(wsMsg);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(
          () => this._flushMessageBuffer(streamKey),
          this.DEBOUNCE_MS
        );
        log.info('Wework: message buffered for merge', {
          streamKey,
          msgId,
          buffered: existing.messages.length,
        });
      } else {
        // 第一条消息 - 启动新的缓冲
        const buffer: MessageBuffer = {
          messages: [wsMsg],
          timestamp: Date.now(),
          timer: setTimeout(() => this._flushMessageBuffer(streamKey), this.DEBOUNCE_MS),
        };
        this.messageBuffers.set(streamKey, buffer);
        log.info('Wework: message buffered (first)', { streamKey, msgId });
      }
    }
  }

  /**
   * 刷新防抖缓冲区
   */
  private _flushMessageBuffer(streamKey: string): void {
    const buffer = this.messageBuffers.get(streamKey);
    if (!buffer) {
      return;
    }

    this.messageBuffers.delete(streamKey);

    const { messages } = buffer;
    const primaryMsg = messages[0];

    if (!primaryMsg) {
      log.warn('Wework: no primary message in buffer', { streamKey });
      return;
    }

    // 合并所有缓冲消息的内容
    if (messages.length > 1) {
      const mergedContent = messages
        .map((m) => (m.msgType === 'text' || m.msgType === 'mixed' ? m.content || '' : ''))
        .filter(Boolean)
        .join('\n');

      if (primaryMsg.msgType === 'text' || primaryMsg.msgType === 'mixed') {
        primaryMsg.content = mergedContent;
      }

      // 合并图片附件
      const allImageUrls = messages.flatMap((m) =>
        m.msgType === 'image' ? (m.imageUrl ? [m.imageUrl] : []) : m.imageUrls || []
      );
      if (allImageUrls.length > 0 && (primaryMsg.msgType === 'text' || primaryMsg.msgType === 'mixed')) {
        if (primaryMsg.msgType === 'text') {
          // 转换为混合消息类型
          primaryMsg.msgType = 'mixed';
          primaryMsg.imageUrls = allImageUrls;
        } else {
          primaryMsg.imageUrls = allImageUrls;
        }
      }

      log.info('Wework: flushing merged messages', {
        streamKey,
        count: messages.length,
        mergedContentPreview: mergedContent.substring(0, 60),
      });
    } else {
      log.info('Wework: flushing single message', { streamKey, msgId: primaryMsg.msgId });
    }

    // 处理合并的消息
    this._processMessage(primaryMsg, streamKey);
  }

  /**
   * 处理消息
   */
  private _processMessage(wsMsg: MessageCallback, streamKey: string): void {
    if (!this._handler) return;

    // 注册活动流
    this.activeStreams.set(streamKey, wsMsg.msgId);

    // 构建 chatId：单聊使用 fromUser，群聊使用 chatId
    const chatId = wsMsg.chatType === 'group' ? wsMsg.chatId : wsMsg.fromUser;

    // 构建入站消息
    const msg: InboundMessage = {
      id: wsMsg.msgId,
      text: (wsMsg.msgType === 'text' || wsMsg.msgType === 'mixed') ? (wsMsg.content || '') : '',
      chatId,
      threadRootId: undefined,
      authorId: wsMsg.fromUser,
      authorName: wsMsg.fromUser,
      gatewayKind: this.kind,
      attachments: [],
      meta: {
        msgType: wsMsg.msgType,
        reqId: wsMsg.reqId,
        aibotId: wsMsg.aibotId,
        imageUrl: wsMsg.msgType === 'image' ? wsMsg.imageUrl : undefined,
        imageUrls: wsMsg.msgType === 'mixed' ? wsMsg.imageUrls : undefined,
        fileUrl: wsMsg.msgType === 'file' ? wsMsg.fileUrl : undefined,
        fileName: wsMsg.msgType === 'file' ? wsMsg.fileName : undefined,
        quote: wsMsg.quote,
      },
    };

    log.debug(`Parsed inbound message: ${JSON.stringify(msg, null, 2)}`);

    // 生成流 ID（用于流式消息）
    const streamId = generateStreamId();

    // 回复闭包
    const reply: ReplyFn = async (response) => {
      this._client.sendText({
        reqId: wsMsg.reqId,
        text: response.text,
      });
      this.activeStreams.delete(streamKey);
    };

    // 流式处理闭包
    const streamHandler: StreamHandler = async (stream) => {
      for await (const evt of stream) {
        if (evt.type === 'thinking_delta') {
          // 思考内容可以发送流式消息更新
          this._client.sendStream({
            reqId: wsMsg.reqId,
            streamId,
            content: evt.text || '',
            finish: false,
          });
        } else if (evt.type === 'text_delta') {
          // 文本内容发送流式消息更新
          this._client.sendStream({
            reqId: wsMsg.reqId,
            streamId,
            content: evt.text || '',
            finish: false,
          });
        } else if (evt.type === 'done') {
          // 发送最终响应
          const response = evt.response;
          this._client.sendText({
            reqId: wsMsg.reqId,
            text: response.text,
          });
          this.activeStreams.delete(streamKey);
        }
      }
    };

    // 调用处理器
    this._handler(msg, reply, streamHandler).catch((err) => {
      log.error('Handler error', { error: err.message });
      // 发送错误提示
      this._client.sendText({
        reqId: wsMsg.reqId,
        text: '处理消息时出错，请稍后再试。',
      });
      this.activeStreams.delete(streamKey);
    });
  }

  /**
   * 获取流的键（用户 ID 或群聊 ID）
   */
  private _getStreamKey(message: MessageCallback): string {
    if (message.chatType === 'group' && message.chatId) {
      return message.chatId;
    }
    return message.fromUser;
  }
}
