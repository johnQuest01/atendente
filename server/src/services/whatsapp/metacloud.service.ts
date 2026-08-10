import { logger } from '../../config/logger';
import { AppError } from '../../utils/errors';
import { safeFetchMedia } from '../inbound-media.service';
import type { MessageType } from '../../types';
import type {
  DownloadedMedia,
  NormalizedInbound,
  NormalizedStatus,
  ProviderStatus,
  WhatsAppProvider,
} from './types';

/**
 * Provedor Meta Cloud API (WhatsApp oficial).
 *
 * Autenticação: Bearer (access token) + phone_number_id, ambos cadastrados pelo
 * próprio cliente no painel. Envio em POST {graph}/{phone_number_id}/messages.
 *
 * Duas diferenças relevantes em relação à Z-API/Evolution:
 *  - A mídia recebida vem como HANDLE (`id`), não como URL nem base64: exige
 *    duas chamadas autenticadas (ver `downloadMedia`).
 *  - Mensagens enviadas pelo celular do próprio operador NÃO chegam no webhook
 *    (a Meta não emite eco por padrão), então `fromMe` é sempre false aqui e o
 *    recurso de pausa-por-humano não dispara neste provedor.
 */

export interface MetaCloudConnection {
  accessToken: string;
  phoneNumberId: string;
  /** Ex.: https://graph.facebook.com/v21.0 */
  graphBaseUrl?: string;
  /** Verify token que a Meta devolve no GET de verificação do webhook. */
  verifyToken?: string;
}

const DEFAULT_GRAPH = 'https://graph.facebook.com/v21.0';
const REQUEST_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 30_000;

function graphBase(conn: MetaCloudConnection): string {
  return (conn.graphBaseUrl || DEFAULT_GRAPH).replace(/\/+$/, '');
}

export function messagesUrl(conn: MetaCloudConnection): string {
  return `${graphBase(conn)}/${conn.phoneNumberId}/messages`;
}

function isConfigured(conn: MetaCloudConnection): boolean {
  return Boolean(conn.accessToken && conn.phoneNumberId);
}

/** Headers padrão Graph API. */
export function metaAuthHeaders(conn: MetaCloudConnection): Record<string, string> {
  return {
    Authorization: `Bearer ${conn.accessToken}`,
    'Content-Type': 'application/json',
  };
}

interface MetaError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

/**
 * Traduz o erro da Graph API para algo que o dono do negócio entenda no log.
 * Os códigos vêm da própria Meta; o fallback devolve a mensagem crua.
 */
function describeMetaError(err: MetaError | undefined, status: number): string {
  const code = err?.code;
  const raw = err?.error_data?.details || err?.message || `HTTP ${status}`;
  if (code === 190) {
    return `Token de acesso inválido ou expirado — gere um novo no painel da Meta. (${raw})`;
  }
  if (code === 131047) {
    return `Passaram-se mais de 24h desde a última mensagem do cliente: a Meta só permite modelo (template) aprovado fora dessa janela. (${raw})`;
  }
  if (code === 131026) {
    return `Número de destino não pode receber mensagens (não tem WhatsApp ou recusou). (${raw})`;
  }
  if (code === 131056 || code === 130429) {
    return `Limite de envio da Meta atingido, tente novamente em instantes. (${raw})`;
  }
  if (code === 133010 || code === 131031) {
    return `Número da conta não está registrado/está bloqueado na Meta. (${raw})`;
  }
  if (code === 100) {
    return `Parâmetro rejeitado pela Meta — confira o phone_number_id. (${raw})`;
  }
  return raw;
}

