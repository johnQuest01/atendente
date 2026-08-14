import { assertTenantMatchesScope, query, queryOne } from '../index';

/**
 * Mensagens dono ↔ secretária/agente. Persistidas em tempo real para a IA
 * manter contexto entre mensagens (e após restart do servidor).
 */

export interface OwnerChatMessage {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  owner_phone: string;
  role: 'user' | 'assistant';
  content: string;
  provider_message_id: string | null;
  created_at: string;
}

export async function appendOwnerChatMessage(input: {
  tenantId: string;
  ownerPhone: string;
  role: 'user' | 'assistant';
  content: string;
  connectionId?: string | null;
  providerMessageId?: string | null;
}): Promise<OwnerChatMessage | null> {
  assertTenantMatchesScope(input.tenantId);
  const content = input.content.trim().slice(0, 16000);
  if (!content) return null;

  if (input.providerMessageId) {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM owner_chat_messages
        WHERE tenant_id = $1 AND provider_message_id = $2
        LIMIT 1`,
      [input.tenantId, input.providerMessageId],
    );
    if (existing) return null;
  }

  return queryOne<OwnerChatMessage>(
    `INSERT INTO owner_chat_messages
       (tenant_id, connection_id, owner_phone, role, content, provider_message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.tenantId,
      input.connectionId ?? null,
      input.ownerPhone,
      input.role,
      content,
      input.providerMessageId ?? null,
    ],
  );
}

/** Últimas N mensagens do fio (ordem cronológica crescente). `offset` pula as mais novas. */
export async function listOwnerChatHistory(
  tenantId: string,
  ownerPhone: string,
  opts?: { connectionId?: string | null; limit?: number; offset?: number },
): Promise<OwnerChatMessage[]> {
  assertTenantMatchesScope(tenantId);
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 2000);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const connectionId = opts?.connectionId ?? null;

  if (connectionId) {
    const { rows } = await query<OwnerChatMessage>(
      `SELECT * FROM (
         SELECT * FROM owner_chat_messages
          WHERE tenant_id = $1 AND owner_phone = $2
            AND (connection_id IS NULL OR connection_id = $3)
          ORDER BY created_at DESC
          LIMIT $4 OFFSET $5
       ) t
       ORDER BY created_at ASC`,
      [tenantId, ownerPhone, connectionId, limit, offset],
    );
    return rows;
  }

  const { rows } = await query<OwnerChatMessage>(
    `SELECT * FROM (
       SELECT * FROM owner_chat_messages
        WHERE tenant_id = $1 AND owner_phone = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
     ) t
     ORDER BY created_at ASC`,
    [tenantId, ownerPhone, limit, offset],
  );
  return rows;
}

export async function countOwnerChatMessages(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<number> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const row = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM owner_chat_messages
        WHERE tenant_id = $1 AND owner_phone = $2
          AND (connection_id IS NULL OR connection_id = $3)`,
      [tenantId, ownerPhone, connectionId],
    );
    return Number(row?.n ?? 0);
  }
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM owner_chat_messages
      WHERE tenant_id = $1 AND owner_phone = $2`,
    [tenantId, ownerPhone],
  );
  return Number(row?.n ?? 0);
}
