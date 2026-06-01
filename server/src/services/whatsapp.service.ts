import { env } from '../config/env';
import { logger } from '../config/logger';
import type { MessageType } from '../types';
import * as zapi from './zapi.service';
import * as evolution from './evolution.service';

/**
 * Facade de WhatsApp. Seleciona o provedor ativo (Z-API ou Evolution API)
 * via env.WHATSAPP_PROVIDER e expõe uma interface única de envio + um
 * parser normalizado de webhooks. O resto do sistema (dispatch, webhook
 * controller) depende apenas deste módulo, nunca dos provedores diretos.
 */

interface WhatsappProvider {
  sendText: (phone: string, message: string) => Promise<string | null>;
  sendAudio: (phone: string, audioUrl: string) => Promise<string | null>;
  sendImage: (phone: string, imageUrl: string, caption?: string) => Promise<string | null>;
  sendImages: (phone: string, imageUrls: string[], caption?: string) => Promise<Array<string | null>>;
  markAsRead: (phone: string, messageId: string) => Promise<string | null>;
}

const provider: WhatsappProvider = env.WHATSAPP_PROVIDER === 'evolution' ? evolution : zapi;

logger.info(`Provedor de WhatsApp ativo: ${env.WHATSAPP_PROVIDER}`);

export const sendText = provider.sendText;
export const sendAudio = provider.sendAudio;
export const sendImage = provider.sendImage;
export const sendImages = provider.sendImages;
export const markAsRead = provider.markAsRead;

// ---------------------------------------------------------------------------
// Parsing normalizado dos webhooks de entrada
// ---------------------------------------------------------------------------

export interface NormalizedInbound {
  phone: string;
  text: string;
  type: MessageType;
  messageId: string | null;
  senderName: string | null;
  fromMe: boolean;
  /** URL pública do áudio recebido (quando o provedor disponibiliza). */
  mediaUrl?: string | null;
  /** Áudio recebido em base64 (ex.: Evolution com base64 ativo). */
  mediaBase64?: string | null;
}

export interface NormalizedStatus {
  ids: string[];
  status: 'READ' | 'DELIVERED';
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Extrai uma atualização de status (entrega/leitura), se houver. */
export function parseStatusUpdate(body: Record<string, unknown>): NormalizedStatus | null {
  if (env.WHATSAPP_PROVIDER === 'evolution') {
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

/** Extrai uma mensagem recebida normalizada, ou null se não for suportada. */
export function parseInbound(body: Record<string, unknown>): NormalizedInbound | null {
  if (env.WHATSAPP_PROVIDER === 'evolution') {
    return parseEvolutionInbound(body);
  }
  return parseZapiInbound(body);
}

function parseZapiInbound(body: Record<string, unknown>): NormalizedInbound | null {
  const phone = body.phone as string | undefined;
  if (!phone) return null;

  const fromMe = Boolean(body.fromMe);
  const text = body.text as { message?: string } | undefined;
  const image = body.image as { caption?: string } | undefined;
  const audio = body.audio as { audioUrl?: string; url?: string } | undefined;

  let type: MessageType = 'text';
  let content = '';
  let mediaUrl: string | null = null;
  if (text?.message) {
    type = 'text';
    content = text.message;
  } else if (image) {
    type = 'image';
    content = image.caption ?? '[imagem]';
  } else if (audio) {
    type = 'audio';
    content = '[áudio]';
    mediaUrl = audio.audioUrl ?? audio.url ?? null;
  } else {
    return null;
  }

  return {
    phone: onlyDigits(phone),
    text: content,
    type,
    messageId: (body.messageId as string | undefined) ?? null,
    senderName: (body.senderName as string | undefined) ?? null,
    fromMe,
    mediaUrl,
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
      imageMessage?: { caption?: string };
      audioMessage?: { url?: string };
      base64?: string;
    };
  };

  const remoteJid = data.key?.remoteJid;
  if (!remoteJid) return null;
  // Ignora grupos (jid termina com @g.us).
  if (remoteJid.endsWith('@g.us')) return null;

  const message = data.message ?? {};
  let type: MessageType = 'text';
  let content = '';
  let mediaUrl: string | null = null;
  let mediaBase64: string | null = null;
  if (message.conversation || message.extendedTextMessage?.text) {
    type = 'text';
    content = message.conversation ?? message.extendedTextMessage?.text ?? '';
  } else if (message.imageMessage) {
    type = 'image';
    content = message.imageMessage.caption ?? '[imagem]';
  } else if (message.audioMessage) {
    type = 'audio';
    content = '[áudio]';
    // O url do WhatsApp é criptografado; só serve se a Evolution já entregar
    // o áudio decriptado. Quando configurada com base64, usamos o base64.
    mediaUrl = message.audioMessage.url ?? null;
    mediaBase64 = data.base64 ?? message.base64 ?? null;
  } else {
    return null;
  }

  return {
    phone: onlyDigits(remoteJid.split('@')[0]),
    text: content,
    type,
    messageId: data.key?.id ?? null,
    senderName: data.pushName ?? null,
    fromMe: Boolean(data.key?.fromMe),
    mediaUrl,
    mediaBase64,
  };
}
