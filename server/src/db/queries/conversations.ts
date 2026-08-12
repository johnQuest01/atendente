import { query, queryOne } from '../index';
import { getActiveBlockedPhones, normalizePhone } from './blocked';
import type { AiHistoryMessage, Conversation, ConversationStatus, MessageLog } from '../../types';

export interface ConversationListItem extends Conversation {
  client_name: string | null;
  client_phone: string;
  company_name: string | null;
  connection_label: string | null;
  connection_phone: string | null;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count: number;
}

export async function findOpenConversationByClient(
  tenantId: string,
  clientId: string,
  connectionId?: string | null,
): Promise<Conversation | null> {
  if (connectionId) {
    return queryOne<Conversation>(
      `SELECT * FROM conversations
        WHERE tenant_id = $1 AND client_id = $2 AND connection_id = $3 AND status <> 'closed'
        ORDER BY started_at DESC
        LIMIT 1`,
      [tenantId, clientId, connectionId],
    );
  }
  return queryOne<Conversation>(
    `SELECT * FROM conversations
      WHERE tenant_id = $1 AND client_id = $2 AND status <> 'closed'
        AND connection_id IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [tenantId, clientId],
  );
}

export async function findOrCreateOpenConversation(
  tenantId: string,
  clientId: string,
  connectionId?: string | null,
): Promise<Conversation> {
  const existing = await findOpenConversationByClient(tenantId, clientId, connectionId);
  if (existing) return existing;

  try {
    const { rows } = await query<Conversation>(
      `INSERT INTO conversations (tenant_id, client_id, connection_id, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING *`,
      [tenantId, clientId, connectionId ?? null],
    );
    return rows[0];
  } catch (err) {
    // Corrida: outra requisição abriu a conversa ao mesmo tempo e o índice único
    // parcial barrou esta. Em vez de propagar o erro, buscamos a que venceu.
    const open = await findOpenConversationByClient(tenantId, clientId, connectionId);
    if (open) return open;
    throw err;
  }
}

export async function getConversationById(
  tenantId: string,
  id: string,
): Promise<Conversation | null> {
  return queryOne<Conversation>('SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

export async function listConversations(
  tenantId: string,
  status?: ConversationStatus,
  connectionId?: string,
): Promise<ConversationListItem[]> {
  const params: unknown[] = [tenantId];
  let where = 'WHERE c.tenant_id = $1';
  if (status) {
    params.push(status);
    where += ` AND c.status = $${params.length}`;
  }
  if (connectionId) {
    params.push(connectionId);
    where += ` AND c.connection_id = $${params.length}`;
  }

  const { rows } = await query<ConversationListItem>(
    `SELECT
        c.*,
        cl.name AS client_name,
        cl.phone AS client_phone,
        cl.company_name,
        wc.label AS connection_label,
        wc.phone_number AS connection_phone,
        lm.content AS last_message,
        lm.type AS last_message_type,
        lm.sent_at AS last_message_at,
        COALESCE(uc.unread_count, 0)::int AS unread_count
      FROM conversations c
      JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN whatsapp_connections wc ON wc.id = c.connection_id
      LEFT JOIN LATERAL (
        SELECT content, type, sent_at
        FROM messages_log m
        WHERE m.conversation_id = c.id
        ORDER BY m.sent_at DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS unread_count
        FROM messages_log m
        WHERE m.conversation_id = c.id
          AND m.direction = 'inbound'
          AND m.read_at IS NULL
      ) uc ON true
      ${where}
      ORDER BY COALESCE(lm.sent_at, c.started_at) DESC
      LIMIT 200`,
    params,
  );
  // Lista: não vaza preview de conversa trancada nem de número bloqueado (cadeado).
  const blockedPhones = await getActiveBlockedPhones(tenantId);
  return rows.map((r) => {
    const phoneBlocked = blockedPhones.has(normalizePhone(r.client_phone));
    if (r.is_locked || phoneBlocked) {
      return {
        ...r,
        is_locked: true,
        last_message: null,
        last_message_type: null,
        unread_count: 0,
      };
    }
    return r;
  });
}

/**
 * Histórico da conversa para o painel. Devolve as N mensagens MAIS RECENTES
 * em ordem cronológica (ASC). Antes era `ORDER BY sent_at ASC LIMIT N`, o que
 * pegava só o começo da conversa — com >N msgs, o card mostrava a última
 * (preview) e o chat aberto ficava “parado” no passado.
 */
export async function getConversationMessages(
  tenantId: string,
  conversationId: string,
  limit = 200,
): Promise<MessageLog[]> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM (
       SELECT * FROM messages_log
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY sent_at DESC, id DESC
        LIMIT $3
     ) recent
     ORDER BY sent_at ASC, id ASC`,
    [tenantId, conversationId, limit],
  );
  return rows;
}

/** Conversas de um cliente (para export JSON). Opcionalmente só de um WhatsApp. */
export async function listConversationsByClient(
  tenantId: string,
  clientId: string,
  connectionId?: string | null,
): Promise<Conversation[]> {
  if (connectionId) {
    const { rows } = await query<Conversation>(
      `SELECT * FROM conversations
        WHERE tenant_id = $1 AND client_id = $2 AND connection_id = $3
        ORDER BY started_at DESC
        LIMIT 50`,
      [tenantId, clientId, connectionId],
    );
    return rows;
  }
  const { rows } = await query<Conversation>(
    `SELECT * FROM conversations
      WHERE tenant_id = $1 AND client_id = $2
      ORDER BY started_at DESC
      LIMIT 50`,
    [tenantId, clientId],
  );
  return rows;
}

export async function getRecentMessages(
  tenantId: string,
  conversationId: string,
  limit = 10,
): Promise<MessageLog[]> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY sent_at DESC
      LIMIT $3`,
    [tenantId, conversationId, limit],
  );
  return rows.reverse();
}

/**
 * Histórico recente enriquecido para a IA: traz a transcrição do áudio e o
 * nome do produto referenciados, para que o Claude "entenda" turnos que não
 * são texto puro (áudios e imagens enviados).
 */
export async function getRecentMessagesForAI(
  tenantId: string,
  conversationId: string,
  limit = 20,
): Promise<AiHistoryMessage[]> {
  const { rows } = await query<AiHistoryMessage>(
    `SELECT
        m.*,
        a.transcription AS audio_transcription,
        a.title AS audio_title,
        p.name AS product_name
      FROM messages_log m
      LEFT JOIN audios a ON a.id = m.audio_id
      LEFT JOIN products p ON p.id = m.product_id
      WHERE m.tenant_id = $1 AND m.conversation_id = $2
      ORDER BY m.sent_at DESC
      LIMIT $3`,
    [tenantId, conversationId, limit],
  );
  return rows.reverse();
}

export async function updateConversationStatus(
  tenantId: string,
  id: string,
  status: ConversationStatus,
): Promise<Conversation | null> {
  const closedAt = status === 'closed' ? 'NOW()' : 'NULL';
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET status = $3,
            closed_at = ${closedAt}
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, status],
  );
  return rows[0] ?? null;
}

/** Marca pausa da IA após intervenção humana (fromMe genuíno). */
export async function setHumanPausedUntil(
  tenantId: string,
  id: string,
  until: Date,
): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET human_paused_until = $3,
            status = CASE WHEN status = 'closed' THEN status ELSE 'waiting' END
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, until.toISOString()],
  );
  return rows[0] ?? null;
}

/** Libera a IA na conversa (secretário pediu para continuar atendendo o contato). */
export async function clearHumanPause(
  tenantId: string,
  id: string,
): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET human_paused_until = NULL,
            status = CASE WHEN status = 'waiting' THEN 'open' ELSE status END
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

/** Liga/desliga o cadeado do painel (não afeta IA). */
export async function setConversationLocked(
  tenantId: string,
  id: string,
  locked: boolean,
): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET is_locked = $3
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, locked],
  );
  return rows[0] ?? null;
}

/**
 * Cliente falou de novo: volta a conversa para "open" (aparece em Abertas).
 * Não mexe em human_paused_until — a pausa da IA continua valendo se ainda
 * estiver na janela.
 */
export async function reopenConversationOnInbound(
  tenantId: string,
  id: string,
): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET status = 'open'
      WHERE id = $1 AND tenant_id = $2 AND status = 'waiting'
      RETURNING *`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

/** True se a conversa ainda está na janela de pausa por humano. */
export function isHumanPaused(conversation: Conversation): boolean {
  if (!conversation.human_paused_until) return false;
  const until = Date.parse(conversation.human_paused_until);
  return !Number.isNaN(until) && until > Date.now();
}

/** Apaga a conversa inteira (mensagens caem junto por ON DELETE CASCADE). */
export async function deleteConversation(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM conversations WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function markInboundAsRead(tenantId: string, conversationId: string): Promise<void> {
  await query(
    `UPDATE messages_log
        SET read_at = NOW()
      WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'inbound' AND read_at IS NULL`,
    [tenantId, conversationId],
  );
}
