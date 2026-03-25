/**
 * Feishu message parsing and deduplication.
 *
 * Handles:
 * - Message dedup (persisted to ~/.neoclaw/cache/feishu-dedup.json)
 * - Text extraction from Feishu message types (text, post/rich-text)
 * - Media key extraction and attachment download
 * - Sender name resolution with caching
 * - Bot @mention detection and stripping
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createDebouncedFlush } from '@neoclaw/core/utils/debounced-flush';
import { logger } from '@neoclaw/core/utils/logger';
import type { BotCredentials, MediaDownload, RawMessageEvent } from './client.js';
import { getHttpClient } from './client.js';

const log = logger('feishu:receiver');

// ── Deduplication ─────────────────────────────────────────────

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEDUP_PATH = join(homedir(), '.neoclaw', 'cache', 'feishu-dedup.json');

const seenIds = new Map<string, number>();
let lastCleanup = Date.now();

function loadDedup(): void {
  try {
    if (!existsSync(DEDUP_PATH)) return;
    const entries: [string, number][] = JSON.parse(readFileSync(DEDUP_PATH, 'utf-8'));
    const now = Date.now();
    for (const [id, ts] of entries) {
      if (now - ts < DEDUP_TTL_MS) seenIds.set(id, ts);
    }
  } catch {
    // Start fresh on parse error
  }
}

const flushDedup = createDebouncedFlush(() => {
  try {
    const dir = join(homedir(), '.neoclaw', 'cache');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DEDUP_PATH, JSON.stringify([...seenIds.entries()]));
  } catch {
    // Non-critical
    log.warn('Failed to flush Feishu deduplication cache');
  }
}, 2000);

/** Returns true if the message is new (and marks it as seen). */
function markSeen(messageId: string): boolean {
  const now = Date.now();

  // Periodic cleanup of expired entries
  if (now - lastCleanup > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of seenIds) {
      if (now - ts > DEDUP_TTL_MS) seenIds.delete(id);
    }
    lastCleanup = now;
  }

  if (seenIds.has(messageId)) return false;

  // Evict oldest entry when at capacity
  if (seenIds.size >= DEDUP_MAX_ENTRIES) {
    const oldest = seenIds.keys().next().value;
    if (oldest) seenIds.delete(oldest);
  }

  seenIds.set(messageId, now);
  flushDedup();
  return true;
}

// Initialize dedup cache on module load
loadDedup();

// ── Content extraction ────────────────────────────────────────

function extractText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (msgType === 'text') return (parsed['text'] as string) || '';
    if (msgType === 'post') return extractRichText(content);
    return content;
  } catch {
    return content;
  }
}

function applyStyles(text: string, styles: string[]): string {
  if (!text || !styles.length) return text;
  let result = text;
  if (styles.includes('bold')) result = `**${result}**`;
  if (styles.includes('italic')) result = `*${result}*`;
  if (styles.includes('underline')) result = `<u>${result}</u>`;
  if (styles.includes('lineThrough')) result = `~~${result}~~`;
  return result;
}

function extractRichText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string;
      content?: Array<
        Array<{
          tag: string;
          language?: string;
          text?: string;
          href?: string;
          user_id?: string;
          user_name?: string;
          image_key?: string;
          style?: string[];
        }>
      >;
    };
    const title = parsed.title ?? '';
    const blocks = parsed.content ?? [];
    let text = title ? `# ${title}\n\n` : '';
    for (const para of blocks) {
      for (const el of para) {
        const styles = el.style ?? [];
        if (el.tag === 'text') text += applyStyles(el.text ?? '', styles);
        else if (el.tag === 'code_block')
          text += `\`\`\`${el.language ?? ''}\n${el.text ?? ''}\`\`\``;
        else if (el.tag === 'a') text += `[${el.text ?? el.href ?? ''}](${el.href ?? ''})`;
        else if (el.tag === 'at') {
          if (el.user_name) {
            text += `@${el.user_name}`;
          } else if (el.user_id) {
            text += el.user_id; // el.user_id: @_user_x
          }
        }
        // Images in rich text are noted but not inlined as text
      }
      text += '\n';
    }
    return text.trim() || '[富文本消息]';
  } catch {
    return '[富文本消息]';
  }
}

function extractMediaKeys(
  content: string,
  msgType: string
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    switch (msgType) {
      case 'image':
        return { imageKey: parsed['image_key'] as string };
      case 'file':
        return { fileKey: parsed['file_key'] as string, fileName: parsed['file_name'] as string };
      case 'audio':
      case 'sticker':
        return { fileKey: parsed['file_key'] as string };
      case 'video':
        return { fileKey: parsed['file_key'] as string, imageKey: parsed['image_key'] as string };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

function mediaPlaceholder(msgType: string): string {
  switch (msgType) {
    case 'image':
      return '<media:image>';
    case 'file':
      return '<media:file>';
    case 'audio':
      return '<media:audio>';
    case 'video':
      return '<media:video>';
    case 'sticker':
      return '<media:sticker>';
    default:
      return '<media:attachment>';
  }
}

function isBotMentioned(event: RawMessageEvent, botOpenId?: string): boolean {
  if (!botOpenId) return false;
  return (event.message.mentions ?? []).some((m) => m.id.open_id === botOpenId);
}

// ── Media download ────────────────────────────────────────────

async function toBuffer(response: unknown): Promise<Buffer> {
  const r = response as Record<string, unknown>;
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof ArrayBuffer) return Buffer.from(response);
  if (Buffer.isBuffer(r['data'])) return r['data'] as Buffer;
  if (r['data'] instanceof ArrayBuffer) return Buffer.from(r['data'] as ArrayBuffer);
  if (
    typeof (r as { getReadableStream?: () => AsyncIterable<unknown> })['getReadableStream'] ===
    'function'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of (
      r as { getReadableStream: () => AsyncIterable<unknown> }
    ).getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }
  if (response instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported response format for media download');
}

async function downloadAttachment(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  kind: 'image' | 'file'
): Promise<Buffer> {
  const res = await (
    client as unknown as {
      im: {
        messageResource: {
          get: (opts: {
            path: { message_id: string; file_key: string };
            params: { type: string };
          }) => Promise<unknown>;
        };
      };
    }
  ).im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: kind },
  });
  return toBuffer(res);
}

