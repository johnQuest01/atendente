import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

/**
 * Integração com a Z-API para envio de mensagens no WhatsApp.
 * Usa o `fetch` nativo do Node 18+.
 */

function baseUrl(): string {
  return `${env.ZAPI_BASE_URL}/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_TOKEN}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.ZAPI_CLIENT_TOKEN) h['Client-Token'] = env.ZAPI_CLIENT_TOKEN;
  return h;
}

interface ZapiResponse {
  messageId?: string;
  id?: string;
  [key: string]: unknown;
}

async function post(endpoint: string, body: Record<string, unknown>): Promise<string | null> {
  if (!env.hasZapi) {
    logger.warn(`Z-API não configurada — simulando envio de "${endpoint}".`, body);
    return `sim-${Date.now()}`;
  }

  const url = `${baseUrl()}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Loga com detalhe (endpoint + corpo da resposta) para depurar em produção
    // sem expor tokens (que ficam apenas na URL, não logada).
    logger.error(`Z-API ${endpoint} retornou ${res.status}: ${text}`);
    throw new AppError(`Z-API retornou ${res.status}: ${text}`, 502, 'ZAPI_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as ZapiResponse;
  // A Z-API às vezes responde 200 com um erro no corpo (ex.: número inválido).
  if (data.error || data.message === 'error') {
    logger.warn(`Z-API ${endpoint} respondeu 200 com erro no corpo:`, data);
  }
  return data.messageId ?? data.id ?? null;
}

/** Envia mensagem de texto. */
export function sendText(phone: string, message: string): Promise<string | null> {
  return post('send-text', { phone, message });
}

/** Envia áudio (URL .ogg). `audio` pode ser URL pública ou base64. */
export function sendAudio(phone: string, audioUrl: string): Promise<string | null> {
  return post('send-audio', { phone, audio: audioUrl });
}

/**
 * Marca a mensagem recebida como lida (exibe o "tique azul" para o cliente).
 * Requer que a conta tenha as confirmações de leitura ATIVADAS no WhatsApp.
 */
export function markAsRead(phone: string, messageId: string): Promise<string | null> {
  return post('read-message', { phone, messageId });
}

/** Envia imagem com legenda opcional. */
export function sendImage(phone: string, imageUrl: string, caption?: string): Promise<string | null> {
  return post('send-image', { phone, image: imageUrl, caption: caption ?? '' });
}

/** Envia várias imagens (uma por vez), retornando os IDs. */
export async function sendImages(
  phone: string,
  imageUrls: string[],
  caption?: string,
): Promise<Array<string | null>> {
  const ids: Array<string | null> = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    // legenda apenas na primeira imagem
    ids.push(await sendImage(phone, imageUrls[i], i === 0 ? caption : undefined));
  }
  return ids;
}
