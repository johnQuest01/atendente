import { assertTenantMatchesScope, query, queryOne } from '../index';

/** Classificação semântica feita pela IA (não por keyword). */
export type OwnerMemoryKind =
  | 'fato'
  | 'evento'
  | 'acontecimento'
  | 'historia'
  | 'problema'
  | 'preferencia'
  | 'acao';

export const OWNER_MEMORY_KINDS: OwnerMemoryKind[] = [
  'fato',
  'evento',
  'acontecimento',
  'historia',
  'problema',
  'preferencia',
  'acao',
];

export interface OwnerMemory {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  owner_phone: string;
  kind: OwnerMemoryKind;
  summary: string;
  occurred_at: string | null;
  source: string | null;
  created_at: string;
}

export async function insertOwnerMemory(input: {
  tenantId: string;
  ownerPhone: string;
  kind: OwnerMemoryKind;
  summary: string;
  connectionId?: string | null;
  occurredAt?: Date | null;
  source?: string | null;
}): Promise<OwnerMemory | null> {
  assertTenantMatchesScope(input.tenantId);
  const summary = input.summary.trim().slice(0, 800);
  if (summary.length < 4) return null;

  return queryOne<OwnerMemory>(
    `INSERT INTO owner_memories
       (tenant_id, connection_id, owner_phone, kind, summary, occurred_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.tenantId,
      input.connectionId ?? null,
      input.ownerPhone,
      input.kind,
      summary,
      input.occurredAt ?? null,
      input.source?.slice(0, 80) ?? null,
    ],
  );
}

export async function ownerMemorySummaryExists(
  tenantId: string,
  ownerPhone: string,
  summary: string,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM owner_memories
        WHERE tenant_id = $1 AND owner_phone = $2
          AND lower(summary) = lower($3)
          AND created_at > NOW() - INTERVAL '60 days'
     ) AS exists`,
    [tenantId, ownerPhone, summary.trim()],
  );
  return row?.exists ?? false;
}

/** Mais recentes primeiro; caller formata para o prompt. */
export async function listOwnerMemories(
  tenantId: string,
  ownerPhone: string,
  opts?: { connectionId?: string | null; limit?: number },
): Promise<OwnerMemory[]> {
  assertTenantMatchesScope(tenantId);
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 80);
  const connectionId = opts?.connectionId ?? null;

  if (connectionId) {
    const { rows } = await query<OwnerMemory>(
      `SELECT * FROM owner_memories
        WHERE tenant_id = $1 AND owner_phone = $2
          AND (connection_id IS NULL OR connection_id = $3)
        ORDER BY COALESCE(occurred_at, created_at) DESC
        LIMIT $4`,
      [tenantId, ownerPhone, connectionId, limit],
    );
    return rows;
  }

  const { rows } = await query<OwnerMemory>(
    `SELECT * FROM owner_memories
      WHERE tenant_id = $1 AND owner_phone = $2
      ORDER BY COALESCE(occurred_at, created_at) DESC
      LIMIT $3`,
    [tenantId, ownerPhone, limit],
  );
  return rows;
}
