import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

/**
 * Integracao com a Evolution API (self-hosted) para envio de mensagens no
 * WhatsApp. Mesma interface do zapi.service (connection-aware): cada funcao
 * recebe uma `EvolutionConnection` ja resolvida pelo facade por tenant.
 *
 * Endpoints baseados na Evolution API v2:
 *   POST {base}/message/sendText/{instance}
 *   POST {base}/message/sendMedia/{instance}
 *   POST {base}/message/sendWhatsAppAudio/{instance}
 * Autenticacao via header `apikey`.
 */

export interface EvolutionConnection {
  apiKey: string;
  instance: string;
  /** Ex.: http://localhost:8080 */
  baseUrl: string;
}

export interface ProviderStatus {
  ok: boolean;
  detail: string;
  phone?: string | null;
}

function isConfigured(conn: EvolutionConnection): boolean {
  return Boolean(conn.apiKey && conn.instance);
}

function url(conn: EvolutionConnection, endpoint: string): string {
  return `${conn.baseUrl}/${endpoint}/${conn.instance}`;
}

function headers(conn: EvolutionConnection): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: conn.apiKey,
  };
}

interface EvolutionResponse {
  key?: { id?: string };
  messageId?: string;
  [key: string]: unknown;
}

async function post(
  conn: EvolutionConnection,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  if (!isConfigured(conn)) {
    logger.warn(`Evolution API nao configurada — simulando envio de "${endpoint}".`, body);
    return `sim-${Date.now()}`;
  }

  const res = await fetch(url(conn, endpoint), {
    method: 'POST',
    headers: headers(conn),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(`Evolution API retornou ${res.status}: ${text}`, 502, 'EVOLUTION_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as EvolutionResponse;
  return data.key?.id ?? data.messageId ?? null;
}

/**
 * Consulta o estado REAL da instancia na Evolution API
 * (GET /instance/connectionState/:instance). state === 'open' = conectado.
 */
export async function getConnectionStatus(conn: EvolutionConnection): Promise<ProviderStatus> {
  if (!isConfigured(conn)) {
    return { ok: false, detail: 'Evolution API nao configurada (apikey/instancia ausentes).' };
  }
  try {
    const res = await fetch(`${conn.baseUrl}/instance/connectionState/${conn.instance}`, {
      headers: headers(conn),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `Evolution respondeu HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { instance?: { state?: string } };
    const state = data.instance?.state;
    return state === 'open'
      ? { ok: true, detail: 'Instancia conectada (open).' }
      : { ok: false, detail: `Instancia nao conectada (estado: ${state ?? 'desconhecido'}).` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg.includes('timeout') ? 'Tempo esgotado ao consultar a Evolution.' : msg };
  }
}

export function sendText(conn: EvolutionConnection, phone: string, message: string): Promise<string | null> {
  return post(conn, 'message/sendText', { number: phone, text: message });
}

export function sendAudio(conn: EvolutionConnection, phone: string, audioUrl: string): Promise<string | null> {
  return post(conn, 'message/sendWhatsAppAudio', { number: phone, audio: audioUrl });
}

/**
 * Marca a mensagem recebida como lida (exibe o "tique azul" para o cliente).
 * Requer que a conta tenha as confirmacoes de leitura ATIVADAS no WhatsApp.
 */
export function markAsRead(conn: EvolutionConnection, phone: string, messageId: string): Promise<string | null> {
  return post(conn, 'chat/markMessageAsRead', {
    readMessages: [{ remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: messageId }],
  });
}

export function sendImage(
  conn: EvolutionConnection,
  phone: string,
  imageUrl: string,
  caption?: string,
): Promise<string | null> {
  return post(conn, 'message/sendMedia', {
    number: phone,
    mediatype: 'image',
    media: imageUrl,
    caption: caption ?? '',
  });
}

export async function sendImages(
  conn: EvolutionConnection,
  phone: string,
  imageUrls: string[],
  caption?: string,
): Promise<Array<string | null>> {
  const ids: Array<string | null> = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    ids.push(await sendImage(conn, phone, imageUrls[i], i === 0 ? caption : undefined));
  }
  return ids;
}
