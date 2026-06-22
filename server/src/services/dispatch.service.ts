import { env } from '../config/env';
import { logger } from '../config/logger';
import { getAudioById, incrementAudioUsage } from '../db/queries/audios';
import { getScriptById, incrementScriptUsage } from '../db/queries/messages_scripts';
import { getProductById } from '../db/queries/products';
import { insertMessage } from '../db/queries/messages';
import { emitNewMessage } from '../socket';
import { renderTemplate, formatBRL } from '../utils/text';
import * as whatsapp from './whatsapp.service';
import type { Audio, Client, Conversation, MessageLog } from '../types';

interface DispatchContext {
  conversation: Conversation;
  client: Client;
}

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
function audioPublicUrl(audio: Audio): string {
  // 1) Blob no banco (dev/legado): rota estável /media servida do banco.
  if (audio.has_file_data) return `${env.PUBLIC_BASE_URL}/media/audios/${audio.id}.ogg`;
  // 2) URL externa (R2/CDN): permanente, independe do backend — usa direto.
  if (isExternalUrl(audio.file_url)) return audio.file_url;
  // 3) Legado servido pelo backend: corrige o host atual.
  return toCurrentPublicUrl(audio.file_url);
}

/**
 * Envia o áudio ao provedor de WhatsApp pela URL pública ESTÁVEL.
 *
 * Sem base64: payloads base64 estouram limite/timeout da Z-API e o prefixo
 * `data:` costuma ser rejeitado — era a causa de "só vai texto, sem áudio".
 * A URL do R2 é um CDN permanente que a Z-API sempre consegue baixar.
 */
function sendAudioToProvider(phone: string, publicUrl: string): Promise<string | null> {
  return whatsapp.sendAudio(phone, publicUrl);
}

/** Envia um áudio do banco para o cliente e registra no log. */
export async function dispatchAudio(ctx: DispatchContext, audioId: string): Promise<MessageLog | null> {
  const audio = await getAudioById(audioId);
  if (!audio) {
    logger.warn(`Áudio ${audioId} não encontrado (a palavra-chave aponta para um áudio inexistente).`);
    return null;
  }
  if (!audio.is_active) {
    logger.warn(`Áudio "${audio.title}" (${audioId}) está INATIVO — não será enviado; caindo no fallback.`);
    return null;
  }

  const publicUrl = audioPublicUrl(audio);

  let zapiId: string | null;
  try {
    zapiId = await sendAudioToProvider(ctx.client.phone, publicUrl);
  } catch (err) {
    // Não derruba o fluxo nem registra uma mensagem "enviada" que nunca chegou:
    // retornando null, o webhook cai no fallback (Claude/texto) e o cliente não
    // fica no vácuo.
    logger.error(`Falha ao enviar áudio "${audio.title}" (${audio.id}) pela Z-API`, err);
    return null;
  }

  await incrementAudioUsage(audio.id);
  logger.info(`Áudio "${audio.title}" enviado para ${ctx.client.phone} (zapiId=${zapiId ?? 'n/d'}).`);

  const msg = await insertMessage({
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'audio',
    content: publicUrl,
    audioId: audio.id,
    zapiMessageId: zapiId,
  });
  emitNewMessage(ctx.conversation.id, msg);
  return msg;
}

/** Renderiza um script de texto (com variáveis) e envia. */
export async function dispatchScript(ctx: DispatchContext, scriptId: string): Promise<MessageLog | null> {
  const script = await getScriptById(scriptId);
  if (!script || !script.is_active) return null;

  const text = renderTemplate(script.content, {
    client_name: ctx.client.name ?? 'tudo bem',
    company_name: ctx.client.company_name ?? '',
  });

  const zapiId = await whatsapp.sendText(ctx.client.phone, text);
  await incrementScriptUsage(script.id);

  const msg = await insertMessage({
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'text',
    content: text,
    zapiMessageId: zapiId,
  });
  emitNewMessage(ctx.conversation.id, msg);
  return msg;
}

/** Envia as imagens de um produto + legenda formatada com preço. */
export async function dispatchProduct(ctx: DispatchContext, productId: string): Promise<MessageLog | null> {
  const product = await getProductById(productId);
  if (!product || !product.is_available) return null;

  const priceLine = product.price_wholesale
    ? `\nPreço atacado: ${formatBRL(Number(product.price_wholesale))}`
    : '';
  const minLine = `\nPedido mínimo: ${product.min_quantity}${product.unit ? ` (${product.unit})` : ''}`;
  const caption = `*${product.name}*${product.description ? `\n${product.description}` : ''}${priceLine}${minLine}`;

  const imageUrls = product.image_urls.map(toCurrentPublicUrl);
  let zapiId: string | null = null;
  if (imageUrls.length > 0) {
    const ids = await whatsapp.sendImages(ctx.client.phone, imageUrls, caption);
    zapiId = ids[0] ?? null;
  } else {
    zapiId = await whatsapp.sendText(ctx.client.phone, caption);
  }

  const msg = await insertMessage({
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: imageUrls.length > 0 ? 'image' : 'text',
    content: imageUrls[0] ?? caption,
    productId: product.id,
    zapiMessageId: zapiId,
  });
  emitNewMessage(ctx.conversation.id, msg);
  return msg;
}

/** Envia um texto livre (resposta do Claude ou mensagem manual do operador). */
export async function dispatchText(ctx: DispatchContext, text: string): Promise<MessageLog> {
  const zapiId = await whatsapp.sendText(ctx.client.phone, text);
  const msg = await insertMessage({
    conversationId: ctx.conversation.id,
    direction: 'outbound',
    type: 'text',
    content: text,
    zapiMessageId: zapiId,
  });
  emitNewMessage(ctx.conversation.id, msg);
  return msg;
}
