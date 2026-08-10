import { query, queryOne } from '../index';

export type MemoryKind = 'fato' | 'evento' | 'preferencia' | 'sensivel';

export interface ClientMemory {
  id: string;
  tenant_id: string;
  client_id: string;
  kind: MemoryKind;
  summary: string;
  is_sensitive: boolean;
  follow_up_at: string | null;
  source_message_id: string | null;
  expires_at: string | null;
  created_at: string;
}

export async function listClientMemories(
  tenantId: string,
  clientId: string,
  limit = 20,
): Promise<ClientMemory[]> {
  const { rows } = await query<ClientMemory>(
    `SELECT * FROM client_memories
      WHERE tenant_id = $1 AND client_id = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, clientId, limit],
  );
  return rows;
}

export async function insertClientMemory(
  tenantId: string,
  input: {
    clientId: string;
    kind: MemoryKind;
    summary: string;
    isSensitive?: boolean;
    followUpAt?: Date | null;
    sourceMessageId?: string | null;
    expiresAt?: Date | null;
  },
): Promise<ClientMemory> {
  const { rows } = await query<ClientMemory>(
    `INSERT INTO client_memories
       (tenant_id, client_id, kind, summary, is_sensitive, follow_up_at, source_message_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      tenantId,
      input.clientId,
      input.kind,
      input.summary.trim().slice(0, 500),
      input.isSensitive ?? false,
      input.followUpAt ?? null,
      input.sourceMessageId ?? null,
      input.expiresAt ?? null,
    ],
  );
  return rows[0];
}

/** Evita duplicar o mesmo resumo recente (janela de 30 dias). */
export async function memorySummaryExists(
  tenantId: string,
  clientId: string,
  summary: string,
): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM client_memories
        WHERE tenant_id = $1 AND client_id = $2
          AND lower(summary) = lower($3)
          AND created_at > NOW() - INTERVAL '30 days'
     ) AS exists`,
    [tenantId, clientId, summary.trim()],
  );
  return row?.exists ?? false;
}

export async function deleteClientMemory(
  tenantId: string,
  clientId: string,
  memoryId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM client_memories
      WHERE tenant_id = $1 AND client_id = $2 AND id = $3`,
    [tenantId, clientId, memoryId],
  );
  return (rowCount ?? 0) > 0;
}

/** Job LGPD: remove memórias vencidas. */
export async function purgeExpiredMemories(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM client_memories WHERE expires_at IS NOT NULL AND expires_at <= NOW()`,
  );
  return rowCount ?? 0;
}
