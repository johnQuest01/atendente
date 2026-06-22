import { query, queryOne } from '../index';
import { encryptSecret, decryptSecret } from '../../utils/crypto';

/**
 * Provedores de IA da plataforma (config GLOBAL). A chave de API fica cifrada
 * em `api_key_encrypted`; a descriptografia acontece somente aqui.
 */

export type AiKind = 'anthropic' | 'openai' | 'gemini';

export interface AiProvider {
  id: string;
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
  'id, kind, label, api_key_encrypted, base_url, model, priority, is_active, last_status, last_error, last_used_at, cooldown_until';

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

export async function listAiProviders(): Promise<AiProvider[]> {
  const { rows } = await query<AiProviderRow>(
    `SELECT ${COLS} FROM ai_providers ORDER BY priority ASC, created_at ASC`,
  );
  return rows.map(mapRow);
}

/** Apenas os provedores ativos, na ordem de tentativa do failover. */
export async function listActiveAiProviders(): Promise<AiProvider[]> {
  const { rows } = await query<AiProviderRow>(
    `SELECT ${COLS} FROM ai_providers WHERE is_active = true ORDER BY priority ASC, created_at ASC`,
  );
  return rows.map(mapRow);
}

export async function getAiProviderById(id: string): Promise<AiProvider | null> {
  const row = await queryOne<AiProviderRow>(`SELECT ${COLS} FROM ai_providers WHERE id = $1`, [id]);
  return row ? mapRow(row) : null;
}

export async function countAiProviders(): Promise<number> {
  const row = await queryOne<{ count: string }>('SELECT COUNT(*)::int AS count FROM ai_providers');
  return row ? Number(row.count) : 0;
}

export interface CreateAiProviderInput {
  kind: AiKind;
  label: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model: string;
  priority?: number;
  isActive?: boolean;
}

export async function createAiProvider(input: CreateAiProviderInput): Promise<AiProvider> {
  const enc = input.apiKey ? encryptSecret(input.apiKey) : null;
  const row = await queryOne<AiProviderRow>(
    `INSERT INTO ai_providers (kind, label, api_key_encrypted, base_url, model, priority, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLS}`,
    [
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
  /** Vazio/undefined = mantém a chave atual. */
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  priority?: number;
  isActive?: boolean;
}

export async function updateAiProvider(
  id: string,
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

  if (sets.length === 0) return getAiProviderById(id);
  // Reativar/editar zera o cooldown para o provedor voltar a ser tentado já.
  sets.push('cooldown_until = NULL', 'updated_at = NOW()');
  params.push(id);

  const row = await queryOne<AiProviderRow>(
    `UPDATE ai_providers SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${COLS}`,
    params,
  );
  return row ? mapRow(row) : null;
}

export async function deleteAiProvider(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM ai_providers WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

/** Atualiza o estado de runtime após uma tentativa (sucesso ou falha + cooldown). */
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
