import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import type { MessageType } from '../types';
import * as zapi from './zapi.service';
import * as evolution from './evolution.service';
import {
  createMetaCloudProvider,
  parseMetaCloudInbound,
  parseMetaCloudStatus,
  type MetaCloudConnection,
} from './whatsapp/metacloud.service';
import type {
  NormalizedInbound,
  NormalizedStatus,
  ProviderStatus,
  WhatsAppProvider,
} from './whatsapp/types';
import {
  getConnectionById,
  getConnectionByTenant,
  type WhatsappConnection,
  type WhatsappProviderName,
} from '../db/queries/whatsapp_connections';

export type { NormalizedInbound, NormalizedStatus, ProviderStatus, WhatsAppProvider };

/**
 * Facade de WhatsApp MULTI-TENANT + MULTI-INSTÂNCIA. Cada empresa pode ter N
 * conexões (Z-API / Evolution / Meta). `getWhatsappByConnection` resolve uma
 * instância específica; `getTenantWhatsapp` usa a primeira ativa (legado /
 * health / lembretes sem contexto de conexão).
 */

const ZAPI_DEFAULT_BASE = 'https://api.z-api.io/instances';

logger.info(`Provedor de WhatsApp padrao (.env): ${env.WHATSAPP_PROVIDER}`);

// ---------------------------------------------------------------------------
// Resolucao da conexao por tenant (DB ou .env de fallback) com cache curto
// ---------------------------------------------------------------------------

interface ResolvedConnection {
  provider: WhatsappProviderName;
  zapi?: zapi.ZapiConnection;
  evolution?: evolution.EvolutionConnection;
  metacloud?: MetaCloudConnection;
}

function resolveFromDb(conn: WhatsappConnection): ResolvedConnection {
  if (conn.provider === 'evolution') {
    return {
      provider: 'evolution',
      evolution: {
        apiKey: conn.secrets.apiKey ?? '',
        instance: conn.secrets.instance ?? '',
        baseUrl: conn.base_url ?? env.EVOLUTION_BASE_URL,
      },
    };
  }
  if (conn.provider === 'metacloud') {
    return {
      provider: 'metacloud',
      metacloud: {
        accessToken: conn.secrets.accessToken ?? '',
        phoneNumberId: conn.secrets.phoneNumberId ?? '',
        graphBaseUrl: conn.base_url ?? undefined,
        verifyToken: conn.secrets.verifyToken,
      },
    };
  }
  return {
    provider: 'zapi',
    zapi: {
      instanceId: conn.secrets.instanceId ?? '',
      token: conn.secrets.token ?? '',
      clientToken: conn.secrets.clientToken,
      baseUrl: conn.base_url ?? ZAPI_DEFAULT_BASE,
    },
  };
}

/** Conexao a partir do .env (continuidade do tenant padrao). */
function resolveFromEnv(): ResolvedConnection | null {
  if (env.WHATSAPP_PROVIDER === 'evolution') {
    if (!env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) return null;
    return {
      provider: 'evolution',
      evolution: {
        apiKey: env.EVOLUTION_API_KEY,
        instance: env.EVOLUTION_INSTANCE,
        baseUrl: env.EVOLUTION_BASE_URL,
      },
    };
  }
  if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_TOKEN) return null;
  return {
    provider: 'zapi',
    zapi: {
      instanceId: env.ZAPI_INSTANCE_ID,
      token: env.ZAPI_TOKEN,
      clientToken: env.ZAPI_CLIENT_TOKEN,
      baseUrl: env.ZAPI_BASE_URL,
    },
  };
}

const cache = new Map<string, { at: number; resolved: ResolvedConnection | null }>();
const CACHE_TTL_MS = 30_000;

function cacheKey(tenantId: string, connectionId?: string | null): string {
  return connectionId ? `${tenantId}:c:${connectionId}` : `${tenantId}:default`;
}

/** Limpa o cache da conexao de um tenant (chamar apos salvar credenciais). */
export function invalidateTenantWhatsapp(tenantId: string, connectionId?: string | null): void {
  if (connectionId) {
    cache.delete(cacheKey(tenantId, connectionId));
    cache.delete(cacheKey(tenantId));
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) cache.delete(key);
  }
}

