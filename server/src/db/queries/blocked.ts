import { query } from '../index';

export interface BlockedNumber {
  id: string;
  phone: string;
  label: string | null;
  is_active: boolean;
  created_at: string;
}

/** Normaliza um telefone para apenas dígitos (mesmo formato do webhook). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Cache em memória, POR tenant, do conjunto de números ativamente bloqueados.
 * Evita consultar o banco a cada mensagem recebida (caminho quente do webhook).
 * É invalidado a cada escrita do tenant e cada entrada expira pelo TTL.
 */
const blockedCache = new Map<string, { set: Set<string>; at: number }>();
const CACHE_TTL_MS = 5_000;

function invalidateCache(tenantId: string): void {
  blockedCache.delete(tenantId);
}

export async function isPhoneBlocked(tenantId: string, phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const set = await getActiveBlockedPhones(tenantId);
  return set.has(normalized);
}

/** Conjunto de telefones (só dígitos) com bloqueio ativo neste tenant. */
export async function getActiveBlockedPhones(tenantId: string): Promise<Set<string>> {
  const cached = blockedCache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.set;
  }
  const { rows } = await query<{ phone: string }>(
    `SELECT phone FROM blocked_numbers WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );
  const fresh = { set: new Set(rows.map((r) => r.phone)), at: Date.now() };
  blockedCache.set(tenantId, fresh);
  return fresh.set;
}

export async function listBlockedNumbers(tenantId: string): Promise<BlockedNumber[]> {
  const { rows } = await query<BlockedNumber>(
    `SELECT * FROM blocked_numbers WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function addBlockedNumber(
  tenantId: string,
  phone: string,
  label?: string | null,
): Promise<BlockedNumber> {
  const normalized = normalizePhone(phone);
  const { rows } = await query<BlockedNumber>(
    `INSERT INTO blocked_numbers (tenant_id, phone, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE
       SET label = COALESCE(EXCLUDED.label, blocked_numbers.label), is_active = true
     RETURNING *`,
    [tenantId, normalized, label ?? null],
  );
  invalidateCache(tenantId);
  return rows[0];
}

export async function setBlockedActive(
  tenantId: string,
  id: string,
  isActive: boolean,
): Promise<BlockedNumber | null> {
  const { rows } = await query<BlockedNumber>(
    `UPDATE blocked_numbers SET is_active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, isActive],
  );
  invalidateCache(tenantId);
  return rows[0] ?? null;
}

export async function deleteBlockedNumber(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM blocked_numbers WHERE id = $1 AND tenant_id = $2`, [
    id,
    tenantId,
  ]);
  invalidateCache(tenantId);
  return (rowCount ?? 0) > 0;
}
