import { env } from '../config/env';
import { getAudioById, incrementAudioUsage } from '../db/queries/audios';
import { getScriptById, incrementScriptUsage } from '../db/queries/messages_scripts';
import { getProductById } from '../db/queries/products';
import { insertMessage } from '../db/queries/messages';
import { emitNewMessage } from '../socket';
import { renderTemplate, formatBRL } from '../utils/text';
import * as whatsapp from './whatsapp.service';
import type { Client, Conversation, MessageLog } from '../types';

interface DispatchContext {
  conversation: Conversation;
  client: Client;
}

/**
 * Garante que a URL da mídia use o host público atual (env.PUBLIC_BASE_URL).
 * Necessário porque a URL é salva no momento do upload, mas o host público
 * (ex.: túnel cloudflared) pode mudar — sem isso, mídias antigas quebrariam.
 */
function toCurrentPublicUrl(fileUrl: string): string {
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

/** Envia um áudio do banco para o cliente e registra no log. */
export async function dispatchAudio(ctx: DispatchContext, audioId: string): Promise<MessageLog | null> {
  const audio = await getAudioById(audioId);
  if (!audio || !audio.is_active) return null;

  // Se o áudio está guardado no banco, usamos a rota estável /media (acessível
  // pela Z-API mesmo em produção). Senão, caímos no file_url salvo (legado).
  const publicUrl = audio.has_file_data
    ? `${env.PUBLIC_BASE_URL}/media/audios/${audio.id}.ogg`
    : toCurrentPublicUrl(audio.file_url);
  const zapiId = await whatsapp.sendAudio(ctx.client.phone, publicUrl);
  await incrementAudioUsage(audio.id);

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

/** Envia um texto livre (resposta do Claude ou mensagem manual da Mayra). */
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

