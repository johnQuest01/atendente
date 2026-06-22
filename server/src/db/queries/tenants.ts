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
  /** Teto mensal de mensagens de IA no plano base (NULL = ilimitado). */
  ai_message_limit: number | null;
}

/** Linha enriquecida para a lista do super-admin (contadores + conexao + uso de IA). */
export interface TenantSummary extends TenantRow {
  users_count: number;
  has_whatsapp: boolean;
  whatsapp_status: string | null;
  /** Mensagens de IA (pagas pela plataforma) usadas no mes atual. */
  ai_used: number;
}

export async function listTenants(): Promise<TenantSummary[]> {
  const { rows } = await query<TenantSummary>(
    `SELECT t.id, t.name, t.is_active, t.created_at, t.ai_message_limit,
            COALESCE(u.cnt, 0)::int AS users_count,
            (wc.tenant_id IS NOT NULL) AS has_whatsapp,
            wc.last_status AS whatsapp_status,
            COALESCE(au.used, 0)::int AS ai_used
       FROM tenants t
       LEFT JOIN (
         SELECT tenant_id, COUNT(*) AS cnt FROM users GROUP BY tenant_id
       ) u ON u.tenant_id = t.id
       LEFT JOIN whatsapp_connections wc ON wc.tenant_id = t.id
       LEFT JOIN ai_usage au
         ON au.tenant_id = t.id
        AND au.ym = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM')
      ORDER BY t.created_at ASC`,
  );
  return rows;
}

export async function getTenantById(id: string): Promise<TenantRow | null> {
  return queryOne<TenantRow>(
    'SELECT id, name, is_active, created_at, ai_message_limit FROM tenants WHERE id = $1',
    [id],
  );
}

export async function createTenant(name: string): Promise<TenantRow> {
  const row = await queryOne<TenantRow>(
    `INSERT INTO tenants (name) VALUES ($1)
     RETURNING id, name, is_active, created_at, ai_message_limit`,
    [name],
  );
  return row as TenantRow;
}

export async function updateTenant(
  id: string,
  patch: { name?: string; is_active?: boolean; ai_message_limit?: number | null },
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
  if (patch.ai_message_limit !== undefined) {
    sets.push(`ai_message_limit = $${i}`);
    params.push(patch.ai_message_limit);
    i += 1;
  }
  if (sets.length === 0) return getTenantById(id);
  params.push(id);
  return queryOne<TenantRow>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, name, is_active, created_at, ai_message_limit`,
    params,
  );
}
