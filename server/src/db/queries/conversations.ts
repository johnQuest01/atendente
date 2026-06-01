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

export async function findOpenConversationByClient(clientId: string): Promise<Conversation | null> {
  return queryOne<Conversation>(
    `SELECT * FROM conversations
      WHERE client_id = $1 AND status <> 'closed'
      ORDER BY started_at DESC
      LIMIT 1`,
    [clientId],
  );
}

export async function findOrCreateOpenConversation(clientId: string): Promise<Conversation> {
  const existing = await findOpenConversationByClient(clientId);
  if (existing) return existing;

  const { rows } = await query<Conversation>(
    `INSERT INTO conversations (client_id, status)
     VALUES ($1, 'open')
     RETURNING *`,
    [clientId],
  );
  return rows[0];
}

export async function getConversationById(id: string): Promise<Conversation | null> {
  return queryOne<Conversation>('SELECT * FROM conversations WHERE id = $1', [id]);
}

export async function listConversations(status?: ConversationStatus): Promise<ConversationListItem[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE c.status = $1';
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

export async function getConversationMessages(conversationId: string, limit = 100): Promise<MessageLog[]> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE conversation_id = $1
      ORDER BY sent_at ASC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows;
}

export async function getRecentMessages(conversationId: string, limit = 10): Promise<MessageLog[]> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE conversation_id = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

/**
 * Histórico recente enriquecido para a IA: traz a transcrição do áudio e o
 * nome do produto referenciados, para que o Claude "entenda" turnos que não
 * são texto puro (áudios e imagens enviados).
 */
export async function getRecentMessagesForAI(
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
      WHERE m.conversation_id = $1
      ORDER BY m.sent_at DESC
      LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

export async function updateConversationStatus(
  id: string,
  status: ConversationStatus,
): Promise<Conversation | null> {
  const closedAt = status === 'closed' ? 'NOW()' : 'NULL';
  const { rows } = await query<Conversation>(
    `UPDATE conversations
        SET status = $2,
            closed_at = ${closedAt}
      WHERE id = $1
      RETURNING *`,
    [id, status],
  );
  return rows[0] ?? null;
}

/** Apaga a conversa inteira (mensagens caem junto por ON DELETE CASCADE). */
export async function deleteConversation(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM conversations WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function markInboundAsRead(conversationId: string): Promise<void> {
  await query(
    `UPDATE messages_log
        SET read_at = NOW()
      WHERE conversation_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
    [conversationId],
  );
}
