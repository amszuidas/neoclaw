/**
 * Feishu message sending utilities.
 *
 * Two card formats are used:
 *
 * 1. Non-streaming (JSON 2.0, direct send):
 *      schema: "2.0"
 *      config: { wide_screen_mode: true }
 *      body.elements: [ collapsible_panel?, markdown, hr?, markdown(stats)? ]
 *    Sent directly as msg_type "interactive" with content = card JSON string.
 *
 * 2. Streaming (JSON 2.0, requires cardkit API):
 *      schema: "2.0"
 *      config: { streaming_mode: true, ... }
 *      body.elements: [ markdown (main), div (loading) ]
 *    Steps panel inserted dynamically on first thinking/tool event.
 *    Created via cardkit.v1.card.create → card_id reference sent in message.
 *    Content updated progressively via cardkit.v1.cardElement.content.
 *    Streaming closed via cardkit.v1.card.settings({ streaming_mode: false }).
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { AskQuestion } from '@neoclaw/core';
import { logger } from '@neoclaw/core/utils/logger';
import type { SendResult } from './client.js';
import { idType } from './client.js';

const log = logger('sender');

// ── Card JSON 2.0 element types ───────────────────────────────

type MarkdownEl = { tag: 'markdown'; content: string };
type HrEl = { tag: 'hr' };
type PlainTextEl = {
  tag: 'plain_text';
  content: string;
  text_size?: string;
  text_color?: string;
};
type StandardIconEl = {
  tag: 'standard_icon';
  token: string;
  color?: string;
};
type DivEl = {
  tag: 'div';
  icon?: StandardIconEl;
  text?: PlainTextEl;
};
type CollapsiblePanel = {
  tag: 'collapsible_panel';
  expanded: boolean;
  border?: { color?: string; corner_radius?: string };
  vertical_spacing?: string;
  header: {
    title: PlainTextEl;
    icon?: StandardIconEl;
    icon_position?: string;
    icon_expanded_angle?: number;
  };
  elements: CardElement[];
};
type CardElement = MarkdownEl | HrEl | CollapsiblePanel | DivEl;

// ── Tool step formatting ─────────────────────────────────────

type ToolStepInfo = { text: string; icon: string };

/** Map a tool_use event to a human-readable description and Feishu standard icon. */
export function formatToolStep(name: string, input: unknown): ToolStepInfo {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'Agent':
    case 'Task':
      return { text: 'Run sub-agent', icon: 'robot_outlined' };
    case 'Bash':
      return {
        text: (inp['description'] as string) ?? (inp['command'] as string) ?? 'Run command',
        icon: 'computer_outlined',
      };
    case 'Edit':
      return { text: `Edit "${inp['file_path'] ?? ''}"`, icon: 'edit_outlined' };
    case 'Glob':
      return {
        text: `Search files by pattern "${inp['pattern'] ?? ''}"`,
        icon: 'card-search_outlined',
      };
    case 'Grep':
      return {
        text: `Search text by pattern "${inp['pattern'] ?? ''}"${inp['glob'] ? ` in "${inp['glob']}"` : ''}`,
        icon: 'doc-search_outlined',
      };
    case 'Read':
      return { text: `Read file "${inp['file_path'] ?? ''}"`, icon: 'file-link-bitable_outlined' };
    case 'Write':
      return { text: `Write file "${inp['file_path'] ?? ''}"`, icon: 'edit_outlined' };
    case 'Skill':
      return { text: `Load skill "${inp['skill'] ?? ''}"`, icon: 'file-link-mindnote_outlined' };
    case 'WebFetch':
      return { text: `Fetch web page from "${inp['url'] ?? ''}"`, icon: 'language_outlined' };
    case 'WebSearch':
      return { text: `Search web for "${inp['query'] ?? ''}"`, icon: 'search_outlined' };
    case 'NotebookEdit':
      return { text: `Edit notebook "${inp['notebook'] ?? ''}"`, icon: 'edit_outlined' };
    case 'LSP':
      return {
        text: `LSP ${(inp['command'] as string) ?? 'action'}`,
        icon: 'setting-inter_outlined',
      };
    case 'TodoRead':
    case 'TodoWrite':
      return { text: name === 'TodoRead' ? 'Read todos' : 'Update todos', icon: 'list_outlined' };
    case 'ToolSearch':
      return { text: `Search tools for "${inp['query'] ?? ''}"`, icon: 'search_outlined' };
    default:
      return { text: name, icon: 'setting-inter_outlined' };
  }
}

/** Build a DivElement (icon + text) for a step inside the collapsible panel. */
export function buildStepDiv(
  text: string,
  iconToken: string,
  elementId?: string
): Record<string, unknown> {
  return {
    tag: 'div',
    ...(elementId ? { element_id: elementId } : {}),
    icon: { tag: 'standard_icon', token: iconToken, color: 'grey' },
    text: { tag: 'plain_text', text_color: 'grey', text_size: 'notation', content: text },
  };
}

