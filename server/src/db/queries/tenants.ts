import { query, queryOne, withTransaction } from '../index';

/**
 * Gestao de EMPRESAS (tenants). Usado apenas pelo super-admin (dono da
 * plataforma) para criar e administrar as empresas.
 */

export type TenantAccountStatus = 'trial' | 'active' | 'expired';

export interface TenantRow {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  /** Teto mensal de mensagens de IA no plano base (NULL = ilimitado). */
  ai_message_limit: number | null;
  /** Fim do período de teste (NULL = sem prazo, ex.: a empresa padrão). */
  trial_ends_at: string | null;
  /** trial = avaliação; active = pagante; expired = trial acabou sem conversão. */
  account_status: TenantAccountStatus;
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
    `SELECT t.id, t.name, t.is_active, t.created_at, t.ai_message_limit, t.trial_ends_at, t.account_status,
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

const TENANT_COLS =
  'id, name, is_active, created_at, ai_message_limit, trial_ends_at, account_status';

export async function getTenantById(id: string): Promise<TenantRow | null> {
  return queryOne<TenantRow>(`SELECT ${TENANT_COLS} FROM tenants WHERE id = $1`, [id]);
}

export interface CreateTenantOptions {
  /** Dias de teste a partir de agora. Ausente = sem prazo. */
  trialDays?: number | null;
  aiMessageLimit?: number | null;
}

export async function createTenant(name: string, options: CreateTenantOptions = {}): Promise<TenantRow> {
  const trialDays = options.trialDays ?? null;
  const accountStatus = trialDays == null ? 'active' : 'trial';
  const row = await queryOne<TenantRow>(
    `INSERT INTO tenants (name, ai_message_limit, trial_ends_at, account_status)
     VALUES (
       $1, $2,
       CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() + ($3 || ' days')::interval END,
       $4
     )
     RETURNING ${TENANT_COLS}`,
    [name, options.aiMessageLimit ?? null, trialDays, accountStatus],
  );
  return row as TenantRow;
}

/** Estado de acesso da empresa, consultado pelo middleware a cada requisição. */
export interface TenantAccess {
  is_active: boolean;
  trial_ends_at: string | null;
  account_status: TenantAccountStatus;
}

export async function getTenantAccess(id: string): Promise<TenantAccess | null> {
  return queryOne<TenantAccess>(
    'SELECT is_active, trial_ends_at, account_status FROM tenants WHERE id = $1',
    [id],
  );
}

/** Teste vencido? Sem prazo definido significa acesso liberado. */
export function isTrialExpired(
  access: Pick<TenantAccess, 'trial_ends_at' | 'account_status'>,
): boolean {
  if (access.account_status === 'expired') return true;
  if (!access.trial_ends_at) return false;
  const ends = Date.parse(access.trial_ends_at);
  return !Number.isNaN(ends) && ends <= Date.now();
}

export async function setTenantAccountStatus(
  id: string,
  status: TenantAccountStatus,
): Promise<void> {
  await query(`UPDATE tenants SET account_status = $2 WHERE id = $1`, [id, status]);
}

export async function listExpiredTrialTenants(): Promise<TenantRow[]> {
  const { rows } = await query<TenantRow>(
    `SELECT ${TENANT_COLS} FROM tenants
      WHERE account_status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at <= NOW()`,
  );
  return rows;
}

/**
 * Remove a empresa e tudo ligado a ela (CASCADE).
 * Antes: devolve instâncias do pool Z-API para livre.
 */
export async function deleteTenant(id: string): Promise<boolean> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE instance_pool
          SET state = 'free',
              assigned_tenant_id = NULL,
              assigned_connection_id = NULL,
              updated_at = NOW()
        WHERE assigned_tenant_id = $1`,
      [id],
    );
    const result = await client.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

export async function updateTenant(
  id: string,
  patch: {
    name?: string;
    is_active?: boolean;
    ai_message_limit?: number | null;
    trial_ends_at?: string | null;
    account_status?: TenantAccountStatus;
  },
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
  if (patch.trial_ends_at !== undefined) {
    sets.push(`trial_ends_at = $${i}`);
    params.push(patch.trial_ends_at);
    i += 1;
  }
  if (patch.account_status !== undefined) {
    sets.push(`account_status = $${i}`);
    params.push(patch.account_status);
    i += 1;
  }
  if (sets.length === 0) return getTenantById(id);
  params.push(id);
  return queryOne<TenantRow>(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING ${TENANT_COLS}`,
    params,
  );
}
