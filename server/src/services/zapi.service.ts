import { logger } from '../config/logger';
import { AppError } from '../utils/errors';

/**
 * Integracao com a Z-API para envio de mensagens no WhatsApp.
 *
 * Multi-tenant: NAO le mais o .env. Todas as funcoes recebem uma conexao
 * (`ZapiConnection`) com as credenciais ja resolvidas/descriptografadas da
 * empresa. O facade (whatsapp.service.ts) resolve a conexao por tenant.
 * Usa o `fetch` nativo do Node 18+.
 */

export interface ZapiConnection {
  instanceId: string;
  token: string;
  clientToken?: string;
  /** Ex.: https://api.z-api.io/instances */
  baseUrl: string;
}

export interface ProviderStatus {
  ok: boolean;
  detail: string;
}

function isConfigured(conn: ZapiConnection): boolean {
  return Boolean(conn.instanceId && conn.token);
}

function baseUrl(conn: ZapiConnection): string {
  return `${conn.baseUrl}/${conn.instanceId}/token/${conn.token}`;
}

function headers(conn: ZapiConnection): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conn.clientToken) h['Client-Token'] = conn.clientToken;
  return h;
}

interface ZapiResponse {
  messageId?: string;
  id?: string;
  [key: string]: unknown;
}

async function post(
  conn: ZapiConnection,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  if (!isConfigured(conn)) {
    logger.warn(`Z-API nao configurada — simulando envio de "${endpoint}".`, body);
    return `sim-${Date.now()}`;
  }

  const url = `${baseUrl(conn)}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(conn),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Loga com detalhe (endpoint + corpo da resposta) para depurar em producao
    // sem expor tokens (que ficam apenas na URL, nao logada).
    logger.error(`Z-API ${endpoint} retornou ${res.status}: ${text}`);
    throw new AppError(`Z-API retornou ${res.status}: ${text}`, 502, 'ZAPI_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as ZapiResponse;
  // A Z-API as vezes responde 200 com um erro no corpo (ex.: numero invalido).
  if (data.error || data.message === 'error') {
    logger.warn(`Z-API ${endpoint} respondeu 200 com erro no corpo:`, data);
  }
  return data.messageId ?? data.id ?? null;
}

/**
 * Consulta o estado REAL da conexao na Z-API (GET /status): indica se o
 * celular esta pareado. Usado pela tela de status para refletir a realidade.
 */
export async function getConnectionStatus(conn: ZapiConnection): Promise<ProviderStatus> {
  if (!isConfigured(conn)) {
    return { ok: false, detail: 'Z-API nao configurada (instance/token ausentes).' };
  }
  try {
    const res = await fetch(`${baseUrl(conn)}/status`, {
      headers: headers(conn),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `Z-API respondeu HTTP ${res.status}: ${text.slice(0, 120)}` };
    }
    const data = (await res.json().catch(() => ({}))) as {
      connected?: boolean;
      smartphoneConnected?: boolean;
      error?: string;
    };
    const connected = Boolean(data.connected) && data.smartphoneConnected !== false;
    return connected
      ? { ok: true, detail: 'Conectado e celular pareado.' }
      : { ok: false, detail: data.error || 'Celular desconectado — reconecte a Z-API (leia o QR Code).' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg.includes('timeout') ? 'Tempo esgotado ao consultar a Z-API.' : msg };
  }
}

/** Envia mensagem de texto. */
export function sendText(conn: ZapiConnection, phone: string, message: string): Promise<string | null> {
  return post(conn, 'send-text', { phone, message });
}

/** Envia audio (URL .ogg). `audio` pode ser URL publica ou base64. */
export function sendAudio(conn: ZapiConnection, phone: string, audioUrl: string): Promise<string | null> {
  // waveform: true → o WhatsApp exibe como MENSAGEM DE VOZ (PTT), com a ondinha
  // e o balao grande, igual a um audio gravado de verdade. Sem isso, a Z-API
  // manda como arquivo de audio comum (balao menor, sem onda sonora).
  return post(conn, 'send-audio', { phone, audio: audioUrl, waveform: true });
}

/**
 * Marca a mensagem recebida como lida (exibe o "tique azul" para o cliente).
 * Requer que a conta tenha as confirmacoes de leitura ATIVADAS no WhatsApp.
 */
export function markAsRead(conn: ZapiConnection, phone: string, messageId: string): Promise<string | null> {
  return post(conn, 'read-message', { phone, messageId });
}

/** Envia imagem com legenda opcional. */
export function sendImage(
  conn: ZapiConnection,
  phone: string,
  imageUrl: string,
  caption?: string,
): Promise<string | null> {
  return post(conn, 'send-image', { phone, image: imageUrl, caption: caption ?? '' });
}

/** Envia varias imagens (uma por vez), retornando os IDs. */
export async function sendImages(
  conn: ZapiConnection,
  phone: string,
  imageUrls: string[],
  caption?: string,
): Promise<Array<string | null>> {
  const ids: Array<string | null> = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    // legenda apenas na primeira imagem
    ids.push(await sendImage(conn, phone, imageUrls[i], i === 0 ? caption : undefined));
  }
  return ids;
}
