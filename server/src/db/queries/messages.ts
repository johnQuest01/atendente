import { query } from '../index';
import type { MessageDirection, MessageLog, MessageOrigin, MessageType } from '../../types';

export interface InsertMessageInput {
  conversationId: string;
  direction: MessageDirection;
  type: MessageType;
  content?: string | null;
  audioId?: string | null;
  productId?: string | null;
  zapiMessageId?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  transcription?: string | null;
  origin?: MessageOrigin;
  /** ISO opcional — usado em import/colar para preservar ordem. */
  sentAt?: string | Date | null;
}

export async function insertMessage(tenantId: string, input: InsertMessageInput): Promise<MessageLog> {
  const origin: MessageOrigin =
    input.origin ?? (input.direction === 'inbound' ? 'client' : 'ai');
  const { rows } = await query<MessageLog>(
    `INSERT INTO messages_log
       (tenant_id, conversation_id, direction, type, content, audio_id, product_id,
        zapi_message_id, media_url, media_mime, transcription, origin, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()))
     RETURNING *`,
    [
      tenantId,
      input.conversationId,
      input.direction,
      input.type,
      input.content ?? null,
      input.audioId ?? null,
      input.productId ?? null,
      input.zapiMessageId ?? null,
      input.mediaUrl ?? null,
      input.mediaMime ?? null,
      input.transcription ?? null,
      origin,
      input.sentAt ?? null,
    ],
  );
  return rows[0];
}

/** Evita duplicar msgs coladas/importadas com o mesmo texto e direção. */
export async function messageContentExists(
  tenantId: string,
  conversationId: string,
  direction: MessageDirection,
  content: string,
): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM messages_log
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND direction = $3
          AND content = $4
     ) AS exists`,
    [tenantId, conversationId, direction, content],
  );
  return rows[0]?.exists ?? false;
}

/** Indica se já existe uma mensagem RECEBIDA com este id da Z-API (evita processar 2x). */
export async function inboundMessageExists(tenantId: string, zapiMessageId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM messages_log
       WHERE tenant_id = $1 AND zapi_message_id = $2 AND direction = 'inbound'
     ) AS exists`,
    [tenantId, zapiMessageId],
  );
  return rows[0]?.exists ?? false;
}

/** Qualquer direção — usado para distinguir eco do bot vs digitação humana (fromMe). */
export async function providerMessageExists(tenantId: string, zapiMessageId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM messages_log
       WHERE tenant_id = $1 AND zapi_message_id = $2
     ) AS exists`,
    [tenantId, zapiMessageId],
  );
  return rows[0]?.exists ?? false;
}

export async function markDelivered(tenantId: string, zapiMessageId: string): Promise<void> {
  await query(
    `UPDATE messages_log SET delivered_at = NOW()
      WHERE tenant_id = $1 AND zapi_message_id = $2 AND delivered_at IS NULL`,
    [tenantId, zapiMessageId],
  );
}

export async function markRead(tenantId: string, zapiMessageId: string): Promise<void> {
  await query(
    `UPDATE messages_log SET read_at = NOW()
      WHERE tenant_id = $1 AND zapi_message_id = $2 AND read_at IS NULL`,
    [tenantId, zapiMessageId],
  );
}

/** Busca mensagens por IDs (para apagar/editar no WhatsApp). */
export async function getMessagesByIds(
  tenantId: string,
  conversationId: string,
  ids: string[],
): Promise<MessageLog[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, conversationId, ids],
  );
  return rows;
}

export async function getMessageById(
  tenantId: string,
  conversationId: string,
  messageId: string,
): Promise<MessageLog | null> {
  const { rows } = await query<MessageLog>(
    `SELECT * FROM messages_log
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [tenantId, conversationId, messageId],
  );
  return rows[0] ?? null;
}

export async function updateMessageContent(
  tenantId: string,
  conversationId: string,
  messageId: string,
  content: string,
): Promise<MessageLog | null> {
  const { rows } = await query<MessageLog>(
    `UPDATE messages_log
        SET content = $4
      WHERE tenant_id = $1
        AND conversation_id = $2
        AND id = $3
        AND direction = 'outbound'
        AND type = 'text'
      RETURNING *`,
    [tenantId, conversationId, messageId, content],
  );
  return rows[0] ?? null;
}

/** Apaga mensagens específicas de uma conversa. Retorna a quantidade removida. */
export async function deleteMessages(
  tenantId: string,
  conversationId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await query(
    `DELETE FROM messages_log
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, conversationId, ids],
  );
  return rowCount ?? 0;
}

/** Apaga TODO o histórico de mensagens de uma conversa. Retorna a quantidade removida. */
export async function deleteAllMessages(tenantId: string, conversationId: string): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM messages_log WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, conversationId],
  );
  return rowCount ?? 0;
}
