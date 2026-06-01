import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

/**
 * Integração com a Evolution API (self-hosted) para envio de mensagens
 * no WhatsApp. Mesma interface pública do zapi.service.ts, para que o
 * facade (whatsapp.service.ts) possa alternar entre os provedores.
 *
 * Endpoints baseados na Evolution API v2:
 *   POST {base}/message/sendText/{instance}
 *   POST {base}/message/sendMedia/{instance}
 *   POST {base}/message/sendWhatsAppAudio/{instance}
 * Autenticação via header `apikey`.
 */

function url(endpoint: string): string {
  return `${env.EVOLUTION_BASE_URL}/${endpoint}/${env.EVOLUTION_INSTANCE}`;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: env.EVOLUTION_API_KEY ?? '',
  };
}

interface EvolutionResponse {
  key?: { id?: string };
  messageId?: string;
  [key: string]: unknown;
}

async function post(endpoint: string, body: Record<string, unknown>): Promise<string | null> {
  if (!env.hasEvolution) {
    logger.warn(`Evolution API não configurada — simulando envio de "${endpoint}".`, body);
    return `sim-${Date.now()}`;
  }

  const res = await fetch(url(endpoint), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(`Evolution API retornou ${res.status}: ${text}`, 502, 'EVOLUTION_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as EvolutionResponse;
  return data.key?.id ?? data.messageId ?? null;
}

export function sendText(phone: string, message: string): Promise<string | null> {
  return post('message/sendText', { number: phone, text: message });
}

export function sendAudio(phone: string, audioUrl: string): Promise<string | null> {
  return post('message/sendWhatsAppAudio', { number: phone, audio: audioUrl });
}

/**
 * Marca a mensagem recebida como lida (exibe o "tique azul" para o cliente).
 * Requer que a conta tenha as confirmações de leitura ATIVADAS no WhatsApp.
 */
export function markAsRead(phone: string, messageId: string): Promise<string | null> {
  return post('chat/markMessageAsRead', {
    readMessages: [{ remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: messageId }],
  });
}

export function sendImage(phone: string, imageUrl: string, caption?: string): Promise<string | null> {
  return post('message/sendMedia', {
    number: phone,
    mediatype: 'image',
    media: imageUrl,
    caption: caption ?? '',
  });
}

export async function sendImages(
  phone: string,
  imageUrls: string[],
  caption?: string,
): Promise<Array<string | null>> {
  const ids: Array<string | null> = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    ids.push(await sendImage(phone, imageUrls[i], i === 0 ? caption : undefined));
  }
  return ids;
}
