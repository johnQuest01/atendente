import { query, queryOne } from '../index';

/**
 * Gestao de EMPRESAS (tenants). Usado apenas pelo super-admin (dono da
 * plataforma) para criar e administrar as empresas.
 */

export interface TenantRow {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

/** Linha enriquecida para a lista do super-admin (contadores + conexao). */
export interface TenantSummary extends TenantRow {
  users_count: number;
  has_whatsapp: boolean;
  whatsapp_status: string | null;
}

export async function listTenants(): Promise<TenantSummary[]> {
  const { rows } = await query<TenantSummary>(
    `SELECT t.id, t.name, t.is_active, t.created_at,
            COALESCE(u.cnt, 0)::int AS users_count,
            (wc.tenant_id IS NOT NULL) AS has_whatsapp,
            wc.last_status AS whatsapp_status
       FROM tenants t
       LEFT JOIN (
         SELECT tenant_id, COUNT(*) AS cnt FROM users GROUP BY tenant_id
       ) u ON u.tenant_id = t.id
       LEFT JOIN whatsapp_connections wc ON wc.tenant_id = t.id
      ORDER BY t.created_at ASC`,
  );
  return rows;
}

export async function getTenantById(id: string): Promise<TenantRow | null> {
  return queryOne<TenantRow>(
    'SELECT id, name, is_active, created_at FROM tenants WHERE id = $1',
    [id],
  );
}

export async function createTenant(name: string): Promise<TenantRow> {
  const row = await queryOne<TenantRow>(
    `INSERT INTO tenants (name) VALUES ($1)
     RETURNING id, name, is_active, created_at`,
    [name],
  );
  return row as TenantRow;
}

export async function updateTenant(
  id: string,
  patch: { name?: string; is_active?: boolean },
): Promise<TenantRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`name = $${i}`);
    params.push(patch.name);
    i += 1;
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = $${i}`);
    params.push(patch.is_active);
    i += 1;
  }
  if (sets.length === 0) return getTenantById(id);
  params.push(id);
  return queryOne<TenantRow>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, name, is_active, created_at`,
    params,
  );
}
