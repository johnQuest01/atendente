import { env } from '../config/env';
import { logger } from '../config/logger';
import { getAudioById, getAudioBinary, incrementAudioUsage } from '../db/queries/audios';
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

/** URL pública (rota /media ou file_url legado) usada para tocar o áudio no painel. */
function audioPublicUrl(audio: Audio): string {
  // Se o áudio está guardado no banco, usamos a rota estável /media (acessível
  // pela Z-API mesmo em produção). Senão, caímos no file_url salvo (legado).
  return audio.has_file_data
    ? `${env.PUBLIC_BASE_URL}/media/audios/${audio.id}.ogg`
    : toCurrentPublicUrl(audio.file_url);
}

/**
 * Envia o áudio ao provedor de WhatsApp. Estratégia (em ordem de robustez):
 *   1. Base64 direto do banco — não depende de a Z-API conseguir BAIXAR uma URL
 *      pública. Era exatamente isso que falhava em produção: o host público
 *      (Render efêmero / túnel cloudflared expirado) devolvia 404 e a Z-API
 *      simplesmente não enviava o áudio.
 *   2. URL pública (/media ou file_url legado) — usada quando não há bytes no
 *      banco (áudios antigos) ou se o envio por base64 falhar.
 * Retorna o id da mensagem na Z-API (ou null se o provedor não devolver).
 */
async function sendAudioToProvider(phone: string, audio: Audio, publicUrl: string): Promise<string | null> {
  if (audio.has_file_data) {
    const bin = await getAudioBinary(audio.id);
    if (bin) {
      const dataUri = `data:${bin.mime || 'audio/ogg'};base64,${bin.data.toString('base64')}`;
      try {
        return await whatsapp.sendAudio(phone, dataUri);
      } catch (err) {
        logger.warn(
          `Envio de áudio por base64 falhou (audio=${audio.id}); tentando por URL pública.`,
          err,
        );
      }
    } else {
      logger.warn(`Áudio ${audio.id} marcado com has_file_data mas sem bytes no banco.`);
    }
  }
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
    zapiId = await sendAudioToProvider(ctx.client.phone, audio, publicUrl);
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
