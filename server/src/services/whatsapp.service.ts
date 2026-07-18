import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import type { MessageType } from '../types';
import * as zapi from './zapi.service';
import * as evolution from './evolution.service';
import { createMetaCloudProvider, type MetaCloudConnection } from './whatsapp/metacloud.service';
import type {
  NormalizedInbound,
  NormalizedStatus,
  ProviderStatus,
  WhatsAppProvider,
} from './whatsapp/types';
import {
  getConnectionByTenant,
  type WhatsappConnection,
  type WhatsappProviderName,
} from '../db/queries/whatsapp_connections';

export type { NormalizedInbound, NormalizedStatus, ProviderStatus, WhatsAppProvider };

/**
 * Facade de WhatsApp MULTI-TENANT. Cada empresa (tenant) tem a propria conexao
 * (instancia Z-API/Evolution), guardada no banco com credenciais cifradas.
 *
 * `getTenantWhatsapp(tenantId)` resolve a conexao do tenant (com cache curto) e
 * devolve um objeto com as funcoes de envio ja vinculadas a essa conexao. O
 * resto do sistema (dispatch, webhook) depende apenas deste modulo.
 *
 * Continuidade: o tenant padrao (operacao atual) cai nas credenciais do .env
 * quando ainda nao houver conexao cadastrada no banco.
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

/** Limpa o cache da conexao de um tenant (chamar apos salvar credenciais). */
export function invalidateTenantWhatsapp(tenantId: string): void {
  cache.delete(tenantId);
}

async function resolveForTenant(tenantId: string): Promise<ResolvedConnection | null> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.resolved;

  const conn = await getConnectionByTenant(tenantId);
  let resolved: ResolvedConnection | null = conn && conn.is_active ? resolveFromDb(conn) : null;
  // Continuidade: tenant padrao sem conexao no banco usa as credenciais do .env.
  if (!resolved && tenantId === DEFAULT_TENANT_ID) resolved = resolveFromEnv();

  cache.set(tenantId, { at: Date.now(), resolved });
  return resolved;
}

// ---------------------------------------------------------------------------
// Interface de envio vinculada a uma empresa
// ---------------------------------------------------------------------------

/** Facade por tenant: WhatsAppProvider + metadados de configuração. */
export interface TenantWhatsapp extends WhatsAppProvider {
  provider: WhatsappProviderName;
  configured: boolean;
}

function build(resolved: ResolvedConnection | null): TenantWhatsapp {
  if (resolved?.provider === 'metacloud' && resolved.metacloud) {
    const c = resolved.metacloud;
    const provider = createMetaCloudProvider(c);
    return {
      provider: 'metacloud',
      configured: Boolean(c.accessToken && c.phoneNumberId),
      ...provider,
    };
  }
  if (resolved?.provider === 'evolution' && resolved.evolution) {
    const c = resolved.evolution;
    return {
      provider: 'evolution',
      configured: Boolean(c.apiKey && c.instance),
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
    sendText: (phone, message) => zapi.sendText(c, phone, message),
    sendAudio: (phone, audioUrl) => zapi.sendAudio(c, phone, audioUrl),
    sendImage: (phone, imageUrl, caption) => zapi.sendImage(c, phone, imageUrl, caption),
    sendImages: (phone, imageUrls, caption) => zapi.sendImages(c, phone, imageUrls, caption),
    markAsRead: (phone, messageId) => zapi.markAsRead(c, phone, messageId),
    getConnectionStatus: () => zapi.getConnectionStatus(c),
  };
}

/** Resolve o WhatsApp da empresa (DB ou .env de fallback) com cache curto. */
export async function getTenantWhatsapp(tenantId: string): Promise<TenantWhatsapp> {
  const resolved = await resolveForTenant(tenantId);
  return build(resolved);
}

// ---------------------------------------------------------------------------
// Parsing normalizado dos webhooks de entrada (por provedor)
// ---------------------------------------------------------------------------

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Extrai uma atualizacao de status (entrega/leitura), se houver. */
export function parseStatusUpdate(
  provider: WhatsappProviderName,
  body: Record<string, unknown>,
): NormalizedStatus | null {
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
  if (provider === 'evolution') {
    return parseEvolutionInbound(body);
  }
  return parseZapiInbound(body);
}

function parseZapiInbound(body: Record<string, unknown>): NormalizedInbound | null {
  const phone = body.phone as string | undefined;
  if (!phone) return null;

  const fromMe = Boolean(body.fromMe);
  const text = body.text as { message?: string } | undefined;
  const image = body.image as { imageUrl?: string; caption?: string; mimeType?: string } | undefined;
  const audio = body.audio as { audioUrl?: string; url?: string; mimeType?: string } | undefined;
  const video = body.video as { videoUrl?: string; caption?: string; mimeType?: string } | undefined;
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

  return {
    phone: onlyDigits(phone),
    text: content,
    type,
    providerMessageId: (body.messageId as string | undefined) ?? null,
    senderName: (body.senderName as string | undefined) ?? null,
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

  return {
    phone: onlyDigits(remoteJid.split('@')[0]),
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
