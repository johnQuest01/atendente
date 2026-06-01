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
 * Cache em memória do conjunto de números ativamente bloqueados. Evita
 * consultar o banco a cada mensagem recebida (caminho quente do webhook).
 * É invalidado a cada escrita e expira sozinho pelo TTL.
 */
let blockedCache: { set: Set<string>; at: number } | null = null;
const CACHE_TTL_MS = 5_000;

function invalidateCache(): void {
  blockedCache = null;
}

export async function isPhoneBlocked(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  if (!blockedCache || Date.now() - blockedCache.at >= CACHE_TTL_MS) {
    const { rows } = await query<{ phone: string }>(
      `SELECT phone FROM blocked_numbers WHERE is_active = true`,
    );
    blockedCache = { set: new Set(rows.map((r) => r.phone)), at: Date.now() };
  }
  return blockedCache.set.has(normalized);
}

export async function listBlockedNumbers(): Promise<BlockedNumber[]> {
  const { rows } = await query<BlockedNumber>(
    `SELECT * FROM blocked_numbers ORDER BY created_at DESC`,
  );
  return rows;
}

export async function addBlockedNumber(phone: string, label?: string | null): Promise<BlockedNumber> {
  const normalized = normalizePhone(phone);
  const { rows } = await query<BlockedNumber>(
    `INSERT INTO blocked_numbers (phone, label)
     VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET label = COALESCE(EXCLUDED.label, blocked_numbers.label), is_active = true
     RETURNING *`,
    [normalized, label ?? null],
  );
  invalidateCache();
  return rows[0];
}

export async function setBlockedActive(id: string, isActive: boolean): Promise<BlockedNumber | null> {
  const { rows } = await query<BlockedNumber>(
    `UPDATE blocked_numbers SET is_active = $2 WHERE id = $1 RETURNING *`,
    [id, isActive],
  );
  invalidateCache();
  return rows[0] ?? null;
}

export async function deleteBlockedNumber(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM blocked_numbers WHERE id = $1`, [id]);
  invalidateCache();
  return (rowCount ?? 0) > 0;
}
