import { env } from '../config/env';
import { logger } from '../config/logger';
import { getAudioById, incrementAudioUsage } from '../db/queries/audios';
import { getScriptById, incrementScriptUsage } from '../db/queries/messages_scripts';
import { getProductById } from '../db/queries/products';
import { insertMessage } from '../db/queries/messages';
import { emitNewMessage } from '../socket';
import { renderTemplate, formatBRL } from '../utils/text';
import { signMediaToken } from '../utils/media-token';
import * as whatsapp from './whatsapp.service';
import { assertCustomerOutboundAllowed } from './outbound/safe-mode.service';
import { applySecretaryPlaybookToText } from './secretary-playbook.service';
import type { OutboundMeta } from './outbound/types';
import type { Audio, Client, Conversation, MessageLog, MessageOrigin } from '../types';

interface DispatchContext {
  conversation: Conversation;
  client: Client;
}

export type DispatchOpts = OutboundMeta & { origin?: MessageOrigin };

/** True se a URL aponta para um host EXTERNO (ex.: CDN do R2), não o backend. */
function isExternalUrl(fileUrl: string): boolean {
  try {
    return new URL(fileUrl).host !== new URL(env.PUBLIC_BASE_URL).host;
  } catch {
    return false;
  }
}

/**
 * Garante que a URL servida pelo PRÓPRIO backend use o host público atual.
 * Só se aplica a URLs do backend (/media, /uploads) — nunca reescreve uma URL
 * externa (R2/CDN), que já é permanente.
 */
function toCurrentPublicUrl(fileUrl: string): string {
  if (isExternalUrl(fileUrl)) return fileUrl;
  try {
    const current = new URL(env.PUBLIC_BASE_URL);
    const original = new URL(fileUrl);
    original.protocol = current.protocol;
    original.host = current.host;
    return original.toString();
  } catch {
    return fileUrl;
  }
}

/** URL pública estável usada para enviar/tocar o áudio. */
function audioPublicUrl(audio: Audio, tenantId: string): string {
  if (audio.has_file_data) {
    const token = signMediaToken(tenantId, audio.id);
    return `${env.PUBLIC_BASE_URL}/media/audios/${audio.id}.ogg?t=${token}`;
  }
  if (isExternalUrl(audio.file_url)) return audio.file_url;
  return toCurrentPublicUrl(audio.file_url);
}

function sendAudioToProvider(
  wa: whatsapp.TenantWhatsapp,
  phone: string,
  publicUrl: string,
): Promise<string | null> {
  return wa.sendAudio(phone, publicUrl);
}

async function guardOutbound(ctx: DispatchContext, meta: OutboundMeta): Promise<void> {
  await assertCustomerOutboundAllowed(ctx.conversation.tenant_id, meta, {
    id: ctx.client.id,
    phone: ctx.client.phone,
  });
}

/** Envia um áudio do banco para o cliente e registra no log. */
export async function dispatchAudio(
  ctx: DispatchContext,
  audioId: string,
  meta: OutboundMeta,
): Promise<MessageLog | null> {
  await guardOutbound(ctx, meta);

  const tenantId = ctx.conversation.tenant_id;
  const audio = await getAudioById(tenantId, audioId);
  if (!audio) {
    logger.warn(`Áudio ${audioId} não encontrado (a palavra-chave aponta para um áudio inexistente).`);
    return null;
  }
  if (!audio.is_active) {
    logger.warn(`Áudio "${audio.title}" (${audioId}) está INATIVO — não será enviado; caindo no fallback.`);
    return null;
  }

  const publicUrl = audioPublicUrl(audio, tenantId);

  const wa = await whatsapp.getWhatsappForConversation(tenantId, ctx.conversation.connection_id);
  let zapiId: string | null;
  try {
    zapiId = await sendAudioToProvider(wa, ctx.client.phone, publicUrl);
  } catch (err) {
    logger.error(`Falha ao enviar áudio "${audio.title}" (${audio.id}) pela Z-API`, err);
    return null;
  }

  await incrementAudioUsage(tenantId, audio.id);
  logger.info(`Áudio "${audio.title}" enviado para ${ctx.client.phone} (zapiId=${zapiId ?? 'n/d'}).`);

  const msg = await insertMessage(tenantId, {
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'audio',
    content: publicUrl,
    audioId: audio.id,
    mediaUrl: publicUrl,
    mediaMime: audio.mime_type ?? 'audio/ogg',
    transcription: audio.transcription ?? null,
    zapiMessageId: zapiId,
  });
  emitNewMessage(tenantId, ctx.conversation.id, msg);
  return msg;
}