// ── Card builder ──────────────────────────────────────────────

/** Build a Feishu Card JSON 2.0 object for an agent response (non-streaming). */
export function buildCard(opts: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): Record<string, unknown> {
  const elements: CardElement[] = [];

  if (opts.thinking) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      border: { color: 'grey-300', corner_radius: '6px' },
      vertical_spacing: '2px',
      header: {
        title: {
          tag: 'plain_text',
          content: 'Show steps',
          text_color: 'grey',
          text_size: 'notation',
        },
        icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
        icon_position: 'right',
        icon_expanded_angle: 90,
      },
      elements: [{ tag: 'markdown', content: opts.thinking }],
    });
  }

  elements.push({ tag: 'markdown', content: opts.text });

  if (opts.stats) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `*${opts.stats}*` });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// ── Send helpers ──────────────────────────────────────────────

/** Send a message (reply or create) with given msg_type and content string. */
async function sendMessage(
  client: Lark.Client,
  target: string,
  msgType: string,
  content: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  const receiveId = target.trim();

  let res: Record<string, unknown>;
  if (opts?.replyToMessageId) {
    res = await (
      client as unknown as {
        im: {
          message: {
            reply: (opts: {
              path: { message_id: string };
              data: { msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.reply({
      path: { message_id: opts.replyToMessageId },
      data: { msg_type: msgType, content },
    });
  } else {
    res = await (
      client as unknown as {
        im: {
          message: {
            create: (opts: {
              params: { receive_id_type: string };
              data: { receive_id: string; msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.create({
      params: { receive_id_type: idType(receiveId) },
      data: { receive_id: receiveId, msg_type: msgType, content },
    });
  }

  if (res['code'] !== 0) {
    throw new Error(`Feishu send failed (code ${res['code']}): ${res['msg'] ?? ''}`);
  }
  const messageId =
    ((res['data'] as Record<string, unknown>)?.['message_id'] as string) ?? 'unknown';
  return { messageId, chatId: receiveId };
}

/** Send an interactive card to a chat or as a reply. */
export async function sendCard(
  client: Lark.Client,
  target: string,
  card: Record<string, unknown>,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  const content = JSON.stringify(card);
  log.info(`Sending card to ${target}: ${content.slice(0, 200)}...`);
  return sendMessage(client, target, 'interactive', content, opts);
}

/** Upload an image and return its image_key for message sending. */
export async function uploadImage(
  client: Lark.Client,
  image: Buffer,
  opts?: { fileName?: string; mimeType?: string }
): Promise<string> {
  void opts?.fileName;
  void opts?.mimeType;

  const res = await (
    client as unknown as {
      im: {
        image: {
          create: (opts: {
            data: { image_type: 'message'; image: Buffer };
          }) => Promise<Record<string, unknown>>;
        };
      };
    }
  ).im.image.create({
    data: {
      image_type: 'message',
      image,
    },
  });

  const imageKey =
    (res['image_key'] as string | undefined) ??
    ((res['data'] as Record<string, unknown> | undefined)?.['image_key'] as string | undefined);
  if (!imageKey) {
    throw new Error('Feishu image upload succeeded but no image_key returned');
  }
  return imageKey;
}

/** Send an image message using an existing image_key. */
export async function sendImageByKey(
  client: Lark.Client,
  target: string,
  imageKey: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  return sendMessage(client, target, 'image', JSON.stringify({ image_key: imageKey }), opts);
}

/** Upload image bytes then send as a real image message. */
export async function sendImageFromBuffer(
  client: Lark.Client,
  target: string,
  image: Buffer,
  opts?: { replyToMessageId?: string; fileName?: string; mimeType?: string }
): Promise<SendResult> {
  const imageKey = await uploadImage(client, image, {
    fileName: opts?.fileName,
    mimeType: opts?.mimeType,
  });
  return sendImageByKey(client, target, imageKey, { replyToMessageId: opts?.replyToMessageId });
}

// function detectImageMime(buf: Buffer): string {
//   if (buf.length >= 8) {
//     // PNG
//     if (
//       buf[0] === 0x89 &&
//       buf[1] === 0x50 &&
//       buf[2] === 0x4e &&
//       buf[3] === 0x47 &&
//       buf[4] === 0x0d &&
//       buf[5] === 0x0a &&
//       buf[6] === 0x1a &&
//       buf[7] === 0x0a
//     )
//       return 'image/png';
//     // GIF
//     if (
//       buf[0] === 0x47 &&
//       buf[1] === 0x49 &&
//       buf[2] === 0x46 &&
//       buf[3] === 0x38 &&
//       (buf[4] === 0x37 || buf[4] === 0x39) &&
//       buf[5] === 0x61
//     )
//       return 'image/gif';
//     // WebP (RIFF....WEBP)
//     if (
//       buf.length >= 12 &&
//       buf[0] === 0x52 &&
//       buf[1] === 0x49 &&
//       buf[2] === 0x46 &&
//       buf[3] === 0x46 &&
//       buf[8] === 0x57 &&
//       buf[9] === 0x45 &&
//       buf[10] === 0x42 &&
//       buf[11] === 0x50
//     )
//       return 'image/webp';
//   }
//   // JPEG
//   if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
//   return 'application/octet-stream';
// }

// ── Streaming card (JSON 2.0, requires cardkit API) ───────────

/** Element IDs used in streaming cards — must be globally unique within the card. */
export const STREAM_EL = {
  stepsPanel: 'steps_panel',
  mainMd: 'main_md',
  loadingDiv: 'loading_div',
  statsHr: 'stats_hr',
  statsNote: 'stats_note',
} as const;

/**
 * Build the initial Feishu Card JSON 2.0 object for a streaming response.
 * Starts with just the main markdown and a loading indicator.
 * The steps panel is inserted dynamically when thinking/tool events arrive.
 */
export function buildStreamingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 5 },
        print_strategy: 'delay',
      },
      enable_forward: true,
      width_mode: 'fill',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: STREAM_EL.mainMd, content: '' },
        buildStepDiv('', 'more_outlined', STREAM_EL.loadingDiv),
      ],
    },
  };
}

/**
 * Insert the steps collapsible panel BEFORE the main content element.
 * Call this once when the first thinking_delta or tool_use arrives.
 * The first step element is included inside the panel (no placeholder needed).
 * Styled with border, grey header, right arrow icon (agentara-style).
 */
export async function insertStepsPanel(
  client: Lark.Client,
  cardId: string,
  firstElement: Record<string, unknown>,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.create({
    path: { card_id: cardId },
    data: {
      type: 'insert_before',
      target_element_id: STREAM_EL.mainMd,
      elements: JSON.stringify([
        {
          tag: 'collapsible_panel',
          element_id: STREAM_EL.stepsPanel,
          expanded: true,
          border: { color: 'grey-300', corner_radius: '6px' },
          vertical_spacing: '2px',
          header: {
            title: {
              tag: 'plain_text',
              text_color: 'grey',
              text_size: 'notation',
              content: 'Working on it',
            },
            icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
            icon_position: 'right',
            icon_expanded_angle: 90,
          },
          elements: [firstElement],
        },
      ]),
      sequence,
    },
  });
  if (res.code !== 0) {
    throw new Error(`insertStepsPanel failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/**
 * Append a step DivElement inside the steps panel after a target element.
 * Used to add steps (thinking or tool) after the previous step in the panel.
 */
export async function appendStepToPanel(
  client: Lark.Client,
  cardId: string,
  step: Record<string, unknown>,
  afterElementId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.create({
    path: { card_id: cardId },
    data: {
      type: 'insert_after',
      target_element_id: afterElementId,
      elements: JSON.stringify([step]),
      sequence,
    },
  });
  if (res.code !== 0) {
    throw new Error(`appendStepToPanel failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Update a step DivElement's text content (used for streaming thinking text). */
export async function updateStepText(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  text: string,
  sequence: number
): Promise<void> {
  await patchCardElement(
    client,
    cardId,
    elementId,
    {
      text: { tag: 'plain_text', text_color: 'grey', text_size: 'notation', content: text },
    },
    sequence
  );
}

/** Update the steps panel header title text (e.g. step count). */
export async function updatePanelHeader(
  client: Lark.Client,
  cardId: string,
  headerText: string,
  sequence: number
): Promise<void> {
  await patchCardElement(
    client,
    cardId,
    STREAM_EL.stepsPanel,
    {
      header: {
        title: {
          tag: 'plain_text',
          text_color: 'grey',
          text_size: 'notation',
          content: headerText,
        },
        icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
        icon_position: 'right',
        icon_expanded_angle: 90,
      },
    },
    sequence
  );
}

/** Create a card entity and return its card_id. */
export async function createCardEntity(
  client: Lark.Client,
  card: Record<string, unknown>
): Promise<string> {
  const res = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to create card entity (code ${res.code}): ${res.msg ?? ''}`);
  }
  const cardId = res.data?.card_id;
  if (!cardId) throw new Error('Card entity created but no card_id returned');
  return cardId;
}

/** Send a card entity (by card_id reference) as a message or reply. */
export async function sendCardByRef(
  client: Lark.Client,
  target: string,
  cardId: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  log.info(`Sending card ref ${cardId} to ${target}`);
  return sendMessage(client, target, 'interactive', content, opts);
}

/**
 * Stream-update a markdown/plain_text element content (typewriter effect).
 * Pass the FULL accumulated text on each call — the platform computes the delta.
 */
export async function updateCardText(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.content({
    path: { card_id: cardId, element_id: elementId },
    data: { content, sequence },
  });
  if (res.code !== 0) {
    throw new Error(`updateCardText failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Partially update a card element's properties (e.g. collapse a panel). */
export async function patchCardElement(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  partial: Record<string, unknown>,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.patch({
    path: { card_id: cardId, element_id: elementId },
    data: { partial_element: JSON.stringify(partial), sequence },
  });
  if (res.code !== 0) {
    throw new Error(`patchCardElement failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Delete a card element by ID. */
export async function deleteCardElement(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.delete({
    path: { card_id: cardId, element_id: elementId },
    data: { sequence },
  });
  if (res.code !== 0) {
    throw new Error(`deleteCardElement failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Append one or more elements after a target element (or at the end of the card). */
export async function appendCardElements(
  client: Lark.Client,
  cardId: string,
  elements: Record<string, unknown>[],
  sequence: number,
  afterElementId?: string
): Promise<void> {
  const payload: Parameters<typeof client.cardkit.v1.cardElement.create>[0] = {
    path: { card_id: cardId },
    data: {
      type: afterElementId ? 'insert_after' : 'append',
      target_element_id: afterElementId,
      elements: JSON.stringify(elements),
      sequence,
    },
  };
  const res = await client.cardkit.v1.cardElement.create(payload);
  if (res.code !== 0) {
    throw new Error(`appendCardElements failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Close streaming mode for a card (re-enables forwarding and interactions). */
export async function closeCardStreaming(
  client: Lark.Client,
  cardId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: {
      settings: JSON.stringify({ config: { streaming_mode: false } }),
      sequence,
    },
  });
  if (res.code !== 0) {
    throw new Error(`closeCardStreaming failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

// ── Non-streaming send helpers ────────────────────────────────

/** Convenience wrapper: send a plain markdown text as a simple interactive card. */
export async function sendMarkdown(
  client: Lark.Client,
  target: string,
  text: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  return sendCard(client, target, buildCard({ text }), opts);
}

// ── Reaction helpers ──────────────────────────────────────────

/** Add an emoji reaction to a message. Returns the reaction ID, or null on failure. */
export async function addReaction(
  client: Lark.Client,
  messageId: string,
  emoji: string
): Promise<string | null> {
  try {
    const res = await (
      client as unknown as {
        im: {
          messageReaction: {
            create: (opts: {
              path: { message_id: string };
              data: { reaction_type: { emoji_type: string } };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    return ((res['data'] as Record<string, unknown>)?.['reaction_id'] as string) ?? null;
  } catch {
    return null;
  }
}

// ── AskUserQuestion interactive form ─────────────────────────

/**
 * Build the card elements for an AskUserQuestion form.
 * Returns an array to be appended to an existing streaming card via appendCardElements().
 *
 * Layout: hr → form(label + select_static per question + submit button)
 *
 * The submit button encodes routing context in its callback value so the
 * card.action.trigger handler knows which chat/thread to reply to.
 */
export function buildQuestionFormElements(opts: {
  questions: AskQuestion[];
  chatId: string;
  threadRootId?: string;
}): Record<string, unknown>[] {
  const { questions, chatId, threadRootId } = opts;

  const formInner: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    formInner.push({ tag: 'markdown', content: `**${i + 1}. ${q.question}**` });
    formInner.push({
      tag: 'select_static',
      name: `q${i}`,
      required: true,
      width: 'fill',
      placeholder: { tag: 'plain_text', content: '请选择...' },
      options: q.options.map((opt) => ({
        text: {
          tag: 'plain_text',
          content: opt.description ? `${opt.label}: ${opt.description}` : opt.label,
        },
        // value = label text so the callback directly carries the human-readable answer
        value: opt.label,
      })),
    });
  }

  formInner.push({
    tag: 'button',
    name: 'neoclaw_submit',
    type: 'primary_filled',
    width: 'default',
    text: { tag: 'plain_text', content: '提交' },
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          _neoclaw_action: 'questions_submit',
          _neoclaw_chat_id: chatId,
          _neoclaw_thread_id: threadRootId ?? '',
        },
      },
    ],
  });

  return [
    { tag: 'hr' },
    { tag: 'form', name: 'neoclaw_questions', vertical_spacing: '12px', elements: formInner },
  ];
}

/** Remove an emoji reaction from a message. Silently ignores errors. */
export async function removeReaction(
  client: Lark.Client,
  messageId: string,
  reactionId: string
): Promise<void> {
  try {
    await (
      client as unknown as {
        im: {
          messageReaction: {
            delete: (opts: { path: { message_id: string; reaction_id: string } }) => Promise<void>;
          };
        };
      }
    ).im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // Non-critical
  }
}
