/**
 * Feishu/Lark SDK client factory and shared type definitions.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

// ── Shared types ──────────────────────────────────────────────

export type BotDomain = 'feishu' | 'lark' | (string & {});

export type BotCredentials = {
  appId: string;
  appSecret: string;
  domain?: BotDomain;
};

/** Raw Feishu message event from the event dispatcher. */
export type RawMessageEvent = {
  sender: {
    sender_id: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    chat_id: string;
    chat_type: 'p2p' | 'group';
    content: string;
    message_id: string;
    message_type: string;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
    }>;
  };
};

export type BotInfo = {
  ok: boolean;
  error?: string;
  botOpenId?: string;
  botName?: string;
};

export type SendResult = { messageId: string; chatId: string };

export type MediaDownload = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  placeholder: string;
};

// ── Domain helpers ────────────────────────────────────────────

export function larkDomain(domain: BotDomain | undefined): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark;
  if (!domain || domain === 'feishu') return Lark.Domain.Feishu;
  return domain.replace(/\/+$/, '');
}

export function apiBaseUrl(domain?: BotDomain): string {
  if (domain === 'lark') return 'https://open.larksuite.com/open-apis';
  if (domain && domain !== 'feishu' && domain.startsWith('http')) {
    return `${domain.replace(/\/+$/, '')}/open-apis`;
  }
  return 'https://open.feishu.cn/open-apis';
}

/** Derive the receive_id_type from the ID prefix. */
export function idType(id: string): 'chat_id' | 'open_id' | 'user_id' {
  const s = id.trim();
  if (s.startsWith('oc_')) return 'chat_id';
  if (s.startsWith('ou_')) return 'open_id';
  return 'user_id';
}

// ── Client factory ────────────────────────────────────────────

// Cache a single HTTP client per (appId, domain) pair
let _http: { client: Lark.Client; key: string } | null = null;

export function getHttpClient(creds: BotCredentials): Lark.Client {
  const key = `${creds.appId}:${creds.domain ?? 'feishu'}`;
  if (_http?.key === key) return _http.client;
  const client = new Lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: larkDomain(creds.domain),
  });
  _http = { client, key };
  return client;
}

/** Create a new WebSocket client (one per connection, not cached). */
export function getWsClient(creds: BotCredentials): Lark.WSClient {
  if (!creds.appId || !creds.appSecret) throw new Error('Feishu credentials missing');
  return new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: larkDomain(creds.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}

/** Create an event dispatcher for WebSocket message decryption/verification. */
export function getEventDispatcher(creds: {
  verificationToken?: string;
  encryptKey?: string;
}): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
    verificationToken: creds.verificationToken ?? '',
    encryptKey: creds.encryptKey ?? '',
  });
}

// ── Bot info probe ─────────────────────────────────────────────

const _botInfoCache = new Map<string, { info: BotInfo; cachedAt: number }>();
const BOT_INFO_TTL_MS = 15 * 60 * 1000;

export async function fetchBotInfo(creds: BotCredentials): Promise<BotInfo> {
  if (!creds.appId || !creds.appSecret) return { ok: false, error: 'credentials missing' };

  const key = `${creds.appId}:${creds.domain ?? 'feishu'}`;
  const cached = _botInfoCache.get(key);
  if (cached && Date.now() - cached.cachedAt < BOT_INFO_TTL_MS) return cached.info;

  let info: BotInfo;
  try {
    const client = getHttpClient(creds);
    const res = await (
      client as unknown as {
        request: (opts: {
          method: string;
          url: string;
          data: object;
        }) => Promise<Record<string, unknown>>;
      }
    ).request({ method: 'GET', url: '/open-apis/bot/v3/info', data: {} });

    if (res['code'] !== 0) {
      info = { ok: false, error: `API error ${res['code']}: ${res['msg'] ?? ''}` };
    } else {
      const bot = (res['bot'] ?? (res['data'] as Record<string, unknown>)?.['bot']) as
        | Record<string, unknown>
        | undefined;
      info = {
        ok: true,
        botOpenId: bot?.['open_id'] as string | undefined,
        botName: bot?.['bot_name'] as string | undefined,
      };
    }
  } catch (err) {
    info = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  _botInfoCache.set(key, { info, cachedAt: Date.now() });
  return info;
}
