/**
 * FeishuGateway — Feishu/Lark messaging gateway adapter.
 *
 * Connects to Feishu via WebSocket, parses incoming messages,
 * and delivers responses as interactive cards.
 *
 * Protocol-level concerns handled here:
 * - WebSocket lifecycle
 * - Message deduplication
 * - Reaction emoji (⏳ while processing, removed when done)
 * - Reply-to-message threading
 * - Error reporting back to the user
 * - Streaming card updates via Feishu cardkit API (JSON 2.0)
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { AgentStreamEvent, OutboundImage, RunResponse } from '@neoclaw/core';
import type { FeishuConfig } from '@neoclaw/core/config';
import { logger } from '@neoclaw/core/utils/logger';
import type {
  Gateway,
  InboundMessage,
  MessageHandler,
  ReplyFn,
  StreamHandler,
} from '@neoclaw/core/types/gateway';
import type { BotCredentials, RawMessageEvent } from './client.js';
import { fetchBotInfo, getEventDispatcher, getHttpClient, getWsClient } from './client.js';
import { parseMessage } from './receiver.js';
import {
  addReaction,
  appendCardElements,
  appendStepToPanel,
  buildCard,
  buildQuestionFormElements,
  buildStepDiv,
  buildStreamingCard,
  closeCardStreaming,
  createCardEntity,
  deleteCardElement,
  formatToolStep,
  insertStepsPanel,
  patchCardElement,
  removeReaction,
  sendCard,
  sendCardByRef,
  sendImageFromBuffer,
  sendMarkdown,
  STREAM_EL,
  updateCardText,
  updatePanelHeader,
  updateStepText,
} from './sender.js';

const log = logger('feishu');

// ── Card action callback type ─────────────────────────────────

type CardActionEvent = {
  operator?: { open_id?: string };
  action?: {
    tag?: string;
    value?: Record<string, unknown>;
    form_value?: Record<string, string>;
  };
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
};

// ── FeishuGateway ─────────────────────────────────────────────

export class FeishuGateway implements Gateway {
  readonly kind = 'feishu';

  private _stopped = false;
  private _handler: MessageHandler | null = null;

  constructor(private readonly _config: FeishuConfig) {}

  async start(handler: MessageHandler): Promise<void> {
    if (!this._config.appId || !this._config.appSecret) {
      throw new Error('Feishu gateway: appId and appSecret are required');
    }
    this._handler = handler;

    log.info('Starting Feishu gateway...');
    this._startWebSocket();

    // start() must not resolve until stop() is called
    return new Promise<void>(() => {});
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._handler = null;
    log.info('Feishu gateway stopped');
  }

  /** Proactively send a message to a chat (e.g. restart notifications). */
  async send(chatId: string, response: RunResponse): Promise<void> {
    const client = this._httpClient();
    await this._sendResponse(client, chatId, response);
  }

  // ── Internals ───────────────────────────────────────────────

  private _httpClient() {
    return getHttpClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain as 'feishu' | 'lark' | undefined,
    });
  }

  private _startWebSocket(): void {
    const creds: BotCredentials = {
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain: this._config.domain as 'feishu' | 'lark' | undefined,
    };

    const client = getHttpClient(creds);
    let botOpenId: string | undefined;

    // Resolve bot open_id in the background (needed for @mention detection in groups)
    fetchBotInfo(creds).then((info) => {
      if (info.ok && info.botOpenId) {
        botOpenId = info.botOpenId;
        log.info(`Bot open_id: ${botOpenId} (${info.botName ?? 'unknown name'})`);
      } else {
        log.warn(`Could not resolve bot open_id: ${info.error ?? 'unknown error'}`);
      }
    });

    const dispatcher = getEventDispatcher({
      encryptKey: this._config.encryptKey,
      verificationToken: this._config.verificationToken,
    });

    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        log.debug(`Received message event: ${JSON.stringify(data, null, 2)}`);
        if (this._stopped) return;
        try {
          await this._handleRawMessage(
            data as unknown as RawMessageEvent,
            client,
            creds,
            botOpenId
          );
        } catch (err) {
          log.error(`Unhandled error in message handler: ${err}`);
        }
      },
      'im.message.message_read_v1': async () => {},
      'im.chat.member.bot.added_v1': async (data) => {
        log.info(`Bot added to chat: ${(data as Record<string, unknown>)['chat_id']}`);
      },
      'im.chat.member.bot.deleted_v1': async (data) => {
        log.info(`Bot removed from chat: ${(data as Record<string, unknown>)['chat_id']}`);
      },
      // Handle interactive card form submissions (AskUserQuestion answers).
      // Must return a response within 3 seconds — process the message asynchronously.
      'card.action.trigger': async (data: unknown) => {
        if (this._stopped) return;
        const evt = data as CardActionEvent;
        const value = evt.action?.value;
        if (value?.['_neoclaw_action'] !== 'questions_submit') return;

        // Fire-and-forget: handler sends the agent message asynchronously
        this._handleCardAction(evt).catch((err) => log.error(`Card action handler error: ${err}`));

        // Return a toast immediately so the Feishu client doesn't show an error
        return { toast: { type: 'success', content: 'Submitted, in progress...' } };
      },
    } as Parameters<typeof dispatcher.register>[0]);

    const wsClient = getWsClient(creds);
    wsClient.start({ eventDispatcher: dispatcher });
    log.info('WebSocket client started');
  }

  private async _handleRawMessage(
    event: RawMessageEvent,
    client: Lark.Client,
    creds: BotCredentials,
    botOpenId?: string
  ): Promise<void> {
    if (!this._handler) return;

    const parsed = await parseMessage(event, creds, {
      botOpenId,
      groupAutoReply: this._config.groupAutoReply,
    });
    log.debug(`Parsed message: ${JSON.stringify(parsed, null, 2)}`);
    if (!parsed) return;

    const msg: InboundMessage = {
      id: parsed.messageId,
      text: parsed.text,
      chatId: parsed.chatId,
      threadRootId: parsed.threadRootId,
      authorId: parsed.senderOpenId,
      authorName: parsed.senderName,
      gatewayKind: this.kind,
      chatType: parsed.chatType === 'p2p' ? 'private' : 'group',
      attachments: parsed.attachments.map((a) => ({
        buffer: a.buffer,
        // Extract 'image', 'file', etc. from the '<media:image>' placeholder
        mediaType: a.placeholder.slice('<media:'.length, -1),
        fileName: a.fileName,
      })),
      meta: {
        chatType: parsed.chatType,
        mentionedBot: parsed.mentionedBot,
      },
    };

    log.debug(`Parsed inbound message: ${JSON.stringify(msg, null, 2)}`);

    // reply() used for slash commands and non-streaming fallback
    const reply: ReplyFn = (response) => this._sendReply(parsed.chatId, response, parsed.messageId);
    // streamHandler used for normal agent responses (streaming card updates)
    const streamHandler: StreamHandler = (stream) =>
      this._streamingReply(parsed.chatId, stream, parsed.messageId);

    const reactionId = await addReaction(client, parsed.messageId, 'OneSecond');
    try {
      await this._handler(msg, reply, streamHandler);
    } catch (err) {
      log.error(`Failed to process message ${parsed.messageId}: ${err}`);
      try {
        await sendMarkdown(client, parsed.chatId, `**Error:** ${String(err)}`, {
          replyToMessageId: parsed.messageId,
        });
      } catch {
        /* give up */
      }
    } finally {
      if (reactionId) await removeReaction(client, parsed.messageId, reactionId);
    }
  }

  /** Non-streaming reply (slash commands, proactive sends). */
  private async _sendReply(
    chatId: string,
    response: RunResponse,
    replyToMessageId: string
  ): Promise<void> {
    const client = this._httpClient();
    await this._sendResponse(client, chatId, response, replyToMessageId);
  }

  private async _sendResponse(
    client: Lark.Client,
    chatId: string,
    response: RunResponse,
    replyToMessageId?: string
  ): Promise<void> {
    const stats = formatStats(response);
    const hasCardContent = Boolean(response.text?.trim() || response.thinking || stats);
    if (hasCardContent) {
      await sendCard(
        client,
        chatId,
        buildCard({ text: response.text, thinking: response.thinking, stats }),
        replyToMessageId ? { replyToMessageId } : undefined
      );
    }
    await this._sendOutboundImages(client, chatId, response.outboundImages, replyToMessageId);
  }

  private async _sendOutboundImages(
    client: Lark.Client,
    chatId: string,
    images: OutboundImage[] | undefined,
    replyToMessageId?: string
  ): Promise<void> {
    if (!images || images.length === 0) return;

    for (const img of images) {
      try {
        const buf = decodeBase64Image(img.base64);
        await sendImageFromBuffer(client, chatId, buf, {
          replyToMessageId,
          fileName: img.fileName,
          mimeType: img.mimeType,
        });
      } catch (err) {
        log.error(`Failed to send outbound image: ${err}`);
      }
    }
  }

  /**
   * Handle a card.action.trigger callback from a question form submission.
   * Formats selected answers as a numbered list and dispatches it as a synthetic
   * InboundMessage so the agent can continue the conversation.
   */
  private async _handleCardAction(event: CardActionEvent): Promise<void> {
    if (!this._handler) return;

    const value = event.action?.value;
    if (value?.['_neoclaw_action'] !== 'questions_submit') return;

    const chatId = (value['_neoclaw_chat_id'] as string | undefined) ?? event.context?.open_chat_id;
    const threadRootId = (value['_neoclaw_thread_id'] as string | undefined) || undefined;
    const formValue = event.action?.form_value ?? {};
    const operatorOpenId = event.operator?.open_id ?? 'unknown';

    if (!chatId) {
      log.warn('Card action: missing chatId, ignoring');
      return;
    }

    // Reconstruct ordered answers from q0, q1, … keys
    const answers = Object.entries(formValue)
      .filter(([k]) => /^q\d+$/.test(k))
      .sort(([a], [b]) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
      .map(([, label], idx) => `${idx + 1}. ${label}`);

    if (answers.length === 0) {
      log.warn('Card action: form_value has no q* entries, ignoring');
      return;
    }

    const text = answers.join('\n');
    log.info(
      `Card form submitted by ${operatorOpenId} in ${chatId}: ${text.replace(/\n/g, ' | ')}`
    );

    const msg: InboundMessage = {
      id: `card_submit_${Date.now()}`,
      text,
      chatId,
      threadRootId,
      authorId: operatorOpenId,
      gatewayKind: this.kind,
      attachments: [],
    };

    const reply: ReplyFn = (response) => this._sendReply(chatId, response, '');
    const streamHandler: StreamHandler = (stream) => this._streamingReply(chatId, stream, '');

    await this._handler(msg, reply, streamHandler);
  }

  /**
   * Streaming reply: lazily creates a Feishu streaming card (JSON 2.0) on the
   * first content event, then progressively updates it as agent events arrive.
   *
   * Visual style inspired by agentara:
   * - Steps panel: collapsible with border, grey header, per-tool icons
   * - Thinking: each segment is a DivElement (robot icon), interleaved with tool steps
   * - Tool calls: individual DivElements with specific icons and descriptions
   * - Loading indicator: grey dots icon at the bottom during streaming
   * - AskUserQuestion: interactive form appended to the card (NeoClaw-specific)
   */
  private async _streamingReply(
    chatId: string,
    stream: AsyncIterable<AgentStreamEvent>,
    replyToMessageId: string
  ): Promise<void> {
    const client = this._httpClient();

    let cardId: string | null = null;
    let mainText = '';
    let stepsPanelAdded = false;
    let stepCount = 0;
    // Current thinking segment — each contiguous run of thinking_deltas becomes one step
    let currentThinkingId: string | null = null;
    let currentThinkingText = '';
    let thinkingSegmentCount = 0;
    let lastStepId = ''; // Tracks last element in panel for insert_after
    let seq = 1;
    let lastThinkingFlush = 0;
    let lastMainFlush = 0;
    let outboundImages: OutboundImage[] | undefined;
    const FLUSH_INTERVAL_MS = 150;

    // Create and send the card on first use — idempotent after that.
    const ensureCard = async (): Promise<string> => {
      if (cardId) return cardId;
      cardId = await createCardEntity(client, buildStreamingCard());
      await sendCardByRef(client, chatId, cardId, { replyToMessageId });
      log.info(`Streaming card ${cardId} sent to ${chatId}`);
      return cardId;
    };

    // Add a step element to the panel (creates panel with it on first call).
    const addStep = async (
      id: string,
      stepDiv: Record<string, unknown>,
      stepId: string
    ): Promise<void> => {
      if (!stepsPanelAdded) {
        await insertStepsPanel(client, id, stepDiv, seq++);
        stepsPanelAdded = true;
      } else {
        await appendStepToPanel(client, id, stepDiv, lastStepId, seq++);
      }
      lastStepId = stepId;
    };

    // Update panel header with current step count.
    const refreshPanelHeader = async (id: string, label: string): Promise<void> => {
      const countText = stepCount + ' ' + (stepCount === 1 ? 'step' : 'steps');
      await updatePanelHeader(client, id, `${label} (${countText})`, seq++).catch((e) =>
        log.warn(`updatePanelHeader failed: ${e}`)
      );
    };

    // Finalize the current thinking segment (flush text, reset state).
    const finalizeThinking = async (id: string): Promise<void> => {
      if (!currentThinkingId) return;
      await updateStepText(client, id, currentThinkingId, currentThinkingText, seq++).catch((e) =>
        log.warn(`final thinking segment flush failed: ${e}`)
      );
      currentThinkingId = null;
      currentThinkingText = '';
    };

    try {
      for await (const event of stream) {
        const now = Date.now();

        if (event.type === 'thinking_delta') {
          currentThinkingText += event.text;
          const id = await ensureCard();

          // Start a new thinking segment if needed (robot icon DivElement)
          if (!currentThinkingId) {
            thinkingSegmentCount++;
            stepCount++;
            currentThinkingId = `thinking_${thinkingSegmentCount}`;
            const thinkingDiv = buildStepDiv('', 'robot_outlined', currentThinkingId);
            await addStep(id, thinkingDiv, currentThinkingId).catch((e) =>
              log.warn(`addStep (thinking) failed: ${e}`)
            );
            await refreshPanelHeader(id, 'Working on it');
          }

          // Throttled text update for the current thinking DivElement
          if (now - lastThinkingFlush >= FLUSH_INTERVAL_MS) {
            await updateStepText(client, id, currentThinkingId, currentThinkingText, seq++).catch(
              (e) => log.warn(`thinking update failed: ${e}`)
            );
            lastThinkingFlush = now;
          }
        } else if (event.type === 'tool_use') {
          const id = await ensureCard();

          // Finalize the preceding thinking segment so tool step appears after it
          await finalizeThinking(id);

          stepCount++;
          const { text, icon } = formatToolStep(event.name, event.input);
          const stepElementId = `step_${stepCount}`;
          const stepDiv = buildStepDiv(text, icon, stepElementId);

          await addStep(id, stepDiv, stepElementId).catch((e) =>
            log.warn(`addStep (tool) failed: ${e}`)
          );
          await refreshPanelHeader(id, 'Working on it');
        } else if (event.type === 'text_delta') {
          const id = await ensureCard();
          await finalizeThinking(id);

          mainText += event.text;
          if (now - lastMainFlush >= FLUSH_INTERVAL_MS) {
            await updateCardText(client, id, STREAM_EL.mainMd, mainText, seq++).catch((e) =>
              log.warn(`main update failed: ${e}`)
            );
            lastMainFlush = now;
          }
        } else if (event.type === 'ask_questions') {
          const id = await ensureCard();
          const { threadRootId } = parseConvId(event.conversationId);
          const formEls = buildQuestionFormElements({
            questions: event.questions,
            chatId,
            threadRootId,
          });
          await appendCardElements(client, id, formEls, seq++).catch((e) =>
            log.warn(`appendQuestionForm failed: ${e}`)
          );
          log.info(`Question form appended to card ${id} (${event.questions.length} questions)`);
        } else if (event.type === 'done') {
          const response = event.response;
          outboundImages = response.outboundImages;
          const id = await ensureCard();

          // Finalize any in-progress thinking segment
          await finalizeThinking(id);

          // Final flush with canonical response text
          mainText = response.text || mainText;
          await updateCardText(client, id, STREAM_EL.mainMd, mainText, seq++).catch((e) =>
            log.warn(`final main update failed: ${e}`)
          );

          // Update panel header to final "Show N steps" label
          if (stepsPanelAdded && stepCount > 0) {
            const countText = stepCount + ' ' + (stepCount === 1 ? 'step' : 'steps');
            await updatePanelHeader(client, id, `Show ${countText}`, seq++).catch((e) =>
              log.warn(`final header update failed: ${e}`)
            );
          }

          // Remove loading indicator
          await deleteCardElement(client, id, STREAM_EL.loadingDiv, seq++).catch((e) =>
            log.warn(`delete loading div failed: ${e}`)
          );

          // Append stats footer
          const stats = formatStats(response);
          if (stats) {
            await appendCardElements(
              client,
              id,
              [
                { tag: 'hr', element_id: STREAM_EL.statsHr },
                { tag: 'markdown', element_id: STREAM_EL.statsNote, content: `*${stats}*` },
              ],
              seq++
            ).catch((e) => log.warn(`append stats failed: ${e}`));
          }
        }
      }
    } finally {
      if (cardId) {
        await closeCardStreaming(client, cardId, seq++).catch((e) =>
          log.warn(`closeCardStreaming failed: ${e}`)
        );
        if (stepsPanelAdded && stepCount > 0) {
          await patchCardElement(
            client,
            cardId,
            STREAM_EL.stepsPanel,
            { expanded: false },
            seq++
          ).catch((e) => log.warn(`collapse steps panel failed: ${e}`));
        }
      }
      await this._sendOutboundImages(client, chatId, outboundImages, replyToMessageId);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** Parse a conversationId of the form "chatId" or "chatId:thread:threadId". */
function parseConvId(convId: string): { chatId: string; threadRootId?: string } {
  const sep = '_thread_';
  const idx = convId.indexOf(sep);
  if (idx >= 0) {
    return { chatId: convId.slice(0, idx), threadRootId: convId.slice(idx + sep.length) };
  }
  return { chatId: convId };
}

function formatStats(response: RunResponse): string | null {
  const parts: string[] = [];
  if (response.model) parts.push(response.model);
  if (response.elapsedMs != null) parts.push(`${(response.elapsedMs / 1000).toFixed(1)}s`);
  if (response.inputTokens != null) parts.push(`${response.inputTokens} in`);
  if (response.outputTokens != null) parts.push(`${response.outputTokens} out`);
  if (response.costUsd != null) parts.push(`$${response.costUsd.toFixed(4)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function decodeBase64Image(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('empty base64 image payload');

  const comma = trimmed.indexOf(',');
  const base64 = trimmed.startsWith('data:') && comma > 0 ? trimmed.slice(comma + 1) : trimmed;
  return Buffer.from(base64, 'base64');
}
