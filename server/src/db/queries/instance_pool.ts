import { query, queryOne, withTransaction } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';
import type { WhatsappSecrets } from './whatsapp_connections';

export type PoolState = 'free' | 'in_use';
export type PoolProviderMode = 'web' | 'phoneless';

export interface InstancePoolRow {
  id: string;
  secrets_encrypted: string;
  provider_mode: PoolProviderMode;
  state: PoolState;
  assigned_tenant_id: string | null;
  assigned_connection_id: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface PoolSecrets {
  instanceId: string;
  token: string;
  clientToken?: string;
}

function decodeSecrets(enc: string): PoolSecrets {
  const parsed = JSON.parse(decryptSecret(enc)) as WhatsappSecrets;
  return {
    instanceId: parsed.instanceId ?? '',
    token: parsed.token ?? '',
    clientToken: parsed.clientToken,
  };
}

export function encodePoolSecrets(secrets: PoolSecrets): string {
  return encryptSecret(
    JSON.stringify({
      instanceId: secrets.instanceId,
      token: secrets.token,
      clientToken: secrets.clientToken,
    } satisfies WhatsappSecrets),
  );
}

/** Insere instância já assinada no pool (admin/ops). */
export async function addPoolInstance(input: {
  secrets: PoolSecrets;
  providerMode?: PoolProviderMode;
  label?: string | null;
}): Promise<InstancePoolRow> {
  const row = await queryOne<InstancePoolRow>(
    `INSERT INTO instance_pool (secrets_encrypted, provider_mode, state, label)
     VALUES ($1, $2, 'free', $3)
     RETURNING *`,
    [encodePoolSecrets(input.secrets), input.providerMode ?? 'web', input.label ?? null],
  );
  return row as InstancePoolRow;
}

/** Reserva uma instância livre (FOR UPDATE SKIP LOCKED). */
export async function claimFreePoolInstance(
  tenantId: string,
  providerMode: PoolProviderMode = 'web',
): Promise<{ row: InstancePoolRow; secrets: PoolSecrets } | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<InstancePoolRow>(
      `SELECT * FROM instance_pool
        WHERE state = 'free' AND provider_mode = $1
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [providerMode],
    );
    const row = rows[0];
    if (!row) return null;

    const { rows: updated } = await client.query<InstancePoolRow>(
      `UPDATE instance_pool
          SET state = 'in_use',
              assigned_tenant_id = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, tenantId],
    );
    const next = updated[0];
    return { row: next, secrets: decodeSecrets(next.secrets_encrypted) };
  });
}

export async function bindPoolToConnection(poolId: string, connectionId: string): Promise<void> {
  await query(
    `UPDATE instance_pool
        SET assigned_connection_id = $2, updated_at = NOW()
      WHERE id = $1`,
    [poolId, connectionId],
  );
}

/** Devolve ao pool (fim de trial sem conversão). */
export async function releasePoolInstance(poolId: string): Promise<void> {
  await query(
    `UPDATE instance_pool
        SET state = 'free',
            assigned_tenant_id = NULL,
            assigned_connection_id = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [poolId],
  );
}

export async function getPoolInstance(id: string): Promise<InstancePoolRow | null> {
  return queryOne<InstancePoolRow>(`SELECT * FROM instance_pool WHERE id = $1`, [id]);
}

export function secretsFromPoolRow(row: InstancePoolRow): PoolSecrets {
  return decodeSecrets(row.secrets_encrypted);
}

export async function countFreePool(providerMode: PoolProviderMode = 'web'): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM instance_pool WHERE state = 'free' AND provider_mode = $1`,
    [providerMode],
  );
  return Number(row?.n ?? 0);
}

/** Lista pool sem expor secrets (admin/ops). */
export async function listPoolInstances(): Promise<
  Array<{
    id: string;
    provider_mode: PoolProviderMode;
    state: PoolState;
    assigned_tenant_id: string | null;
    assigned_connection_id: string | null;
    label: string | null;
    created_at: string;
    updated_at: string;
  }>
> {
  type PoolListRow = {
    id: string;
    provider_mode: PoolProviderMode;
    state: PoolState;
    assigned_tenant_id: string | null;
    assigned_connection_id: string | null;
    label: string | null;
    created_at: string;
    updated_at: string;
  };
  const { rows } = await query<PoolListRow>(
    `SELECT id, provider_mode, state, assigned_tenant_id, assigned_connection_id,
            label, created_at, updated_at
       FROM instance_pool
      ORDER BY state ASC, created_at ASC`,
  );
  return rows;
}
