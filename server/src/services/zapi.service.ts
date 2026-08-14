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
  phone?: string | null;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Telefone real pareado na instância (GET /device).
 * Ex.: "5511999999999"
 */
export async function fetchDevicePhone(conn: ZapiConnection): Promise<string | null> {
  if (!isConfigured(conn)) return null;
  try {
    const res = await fetch(`${baseUrl(conn)}/device`, {
      headers: headers(conn),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { phone?: string | number };
    const raw = data.phone != null ? String(data.phone) : '';
    const phone = onlyDigits(raw);
    return phone.length >= 10 ? phone : null;
  } catch (err) {
    logger.warn('Z-API /device falhou ao obter telefone.', err);
    return null;
  }
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

/** Rede/DNS/timeout — vale retry curto. HTTP 4xx da Z-API não. */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as Error).name ?? '';
  const msg = (err as Error).message ?? '';
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? '';
  const causeMsg = cause?.message ?? '';
  const blob = `${name} ${msg} ${code} ${causeMsg}`;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (/fetch failed/i.test(blob)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket/i.test(blob)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  try {
    return await postOnce(conn, url, body, endpoint);
  } catch (err) {
    if (err instanceof AppError || !isTransientNetworkError(err)) throw err;
    logger.warn(`Z-API ${endpoint} falhou (retry imediato 500ms)`, err);
    await sleep(500);
    return postOnce(conn, url, body, endpoint);
  }
}

async function postOnce(
  conn: ZapiConnection,
  url: string,
  body: Record<string, unknown>,
  endpoint: string,
): Promise<string | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(conn),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`Z-API ${endpoint} retornou ${res.status}: ${text}`);
    throw new AppError(`Z-API retornou ${res.status}: ${text}`, 502, 'ZAPI_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as ZapiResponse;
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
    if (!connected) {
      return {
        ok: false,
        detail: data.error || 'Celular desconectado — reconecte a Z-API (leia o QR Code).',
      };
    }
    const phone = await fetchDevicePhone(conn);
    return {
      ok: true,
      detail: phone
        ? `Conectado · ${phone}`
        : 'Conectado e celular pareado.',
      phone,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg.includes('timeout') ? 'Tempo esgotado ao consultar a Z-API.' : msg };
  }
}

/**
 * Segundos de "digitando..." antes da mensagem aparecer.
 *
 * Uma resposta que chega instantaneamente denuncia o robô. Aqui o tempo é
 * proporcional ao tamanho do texto (~25 caracteres por segundo, ritmo de quem
 * digita rápido no celular), com piso de 1s para frases curtas não travarem o
 * atendimento e teto de 8s para ninguém achar que a conversa morreu.
 */
export function typingSecondsFor(message: string): number {
  const seconds = Math.round(message.length / 25);
  return Math.min(8, Math.max(1, seconds));
}

/**
 * Aponta TODOS os webhooks da instância para a nossa URL, de uma só vez.
 *
 * Existe porque "instância conectada" e "webhook apontado para nós" são coisas
 * diferentes: a Z-API pode estar pareada com o celular e mesmo assim não
 * entregar nada aqui — sintoma silencioso, porque o painel dela mostra tudo
 * verde. Configurar por API elimina o passo manual (e o erro de colar a URL no
 * campo errado, já que ela tem vários).
 *
 * `notifySentByMe` liga o eco das mensagens que o operador envia pelo próprio
 * celular — é o que alimenta a pausa automática da IA.
 */