/** POST autenticado no endpoint de mensagens. Devolve o wamid da mensagem. */
async function postMessage(
  conn: MetaCloudConnection,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!isConfigured(conn)) {
    logger.warn('Meta Cloud não configurada — simulando envio.', { type: payload.type });
    return `sim-${Date.now()}`;
  }

  let res: Response;
  try {
    res = await fetch(messagesUrl(conn), {
      method: 'POST',
      headers: metaAuthHeaders(conn),
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Meta Cloud: falha de rede ao enviar (${msg}).`);
    throw new AppError(`Meta Cloud indisponível: ${msg}`, 502, 'METACLOUD_ERROR');
  }

  const data = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: MetaError;
  };

  if (!res.ok || data.error) {
    const detail = describeMetaError(data.error, res.status);
    // Nunca logamos o access token: ele só existe no header.
    logger.error(`Meta Cloud: envio recusado (HTTP ${res.status}) — ${detail}`);
    throw new AppError(`Meta Cloud: ${detail}`, 502, 'METACLOUD_ERROR');
  }

  return data.messages?.[0]?.id ?? null;
}

export function createMetaCloudProvider(conn: MetaCloudConnection): WhatsAppProvider {
  return {
    sendText(phone, message) {
      return postMessage(conn, {
        to: phone,
        type: 'text',
        text: { body: message, preview_url: false },
      });
    },

    /**
     * Áudio por link público. Para o WhatsApp exibir como mensagem de voz (PTT,
     * com a ondinha), o arquivo precisa ser audio/ogg codec opus — que é o
     * formato que o projeto já usa nos áudios da biblioteca.
     */
    sendAudio(phone, audioUrl) {
      return postMessage(conn, { to: phone, type: 'audio', audio: { link: audioUrl } });
    },

    sendImage(phone, imageUrl, caption) {
      return postMessage(conn, {
        to: phone,
        type: 'image',
        image: caption ? { link: imageUrl, caption } : { link: imageUrl },
      });
    },

    async sendImages(phone, imageUrls, caption) {
      const ids: Array<string | null> = [];
      for (let i = 0; i < imageUrls.length; i += 1) {
        const cap = i === 0 ? caption : undefined;
        ids.push(
          await postMessage(conn, {
            to: phone,
            type: 'image',
            image: cap ? { link: imageUrls[i], caption: cap } : { link: imageUrls[i] },
          }),
        );
      }
      return ids;
    },

    /** Tique azul. Na Cloud API o destinatário é implícito no message_id. */
    async markAsRead(_phone, messageId) {
      return postMessage(conn, { status: 'read', message_id: messageId });
    },

    async getConnectionStatus(): Promise<ProviderStatus> {
      if (!isConfigured(conn)) {
        return {
          ok: false,
          detail: 'Meta Cloud não configurada (token de acesso / phone number ID ausentes).',
        };
      }
      try {
        const url =
          `${graphBase(conn)}/${conn.phoneNumberId}` +
          '?fields=display_phone_number,verified_name,quality_rating,code_verification_status';
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${conn.accessToken}` },
          signal: AbortSignal.timeout(5000),
        });
        const data = (await res.json().catch(() => ({}))) as {
          display_phone_number?: string;
          verified_name?: string;
          quality_rating?: string;
          error?: MetaError;
        };
        if (!res.ok || data.error) {
          return { ok: false, detail: describeMetaError(data.error, res.status) };
        }
        const parts = [
          data.verified_name ? `${data.verified_name}` : null,
          data.display_phone_number ?? null,
          data.quality_rating ? `qualidade ${data.quality_rating}` : null,
        ].filter(Boolean);
        const phone = (data.display_phone_number ?? '').replace(/\D/g, '');
        return {
          ok: true,
          detail: parts.length > 0 ? `Número ativo na Meta: ${parts.join(' · ')}.` : 'Número ativo na Meta.',
          phone: phone.length >= 10 ? phone : null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          detail: msg.includes('timeout') ? 'Tempo esgotado ao consultar a Meta.' : msg,
        };
      }
    },

    /**
     * Mídia recebida: a Meta manda só o handle. São duas chamadas — uma para
     * descobrir a URL temporária, outra para baixar os bytes. As duas exigem o
     * Bearer, e a segunda passa pelo fetch com proteção de SSRF.
     */
    async downloadMedia(mediaId: string): Promise<DownloadedMedia | null> {
      if (!isConfigured(conn)) return null;
      try {
        const metaRes = await fetch(`${graphBase(conn)}/${mediaId}`, {
          headers: { Authorization: `Bearer ${conn.accessToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const info = (await metaRes.json().catch(() => ({}))) as {
          url?: string;
          mime_type?: string;
          file_size?: number;
          error?: MetaError;
        };
        if (!metaRes.ok || !info.url) {
          logger.warn(`Meta Cloud: não foi possível resolver a mídia ${mediaId} — ${describeMetaError(info.error, metaRes.status)}`);
          return null;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
        try {
          const fetched = await safeFetchMedia(info.url, controller.signal, {
            Authorization: `Bearer ${conn.accessToken}`,
          });
          if (!fetched) return null;
          return {
            base64: fetched.buffer.toString('base64'),
            mime: info.mime_type ?? fetched.mime,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        logger.warn(`Meta Cloud: falha ao baixar a mídia ${mediaId}`, err);
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing do webhook da Meta
// ---------------------------------------------------------------------------

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string };
  sticker?: { id?: string; mime_type?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
}

interface MetaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: Array<{
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: MetaError[];
  }>;
}

/** Primeiro `value` de entry[].changes[] — é onde a Meta põe tudo. */
function firstValue(body: Record<string, unknown>): MetaValue | null {
  const entry = (body.entry as Array<{ changes?: Array<{ value?: MetaValue }> }> | undefined)?.[0];
  const change = entry?.changes?.[0];
  return change?.value ?? null;
}

/** Reconhece um payload da Meta mesmo antes de saber o provedor da conexão. */
export function isMetaCloudPayload(body: Record<string, unknown>): boolean {
  return body.object === 'whatsapp_business_account' && Array.isArray(body.entry);
}

function isoFromUnix(ts: string | undefined): string | null {
  if (!ts) return null;
  const secs = Number(ts);
  if (!Number.isFinite(secs)) return null;
  return new Date(secs * 1000).toISOString();
}

export function parseMetaCloudInbound(body: Record<string, unknown>): NormalizedInbound | null {
  const value = firstValue(body);
  const msg = value?.messages?.[0];
  if (!msg || !msg.from) return null;

  const senderName = value?.contacts?.[0]?.profile?.name ?? null;

  let type: MessageType = 'text';
  let content = '';
  let mediaId: string | null = null;
  let mediaMime: string | null = null;
  let fileName: string | null = null;

  switch (msg.type) {
    case 'text':
      content = msg.text?.body ?? '';
      break;
    case 'image':
      type = 'image';
      content = msg.image?.caption ?? '';
      mediaId = msg.image?.id ?? null;
      mediaMime = msg.image?.mime_type ?? null;
      break;
    case 'video':
      type = 'video';
      content = msg.video?.caption ?? '';
      mediaId = msg.video?.id ?? null;
      mediaMime = msg.video?.mime_type ?? null;
      break;
    case 'audio':
      type = 'audio';
      mediaId = msg.audio?.id ?? null;
      mediaMime = msg.audio?.mime_type ?? null;
      break;
    case 'document':
      type = 'document';
      fileName = msg.document?.filename ?? null;
      content = msg.document?.caption ?? fileName ?? '';
      mediaId = msg.document?.id ?? null;
      mediaMime = msg.document?.mime_type ?? null;
      break;
    // Resposta de botão/lista: para o pipeline é texto — o título é o que o
    // cliente "disse", e é isso que casa com palavra-chave e alimenta a IA.
    case 'button':
      content = msg.button?.text ?? msg.button?.payload ?? '';
      break;
    case 'interactive':
      content = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '';
      break;
    default:
      // sticker, location, contacts, reaction, order, system: sem tratamento
      // no pipeline hoje — ignorar é melhor que criar mensagem vazia.
      logger.info(`Meta Cloud: tipo de mensagem não suportado ignorado (${msg.type}).`);
      return null;
  }

  if (type === 'text' && !content) return null;

  return {
    phone: (msg.from ?? '').replace(/\D/g, ''),
    lid: null,
    phoneIsLid: false,
    text: content,
    type,
    providerMessageId: msg.id ?? null,
    senderName,
    // A Meta não emite eco das mensagens enviadas pelo próprio número.
    fromMe: false,
    mediaUrl: null,
    mediaBase64: null,
    mediaId,
    mediaMime,
    fileName,
    caption: content || null,
    timestamp: isoFromUnix(msg.timestamp),
    raw: body,
  };
}

export function parseMetaCloudStatus(body: Record<string, unknown>): NormalizedStatus | null {
  const value = firstValue(body);
  const statuses = value?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return null;

  const read: string[] = [];
  const delivered: string[] = [];
  for (const s of statuses) {
    if (!s.id) continue;
    const st = String(s.status ?? '').toLowerCase();
    if (st === 'read') read.push(s.id);
    else if (st === 'delivered') delivered.push(s.id);
    else if (st === 'failed') {
      logger.warn(`Meta Cloud: envio falhou (${s.id}) — ${s.errors?.[0]?.message ?? 'sem detalhe'}`);
    }
    // 'sent' = aceito pela Meta, ainda não entregue: não marcamos nada.
  }

  // A Meta manda um status por callback; se vier misturado, "lido" prevalece
  // (quem leu necessariamente recebeu).
  if (read.length > 0) return { ids: read, status: 'READ' };
  if (delivered.length > 0) return { ids: delivered, status: 'DELIVERED' };
  return null;
}
