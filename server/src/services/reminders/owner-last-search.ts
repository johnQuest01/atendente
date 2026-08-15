/**
 * Última busca na web desta pessoa — para "me manda o link" no áudio seguinte.
 */

const TTL_MS = 30 * 60_000;
const last = new Map<string, { at: number; query: string; urls: string[]; answer: string }>();

function key(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

export function rememberOwnerLastSearch(
  tenantId: string,
  phone: string,
  row: { query: string; urls: string[]; answer?: string },
): void {
  last.set(key(tenantId, phone), {
    at: Date.now(),
    query: row.query,
    urls: row.urls.filter(Boolean).slice(0, 5),
    answer: (row.answer ?? '').slice(0, 500),
  });
}

export function getOwnerLastSearch(
  tenantId: string,
  phone: string,
): { query: string; urls: string[]; answer: string } | null {
  const row = last.get(key(tenantId, phone));
  if (!row || Date.now() - row.at > TTL_MS) {
    if (row) last.delete(key(tenantId, phone));
    return null;
  }
  return row;
}