export async function configureWebhooks(
  conn: ZapiConnection,
  url: string,
  notifySentByMe = true,
): Promise<{ ok: boolean; detail: string }> {
  if (!isConfigured(conn)) {
    return { ok: false, detail: 'Credenciais da Z-API não cadastradas.' };
  }
  if (!url.startsWith('https://')) {
    return { ok: false, detail: `A Z-API só aceita webhook HTTPS — a URL atual é "${url}".` };
  }

  try {
    const res = await fetch(`${baseUrl(conn)}/update-every-webhooks`, {
      method: 'PUT',
      headers: headers(conn),
      body: JSON.stringify({ value: url, notifySentByMe }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      logger.error(`Z-API update-every-webhooks retornou ${res.status}: ${text}`);
      return { ok: false, detail: `A Z-API recusou (HTTP ${res.status}): ${text.slice(0, 160)}` };
    }
    logger.info(`Webhooks da Z-API apontados para ${url}`);
    return {
      ok: true,
      detail: 'Webhooks configurados na Z-API (recebimento, status e eco das suas mensagens).',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `Falha ao falar com a Z-API: ${msg}` };
  }
}

/** Envia mensagem de texto, com o "digitando..." antes. */
export function sendText(conn: ZapiConnection, phone: string, message: string): Promise<string | null> {
  return post(conn, 'send-text', {
    phone,
    message,
    delayTyping: typingSecondsFor(message),
  });
}

/**
 * Corrige (edita) um texto já enviado no WhatsApp.
 * Limite do WhatsApp: até ~7 dias. Campo: editMessageId.
 */
export function editText(
  conn: ZapiConnection,
  phone: string,
  messageId: string,
  message: string,
): Promise<string | null> {
  return post(conn, 'send-text', {
    phone,
    message,
    editMessageId: messageId,
  });
}

/**
 * Apaga mensagem no chat do WhatsApp.
 * `owner=true` = você enviou; `false` = veio do contato.
 * Sem `deleteForMe` (ou false) = apaga para todos; true = só para você.
 */
export async function deleteMessage(
  conn: ZapiConnection,
  phone: string,
  messageId: string,
  owner: boolean,
  deleteForMe = false,
): Promise<{ ok: boolean; detail: string }> {
  if (!isConfigured(conn)) {
    return { ok: false, detail: 'Z-API não configurada.' };
  }
  const params = new URLSearchParams({
    messageId,
    phone,
    owner: owner ? 'true' : 'false',
  });
  if (deleteForMe) params.set('deleteForMe', 'true');

  try {
    const res = await fetch(`${baseUrl(conn)}/messages?${params.toString()}`, {
      method: 'DELETE',
      headers: headers(conn),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || res.status === 204) {
      return { ok: true, detail: deleteForMe ? 'Apagada só para você.' : 'Apagada para todos.' };
    }
    const text = await res.text().catch(() => '');
    logger.warn(`Z-API delete message HTTP ${res.status}: ${text}`);
    return { ok: false, detail: text.slice(0, 180) || `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
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

/** Contato da agenda do aparelho (Z-API GET /contacts). */
export interface ZapiAddressBookContact {
  phone?: string;
  name?: string;
  short?: string;
  notify?: string;
  vname?: string;
}

/**
 * Lista a agenda do WhatsApp pareado (paginado).
 * Doc: GET /contacts?page=&pageSize=
 */
export async function fetchAllContacts(conn: ZapiConnection): Promise<ZapiAddressBookContact[]> {
  if (!isConfigured(conn)) {
    throw new AppError('Z-API não configurada para esta conexão.', 400, 'ZAPI_NOT_CONFIGURED');
  }

  const out: ZapiAddressBookContact[] = [];
  const pageSize = 200;
  const maxPages = 50;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${baseUrl(conn)}/contacts?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: headers(conn),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(`Z-API contacts retornou ${res.status}: ${text.slice(0, 200)}`);
      throw new AppError(
        `Falha ao ler agenda do WhatsApp (HTTP ${res.status}).`,
        502,
        'ZAPI_CONTACTS_ERROR',
      );
    }
    const data = (await res.json().catch(() => null)) as unknown;
    const batch = Array.isArray(data)
      ? (data as ZapiAddressBookContact[])
      : Array.isArray((data as { contacts?: unknown })?.contacts)
        ? ((data as { contacts: ZapiAddressBookContact[] }).contacts)
        : [];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }

  return out;
}
