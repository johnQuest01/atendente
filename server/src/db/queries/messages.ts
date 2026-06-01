import { query } from '../index';
import type { MessageDirection, MessageLog, MessageType } from '../../types';

export interface InsertMessageInput {
  conversationId: string;
  direction: MessageDirection;
  type: MessageType;
  content?: string | null;
  audioId?: string | null;
  productId?: string | null;
  zapiMessageId?: string | null;
}

export async function insertMessage(input: InsertMessageInput): Promise<MessageLog> {
  const { rows } = await query<MessageLog>(
    `INSERT INTO messages_log
       (conversation_id, direction, type, content, audio_id, product_id, zapi_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.conversationId,
      input.direction,
      input.type,
      input.content ?? null,
      input.audioId ?? null,
      input.productId ?? null,
      input.zapiMessageId ?? null,
    ],
  );
  return rows[0];
}

export async function markDelivered(zapiMessageId: string): Promise<void> {
  await query(
    `UPDATE messages_log SET delivered_at = NOW() WHERE zapi_message_id = $1 AND delivered_at IS NULL`,
    [zapiMessageId],
  );
}

export async function markRead(zapiMessageId: string): Promise<void> {
  await query(
    `UPDATE messages_log SET read_at = NOW() WHERE zapi_message_id = $1 AND read_at IS NULL`,
    [zapiMessageId],
  );
}
