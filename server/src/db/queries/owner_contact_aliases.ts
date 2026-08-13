import { assertTenantMatchesScope, query, queryOne } from '../index';

export interface OwnerContactAlias {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  owner_phone: string;
  alias_key: string;
  client_id: string;
  created_at: string;
  updated_at: string;
  client_name?: string | null;
  client_phone?: string | null;
}

export async function upsertOwnerContactAlias(input: {
  tenantId: string;
  ownerPhone: string;
  aliasKey: string;
  clientId: string;
  connectionId?: string | null;
}): Promise<OwnerContactAlias | null> {
  assertTenantMatchesScope(input.tenantId);
  const aliasKey = input.aliasKey.trim().toLowerCase().slice(0, 80);
  if (aliasKey.length < 2) return null;
  const connectionId = input.connectionId ?? null;

  const existing = await queryOne<OwnerContactAlias>(
    `SELECT * FROM owner_contact_aliases
      WHERE tenant_id = $1 AND owner_phone = $2 AND alias_key = $3
        AND connection_id IS NOT DISTINCT FROM $4`,
    [input.tenantId, input.ownerPhone, aliasKey, connectionId],
  );

  if (existing) {
    return queryOne<OwnerContactAlias>(
      `UPDATE owner_contact_aliases
          SET client_id = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [input.tenantId, existing.id, input.clientId],
    );
  }

  return queryOne<OwnerContactAlias>(
    `INSERT INTO owner_contact_aliases
       (tenant_id, connection_id, owner_phone, alias_key, client_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenantId, connectionId, input.ownerPhone, aliasKey, input.clientId],
  );
}

export async function findOwnerContactAlias(input: {
  tenantId: string;
  ownerPhone: string;
  aliasKeys: string[];
  connectionId?: string | null;
}): Promise<OwnerContactAlias | null> {
  assertTenantMatchesScope(input.tenantId);
  const keys = [...new Set(input.aliasKeys.map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (!keys.length) return null;
  const connectionId = input.connectionId ?? null;

  return queryOne<OwnerContactAlias>(
    `SELECT a.*, c.name AS client_name, c.phone AS client_phone
       FROM owner_contact_aliases a
       JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.owner_phone = $2
        AND a.alias_key = ANY($3::text[])
        AND (a.connection_id IS NULL OR a.connection_id IS NOT DISTINCT FROM $4)
      ORDER BY
        CASE WHEN a.connection_id IS NOT DISTINCT FROM $4 THEN 0 ELSE 1 END,
        CASE WHEN a.alias_key = $5 THEN 0 ELSE 1 END,
        a.updated_at DESC
      LIMIT 1`,
    [input.tenantId, input.ownerPhone, keys, connectionId, keys[0]],
  );
}

export async function listOwnerContactAliases(
  tenantId: string,
  ownerPhone: string,
  opts?: { connectionId?: string | null; limit?: number },
): Promise<OwnerContactAlias[]> {
  assertTenantMatchesScope(tenantId);
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 40);
  const connectionId = opts?.connectionId ?? null;

  const { rows } = await query<OwnerContactAlias>(
    `SELECT * FROM (
        SELECT DISTINCT ON (a.alias_key)
               a.*, c.name AS client_name, c.phone AS client_phone
          FROM owner_contact_aliases a
          JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
         WHERE a.tenant_id = $1 AND a.owner_phone = $2
           AND (a.connection_id IS NULL OR a.connection_id IS NOT DISTINCT FROM $3)
         ORDER BY a.alias_key, a.updated_at DESC
      ) x
      ORDER BY x.updated_at DESC
      LIMIT $4`,
    [tenantId, ownerPhone, connectionId, limit],
  );
  return rows;
}