/** Renderiza um script de texto (com variáveis) e envia. */
export async function dispatchScript(
  ctx: DispatchContext,
  scriptId: string,
  meta: OutboundMeta,
): Promise<MessageLog | null> {
  await guardOutbound(ctx, meta);

  const tenantId = ctx.conversation.tenant_id;
  const script = await getScriptById(tenantId, scriptId);
  if (!script || !script.is_active) return null;

  const text = renderTemplate(script.content, {
    client_name: ctx.client.name ?? 'tudo bem',
    company_name: ctx.client.company_name ?? '',
  });

  const wa = await whatsapp.getWhatsappForConversation(tenantId, ctx.conversation.connection_id);
  const zapiId = await wa.sendText(ctx.client.phone, text);
  await incrementScriptUsage(tenantId, script.id);

  const msg = await insertMessage(tenantId, {
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'text',
    content: text,
    zapiMessageId: zapiId,
  });
  emitNewMessage(tenantId, ctx.conversation.id, msg);
  return msg;
}

/** Envia as imagens de um produto + legenda. `withPrice: false` omite o preço. */
export async function dispatchProduct(
  ctx: DispatchContext,
  productId: string,
  opts?: { withPrice?: boolean } & OutboundMeta,
): Promise<MessageLog | null> {
  const meta: OutboundMeta = {
    sendType: opts?.sendType ?? 'proactive',
    triggeringInboundId: opts?.triggeringInboundId,
  };
  await guardOutbound(ctx, meta);

  const tenantId = ctx.conversation.tenant_id;
  const product = await getProductById(tenantId, productId);
  if (!product || !product.is_available) return null;

  const withPrice = opts?.withPrice !== false;
  const priceLine =
    withPrice && product.price_wholesale
      ? `\nPreço atacado: ${formatBRL(Number(product.price_wholesale))}`
      : '';
  const minLine = `\nPedido mínimo: ${product.min_quantity}${product.unit ? ` (${product.unit})` : ''}`;
  const caption = `*${product.name}*${product.description ? `\n${product.description}` : ''}${priceLine}${minLine}`;

  const imageUrls = product.image_urls.map(toCurrentPublicUrl);
  const wa = await whatsapp.getWhatsappForConversation(tenantId, ctx.conversation.connection_id);
  let zapiId: string | null = null;
  if (imageUrls.length > 0) {
    const ids = await wa.sendImages(ctx.client.phone, imageUrls, caption);
    zapiId = ids[0] ?? null;
  } else {
    zapiId = await wa.sendText(ctx.client.phone, caption);
  }

  const msg = await insertMessage(ctx.conversation.tenant_id, {
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: imageUrls.length > 0 ? 'image' : 'text',
    content: imageUrls[0] ?? caption,
    productId: product.id,
    mediaUrl: imageUrls.length > 0 ? imageUrls[0] : null,
    zapiMessageId: zapiId,
  });
  emitNewMessage(ctx.conversation.tenant_id, ctx.conversation.id, msg);
  return msg;
}

/** Envia um texto livre (resposta do Claude ou mensagem manual do operador). */
export async function dispatchText(
  ctx: DispatchContext,
  text: string,
  opts: DispatchOpts,
): Promise<MessageLog> {
  await guardOutbound(ctx, {
    sendType: opts.sendType,
    triggeringInboundId: opts.triggeringInboundId,
  });

  let body = text;
  if (opts.origin !== 'human') {
    body = await applySecretaryPlaybookToText({
      tenantId: ctx.conversation.tenant_id,
      connectionId: ctx.conversation.connection_id,
      toPhone: ctx.client.phone,
      text,
    });
  }

  const wa = await whatsapp.getWhatsappForConversation(
    ctx.conversation.tenant_id,
    ctx.conversation.connection_id,
  );
  const zapiId = await wa.sendText(ctx.client.phone, body);
  const msg = await insertMessage(ctx.conversation.tenant_id, {
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'text',
    content: body,
    zapiMessageId: zapiId,
    origin: opts.origin,
  });
  emitNewMessage(ctx.conversation.tenant_id, ctx.conversation.id, msg);
  return msg;
}
