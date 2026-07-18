import { query, queryOne } from '../index';
import type { AiHistoryMessage, Conversation, ConversationStatus, MessageLog } from '../../types';

export interface ConversationListItem extends Conversation {
  client_name: string | null;
  client_phone: string;
  company_name: string | null;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count: number;
}

export async function findOpenConversationByClient(
  tenantId: string,
  clientId: string,
): Promise<Conversation | null> {
  return queryOne<Conversation>(
    `SELECT * FROM conversations
      WHERE tenant_id = $1 AND client_id = $2 AND status <> 'closed'
      ORDER BY started_at DESC
      LIMIT 1`,
    [tenantId, clientId],
  );
}

export async function findOrCreateOpenConversation(
  tenantId: string,
  clientId: string,
): Promise<Conversation> {
  const existing = await findOpenConversationByClient(tenantId, clientId);
  if (existing) return existing;

  try {
    const { rows } = await query<Conversation>(
      `INSERT INTO conversations (tenant_id, client_id, status)
       VALUES ($1, $2, 'open')
       RETURNING *`,
      [tenantId, clientId],
    );
    return rows[0];
  } catch (err) {
    // Corrida: outra requisição abriu a conversa ao mesmo tempo e o índice único
    // parcial (uq_conversations_active_per_client) barrou esta. Em vez de propagar
    // o erro, buscamos a conversa ativa que venceu a corrida.
    const open = await findOpenConversationByClient(tenantId, clientId);
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
): Promise<ConversationListItem[]> {
  const params: unknown[] = [tenantId];
  let where = 'WHERE c.tenant_id = $1';
  if (status) {
    params.push(status);
    where += ' AND c.status = $2';
  }

  const { rows } = await query<ConversationListItem>(
    `SELECT
        c.*,
        cl.name AS client_name,
        cl.phone AS client_phone,
        cl.company_name,
        lm.content AS last_message,
        lm.type AS last_message_type,
        lm.sent_at AS last_message_at,
        COALESCE(uc.unread_count, 0)::int AS unread_count
      FROM conversations c
      JOIN clients cl ON cl.id = c.client_id
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
  return rows;
}

export async function getConversationMessages(
  tenantId: string,
  conversationId: string,
  limit = 100,
): Promise<MessageLog[]> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY sent_at ASC
      LIMIT $3`,
    [tenantId, conversationId, limit],
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