/** Extract image_key values from all `img` elements inside a `post` message. */
function extractRichTextImageKeys(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<Array<{ tag: string; image_key?: string }>>;
    };
    const keys: string[] = [];
    for (const para of parsed.content ?? []) {
      for (const el of para) {
        if (el.tag === 'img' && el.image_key) keys.push(el.image_key);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

async function fetchAttachments(
  client: Lark.Client,
  messageId: string,
  msgType: string,
  content: string
): Promise<MediaDownload[]> {
  // Pure media messages (standalone image / file / audio / video / sticker)
  const pureMediaTypes = ['image', 'file', 'audio', 'video', 'sticker'];
  if (pureMediaTypes.includes(msgType)) {
    const keys = extractMediaKeys(content, msgType);
    const fileKey = keys.imageKey ?? keys.fileKey;
    if (!fileKey) return [];
    try {
      const kind = msgType === 'image' ? 'image' : 'file';
      const buffer = await downloadAttachment(client, messageId, fileKey, kind);
      return [{ buffer, fileName: keys.fileName, placeholder: mediaPlaceholder(msgType) }];
    } catch {
      return [];
    }
  }

  // Post (rich text) messages may embed images via `img` tags
  if (msgType === 'post') {
    const imageKeys = extractRichTextImageKeys(content);
    if (imageKeys.length === 0) return [];
    const results: MediaDownload[] = [];
    for (const key of imageKeys) {
      try {
        const buffer = await downloadAttachment(client, messageId, key, 'image');
        results.push({ buffer, placeholder: '<media:image>' });
      } catch {
        // Skip images that fail to download individually
      }
    }
    return results;
  }

  return [];
}

// ── Parsed message ────────────────────────────────────────────

export type ParsedMessage = {
  messageId: string;
  text: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadRootId?: string;
  senderOpenId: string;
  senderName?: string;
  mentionedBot: boolean;
  attachments: MediaDownload[];
};

// ── Main processing function ──────────────────────────────────

export async function parseMessage(
  event: RawMessageEvent,
  creds: BotCredentials,
  opts: { botOpenId?: string; groupAutoReply?: string[] } = {}
): Promise<ParsedMessage | null> {
  const msgId = event.message.message_id;
  if (!markSeen(msgId)) return null;

  const chatId = event.message.chat_id;
  const chatType = event.message.chat_type;
  const threadRootId = event.message.thread_id;
  const senderOpenId = event.sender.sender_id.open_id ?? '';
  const mentionedBot = isBotMentioned(event, opts.botOpenId);
  const isAutoReplyGroup = opts.groupAutoReply?.includes(chatId) ?? false;

  log.info(
    `Message ${msgId}: chatId=${chatId}, chatType=${chatType}, mentioned=${mentionedBot}, autoReply=${isAutoReplyGroup}`
  );

  // In group chats, only respond when @mentioned or in an auto-reply group
  if (chatType === 'group' && !mentionedBot && !isAutoReplyGroup) return null;

  const client = getHttpClient(creds);
  const rawText = extractText(event.message.content, event.message.message_type);

  if (new Set(['/clear', '/new', 'status', '/restart', '/help']).has(rawText.trim()))
    return {
      messageId: msgId,
      text: rawText.trim(),
      chatId,
      chatType,
      threadRootId,
      senderOpenId,
      senderName: undefined,
      mentionedBot,
      attachments: [],
    };

  const attachments = await fetchAttachments(
    client,
    msgId,
    event.message.message_type,
    event.message.content
  );
  log.info(`Message ${msgId}: attachments=${JSON.stringify(attachments)}`);

  // Fetch quoted/parent message content
  let quotedText: string | undefined;
  const parentId = event.message.parent_id;
  if (parentId) {
    try {
      const res = await (
        client as unknown as {
          im: {
            message: {
              get: (opts: { path: { message_id: string } }) => Promise<Record<string, unknown>>;
            };
          };
        }
      ).im.message.get({ path: { message_id: parentId } });
      log.info(`Message ${msgId}: parentId=${parentId}, res=${JSON.stringify(res)}`);

      const items = (res?.['data'] as Record<string, unknown>)?.['items'] as
        | Array<Record<string, unknown>>
        | undefined;
      const item = items?.[0];
      if (item) {
        const rawContent = ((item['body'] as Record<string, unknown>)?.['content'] as string) ?? '';
        quotedText = extractText(rawContent, item['msg_type'] as string);
      }
    } catch {
      /* skip */
    }
  }

  // Build the final text for the agent
  let text = rawText;
  if (quotedText && !isAutoReplyGroup) text = `[Replying to: "${quotedText}"]\n\n${text}`;
  if (chatType === 'group' && !isAutoReplyGroup) text = `${senderOpenId}: ${text}`;
  log.info(`Message ${msgId}: text=${text}`);

  return {
    text,
    chatId,
    chatType,
    messageId: msgId,
    threadRootId,
    senderOpenId,
    senderName: undefined,
    mentionedBot,
    attachments,
  };
}