async function resolveForTenant(
  tenantId: string,
  connectionId?: string | null,
): Promise<ResolvedConnection | null> {
  const key = cacheKey(tenantId, connectionId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.resolved;

  let conn: WhatsappConnection | null = null;
  if (connectionId) {
    conn = await getConnectionById(tenantId, connectionId);
  } else {
    conn = await getConnectionByTenant(tenantId);
  }
  let resolved: ResolvedConnection | null = conn && conn.is_active ? resolveFromDb(conn) : null;
  // Continuidade: tenant padrao sem conexao no banco usa as credenciais do .env.
  if (!resolved && !connectionId && tenantId === DEFAULT_TENANT_ID) resolved = resolveFromEnv();

  cache.set(key, { at: Date.now(), resolved });
  return resolved;
}

// ---------------------------------------------------------------------------
// Interface de envio vinculada a uma empresa
// ---------------------------------------------------------------------------

/** Facade por tenant/conexão: WhatsAppProvider + metadados de configuração. */
export interface TenantWhatsapp extends WhatsAppProvider {
  provider: WhatsappProviderName;
  configured: boolean;
  connectionId: string | null;
}

function build(resolved: ResolvedConnection | null, connectionId: string | null): TenantWhatsapp {
  if (resolved?.provider === 'metacloud' && resolved.metacloud) {
    const c = resolved.metacloud;
    const provider = createMetaCloudProvider(c);
    return {
      provider: 'metacloud',
      configured: Boolean(c.accessToken && c.phoneNumberId),
      connectionId,
      ...provider,
    };
  }
  if (resolved?.provider === 'evolution' && resolved.evolution) {
    const c = resolved.evolution;
    return {
      provider: 'evolution',
      configured: Boolean(c.apiKey && c.instance),
      connectionId,
      sendText: (phone, message) => evolution.sendText(c, phone, message),
      sendAudio: (phone, audioUrl) => evolution.sendAudio(c, phone, audioUrl),
      sendImage: (phone, imageUrl, caption) => evolution.sendImage(c, phone, imageUrl, caption),
      sendImages: (phone, imageUrls, caption) => evolution.sendImages(c, phone, imageUrls, caption),
      markAsRead: (phone, messageId) => evolution.markAsRead(c, phone, messageId),
      getConnectionStatus: () => evolution.getConnectionStatus(c),
    };
  }
  // Z-API (padrao). Sem conexao resolvida, monta uma vazia: o envio cai no modo
  // simulado e o status reporta "nao configurada".
  const c: zapi.ZapiConnection = resolved?.zapi ?? {
    instanceId: '',
    token: '',
    baseUrl: ZAPI_DEFAULT_BASE,
  };
  return {
    provider: 'zapi',
    configured: Boolean(c.instanceId && c.token),
    connectionId,
    sendText: (phone, message) => zapi.sendText(c, phone, message),
    sendAudio: (phone, audioUrl) => zapi.sendAudio(c, phone, audioUrl),
    sendImage: (phone, imageUrl, caption) => zapi.sendImage(c, phone, imageUrl, caption),
    sendImages: (phone, imageUrls, caption) => zapi.sendImages(c, phone, imageUrls, caption),
    markAsRead: (phone, messageId) => zapi.markAsRead(c, phone, messageId),
    getConnectionStatus: () => zapi.getConnectionStatus(c),
    configureWebhook: (url) => zapi.configureWebhooks(c, url),
    deleteMessage: (phone, messageId, owner, deleteForMe) =>
      zapi.deleteMessage(c, phone, messageId, owner, deleteForMe),
    editText: (phone, messageId, message) => zapi.editText(c, phone, messageId, message),
  };
}

/** Resolve o WhatsApp da empresa (primeira conexão ativa, ou .env). */
export async function getTenantWhatsapp(tenantId: string): Promise<TenantWhatsapp> {
  const conn = await getConnectionByTenant(tenantId);
  const resolved = await resolveForTenant(tenantId, conn?.id);
  return build(resolved, conn?.id ?? null);
}

/** Resolve uma instância específica da empresa. */
export async function getWhatsappByConnection(
  tenantId: string,
  connectionId: string,
): Promise<TenantWhatsapp> {
  const resolved = await resolveForTenant(tenantId, connectionId);
  return build(resolved, connectionId);
}

/**
 * Resolve WhatsApp pela conversa (connection_id) com fallback para a primeira
 * conexão da empresa — usado no dispatch de respostas.
 */
export async function getWhatsappForConversation(
  tenantId: string,
  connectionId: string | null | undefined,
): Promise<TenantWhatsapp> {
  if (connectionId) return getWhatsappByConnection(tenantId, connectionId);
  return getTenantWhatsapp(tenantId);
}

// ---------------------------------------------------------------------------
// Parsing normalizado dos webhooks de entrada (por provedor)
// ---------------------------------------------------------------------------

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function stripLidSuffix(value: string): string {
  return value.replace(/@lid$/i, '').trim();
}

/** Extrai dígitos do @lid (chatLid / senderLid / phone com sufixo). */
function extractZapiLid(body: Record<string, unknown>): string | null {
  for (const key of ['chatLid', 'senderLid'] as const) {
    const raw = body[key];
    if (typeof raw === 'string' && raw.trim()) {
      const digits = onlyDigits(stripLidSuffix(raw));
      if (digits) return digits;
    }
  }
  const phoneRaw = typeof body.phone === 'string' ? body.phone : '';
  if (phoneRaw.toLowerCase().includes('@lid')) {
    const digits = onlyDigits(stripLidSuffix(phoneRaw));
    return digits || null;
  }
  return null;
}

function detectPhoneIsLid(phoneDigits: string, lid: string | null, phoneRaw: string): boolean {
  if (phoneRaw.toLowerCase().includes('@lid')) return true;
  if (lid && phoneDigits === lid) return true;
  // LIDs costumam ter 14+ dígitos; E.164 BR fica em 12–13 (55…).
  if (phoneDigits.length >= 14 && !phoneDigits.startsWith('55')) return true;
  if (phoneDigits.length >= 15) return true;
  return false;
}

/** Extrai uma atualizacao de status (entrega/leitura), se houver. */
export function parseStatusUpdate(
  provider: WhatsappProviderName,
  body: Record<string, unknown>,
): NormalizedStatus | null {
  if (provider === 'metacloud') {
    return parseMetaCloudStatus(body);
  }
  if (provider === 'evolution') {
    // Evolution: event "messages.update" com data.status (READ/DELIVERY_ACK...)
    const event = String(body.event ?? '');
    if (event !== 'messages.update') return null;
    const data = (body.data ?? {}) as { keyId?: string; key?: { id?: string }; status?: string };
    const id = data.keyId ?? data.key?.id;
    if (!id) return null;
    const status = String(data.status ?? '').toUpperCase();
    return { ids: [id], status: status.includes('READ') ? 'READ' : 'DELIVERED' };
  }

  // Z-API: { status: 'READ' | 'RECEIVED' | ..., ids: [...] }
  const status = body.status as string | undefined;
  const ids = body.ids as string[] | undefined;
  if (!status || !Array.isArray(ids) || ids.length === 0) return null;
  return { ids, status: status.toUpperCase() === 'READ' ? 'READ' : 'DELIVERED' };
}

/** Extrai uma mensagem recebida normalizada, ou null se nao for suportada. */
export function parseInbound(
  provider: WhatsappProviderName,
  body: Record<string, unknown>,
): NormalizedInbound | null {
  if (provider === 'metacloud') {
    return parseMetaCloudInbound(body);
  }
  if (provider === 'evolution') {
    return parseEvolutionInbound(body);
  }
  return parseZapiInbound(body);
}

function parseZapiInbound(body: Record<string, unknown>): NormalizedInbound | null {
  // Atendimento 1:1 — grupos não entram no fluxo da IA (filtro no app, não na Z-API).
  if (body.isGroup === true || body.isGroupMsg === true) return null;
  const phoneRaw = body.phone as string | undefined;
  if (!phoneRaw) return null;
  if (String(phoneRaw).includes('@g.us') || String(phoneRaw).endsWith('-group')) return null;

  const fromMe = Boolean(body.fromMe);
  const text = body.text as { message?: string } | undefined;
  const image = body.image as { imageUrl?: string; caption?: string; mimeType?: string } | undefined;
  const audio = body.audio as { audioUrl?: string; url?: string; mimeType?: string } | undefined;
  const video = body.video as { videoUrl?: string; caption?: string; mimeType?: string } | undefined;
  const sticker = body.sticker as
    | { stickerUrl?: string; url?: string; mimeType?: string }
    | undefined;
  const document = body.document as
    | { documentUrl?: string; fileName?: string; title?: string; mimeType?: string; caption?: string }
    | undefined;

  let type: MessageType = 'text';
  let content = '';
  let mediaUrl: string | null = null;
  let mediaMime: string | null = null;
  let fileName: string | null = null;
  if (text?.message) {
    type = 'text';
    content = text.message;
  } else if (sticker) {
    // Figurinha (estática ou animada WebP) — tratamos como imagem no painel.
    type = 'image';
    content = '';
    mediaUrl = sticker.stickerUrl ?? sticker.url ?? null;
    mediaMime = sticker.mimeType ?? 'image/webp';
    fileName = 'sticker.webp';
  } else if (image) {
    type = 'image';
    content = image.caption ?? '';
    mediaUrl = image.imageUrl ?? null;
    mediaMime = image.mimeType ?? null;
  } else if (video) {
    type = 'video';
    content = video.caption ?? '';
    mediaUrl = video.videoUrl ?? null;
    mediaMime = video.mimeType ?? null;
  } else if (audio) {
    type = 'audio';
    content = '';
    mediaUrl = audio.audioUrl ?? audio.url ?? null;
    mediaMime = audio.mimeType ?? null;
  } else if (document) {
    type = 'document';
    fileName = document.fileName ?? document.title ?? null;
    content = document.caption ?? fileName ?? '';
    mediaUrl = document.documentUrl ?? null;
    mediaMime = document.mimeType ?? null;
  } else {
    return null;
  }

  const phone = onlyDigits(stripLidSuffix(phoneRaw));
  const lid = extractZapiLid(body) || (detectPhoneIsLid(phone, null, phoneRaw) ? phone : null);
  const phoneIsLid = detectPhoneIsLid(phone, lid, phoneRaw);

  return {
    phone,
    lid,
    phoneIsLid,
    text: content,
    type,
    providerMessageId: (body.messageId as string | undefined) ?? null,
    senderName: (body.senderName as string | undefined) ?? (body.chatName as string | undefined) ?? null,
    fromMe,
    mediaUrl,
    mediaMime,
    fileName,
    caption: content || null,
    raw: body,
  };
}

function parseEvolutionInbound(body: Record<string, unknown>): NormalizedInbound | null {
  const event = String(body.event ?? '');
  if (event && event !== 'messages.upsert') return null;

  const data = (body.data ?? {}) as {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    pushName?: string;
    base64?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string; mimetype?: string; url?: string };
      stickerMessage?: { mimetype?: string; url?: string; isAnimated?: boolean };
      videoMessage?: { caption?: string; mimetype?: string; url?: string };
      audioMessage?: { url?: string; mimetype?: string };
      documentMessage?: { caption?: string; mimetype?: string; fileName?: string; title?: string; url?: string };
      base64?: string;
    };
  };

  const remoteJid = data.key?.remoteJid;
  if (!remoteJid) return null;
  // Ignora grupos (jid termina com @g.us).
  if (remoteJid.endsWith('@g.us')) return null;

  const message = data.message ?? {};
  // A Evolution entrega a midia decriptada em base64 (quando configurada assim);
  // o url do Baileys e criptografado e em geral nao serve direto.
  const base64 = data.base64 ?? message.base64 ?? null;
  let type: MessageType = 'text';
  let content = '';
  let mediaUrl: string | null = null;
  let mediaBase64: string | null = null;
  let mediaMime: string | null = null;
  let fileName: string | null = null;
  if (message.conversation || message.extendedTextMessage?.text) {
    type = 'text';
    content = message.conversation ?? message.extendedTextMessage?.text ?? '';
  } else if (message.stickerMessage) {
    type = 'image';
    content = '';
    mediaUrl = message.stickerMessage.url ?? null;
    mediaBase64 = base64;
    mediaMime = message.stickerMessage.mimetype ?? 'image/webp';
    fileName = 'sticker.webp';
  } else if (message.imageMessage) {
    type = 'image';
    content = message.imageMessage.caption ?? '';
    mediaUrl = message.imageMessage.url ?? null;
    mediaBase64 = base64;
    mediaMime = message.imageMessage.mimetype ?? null;
  } else if (message.videoMessage) {
    type = 'video';
    content = message.videoMessage.caption ?? '';
    mediaUrl = message.videoMessage.url ?? null;
    mediaBase64 = base64;
    mediaMime = message.videoMessage.mimetype ?? null;
  } else if (message.audioMessage) {
    type = 'audio';
    content = '';
    mediaUrl = message.audioMessage.url ?? null;
    mediaBase64 = base64;
    mediaMime = message.audioMessage.mimetype ?? null;
  } else if (message.documentMessage) {
    type = 'document';
    fileName = message.documentMessage.fileName ?? message.documentMessage.title ?? null;
    content = message.documentMessage.caption ?? fileName ?? '';
    mediaUrl = message.documentMessage.url ?? null;
    mediaBase64 = base64;
    mediaMime = message.documentMessage.mimetype ?? null;
  } else {
    return null;
  }

  const jidUser = remoteJid.split('@')[0] ?? '';
  const isLidJid = remoteJid.includes('@lid') || remoteJid.endsWith('@lid');
  const phone = onlyDigits(jidUser);
  return {
    phone,
    lid: isLidJid ? phone : null,
    phoneIsLid: isLidJid,
    text: content,
    type,
    providerMessageId: data.key?.id ?? null,
    senderName: data.pushName ?? null,
    fromMe: Boolean(data.key?.fromMe),
    mediaUrl,
    mediaBase64,
    mediaMime,
    fileName,
    caption: content || null,
    raw: body,
  };
}
