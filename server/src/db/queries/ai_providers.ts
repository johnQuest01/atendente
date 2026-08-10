import { query, queryOne } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';

/**
 * Provedores de IA. Escopo por `tenant_id` (NULL = global da plataforma).
 * `connection_id` NULL = atende TODAS as instâncias WhatsApp da empresa;
 * UUID = só aquela conexão/número.
 */

export type AiKind = 'anthropic' | 'openai' | 'gemini';

export interface AiProvider {
  id: string;
  tenant_id: string | null;
  connection_id: string | null;
  kind: AiKind;
  label: string;
  apiKey: string | null;
  base_url: string | null;
  model: string;
  priority: number;
  is_active: boolean;
  last_status: string | null;
  last_error: string | null;
  last_used_at: string | null;
  cooldown_until: string | null;
}

interface AiProviderRow {
  id: string;
  tenant_id: string | null;
  connection_id: string | null;
  kind: AiKind;
  label: string;
  api_key_encrypted: string | null;
  base_url: string | null;
  model: string;
  priority: number;
  is_active: boolean;
  last_status: string | null;
  last_error: string | null;
  last_used_at: string | null;
  cooldown_until: string | null;
}

const COLS =
  'id, tenant_id, connection_id, kind, label, api_key_encrypted, base_url, model, priority, is_active, last_status, last_error, last_used_at, cooldown_until';

function decodeKey(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

function mapRow(row: AiProviderRow): AiProvider {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connection_id: row.connection_id ?? null,
    kind: row.kind,
    label: row.label,
    apiKey: decodeKey(row.api_key_encrypted),
    base_url: row.base_url,
    model: row.model,
    priority: row.priority,
    is_active: row.is_active,
    last_status: row.last_status,
    last_error: row.last_error,
    last_used_at: row.last_used_at,
    cooldown_until: row.cooldown_until,
  };
}

/** Lista os provedores de um escopo (empresa ou global), por prioridade. */
export async function listAiProviders(tenantId: string | null): Promise<AiProvider[]> {
  const { rows } = await query<AiProviderRow>(
    `SELECT ${COLS} FROM ai_providers
      WHERE tenant_id IS NOT DISTINCT FROM $1
      ORDER BY priority ASC, created_at ASC`,
    [tenantId],
  );
  return rows.map(mapRow);
}

/**
 * Ativos do escopo para a corrente de failover.
 * Com `connectionId`: inclui os daquela instância + os de “todas” (connection_id NULL).
 * Dedicados à instância vêm antes dos gerais (mesmo priority).
 */
export async function listActiveAiProviders(
  tenantId: string | null,
  connectionId?: string | null,
): Promise<AiProvider[]> {
  if (!connectionId) {
    const { rows } = await query<AiProviderRow>(
      `SELECT ${COLS} FROM ai_providers
        WHERE tenant_id IS NOT DISTINCT FROM $1 AND is_active = true
        ORDER BY priority ASC, created_at ASC`,
      [tenantId],
    );
    return rows.map(mapRow);
  }

  const { rows } = await query<AiProviderRow>(
    `SELECT ${COLS} FROM ai_providers
      WHERE tenant_id IS NOT DISTINCT FROM $1
        AND is_active = true
        AND (connection_id IS NULL OR connection_id = $2)
      ORDER BY
        CASE WHEN connection_id = $2 THEN 0 ELSE 1 END,
        priority ASC,
        created_at ASC`,
    [tenantId, connectionId],
  );
  return rows.map(mapRow);
}

export async function getAiProviderById(
  id: string,
  tenantId: string | null,
): Promise<AiProvider | null> {
  const row = await queryOne<AiProviderRow>(
    `SELECT ${COLS} FROM ai_providers WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2`,
    [id, tenantId],
  );
  return row ? mapRow(row) : null;
}

export async function countAiProviders(tenantId: string | null): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT COUNT(*)::int AS count FROM ai_providers WHERE tenant_id IS NOT DISTINCT FROM $1',
    [tenantId],
  );
  return row ? Number(row.count) : 0;
}

export interface CreateAiProviderInput {
  tenantId: string | null;
  kind: AiKind;
  label: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model: string;
  priority?: number;
  isActive?: boolean;
  /** null/undefined = todas as instâncias WhatsApp. */
  connectionId?: string | null;
}

export async function createAiProvider(input: CreateAiProviderInput): Promise<AiProvider> {
  const enc = input.apiKey ? encryptSecret(input.apiKey) : null;
  const row = await queryOne<AiProviderRow>(
    `INSERT INTO ai_providers
       (tenant_id, connection_id, kind, label, api_key_encrypted, base_url, model, priority, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.connectionId ?? null,
      input.kind,
      input.label,
      enc,
      input.baseUrl ?? null,
      input.model,
      input.priority ?? 100,
      input.isActive ?? true,
    ],
  );
  return mapRow(row as AiProviderRow);
}

export interface UpdateAiProviderInput {
  label?: string;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  priority?: number;
  isActive?: boolean;
  /** Passar null para “todas”; undefined = não alterar. */
  connectionId?: string | null;
}

export async function updateAiProvider(
  id: string,
  tenantId: string | null,
  patch: UpdateAiProviderInput,
): Promise<AiProvider | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${i}`);
    params.push(val);
    i += 1;
  };

  if (patch.label !== undefined) push('label', patch.label);
  if (patch.apiKey) push('api_key_encrypted', encryptSecret(patch.apiKey));
  if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl);
  if (patch.model !== undefined) push('model', patch.model);
  if (patch.priority !== undefined) push('priority', patch.priority);
  if (patch.isActive !== undefined) push('is_active', patch.isActive);
  if (patch.connectionId !== undefined) push('connection_id', patch.connectionId);

  if (sets.length === 0) return getAiProviderById(id, tenantId);
  sets.push('cooldown_until = NULL', 'updated_at = NOW()');
  params.push(id);
  const idIdx = i;
  i += 1;
  params.push(tenantId);

  const row = await queryOne<AiProviderRow>(
    `UPDATE ai_providers SET ${sets.join(', ')}
      WHERE id = $${idIdx} AND tenant_id IS NOT DISTINCT FROM $${i}
      RETURNING ${COLS}`,
    params,
  );
  return row ? mapRow(row) : null;
}

export async function deleteAiProvider(id: string, tenantId: string | null): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM ai_providers WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2',
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateAiRuntime(
  id: string,
  state: { status: string; error?: string | null; cooldownUntil?: Date | null },
): Promise<void> {
  await query(
    `UPDATE ai_providers
        SET last_status = $2,
            last_error = $3,
            last_used_at = NOW(),
            cooldown_until = $4
      WHERE id = $1`,
    [id, state.status, state.error ?? null, state.cooldownUntil ?? null],
  );
}
