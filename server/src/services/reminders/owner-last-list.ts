/**
 * Última lista de compromissos mostrada a esta pessoa (secretária ou tool).
 * Usado para "cancele estes" / "risque do caderno" sem depender da IA.
 */

const TTL_MS = 15 * 60_000;
const lists = new Map<string, { at: number; ids: string[] }>();

function key(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

export function rememberOwnerLastList(
  tenantId: string,
  phone: string,
  ids: string[] | undefined,
): void {
  const k = key(tenantId, phone);
  if (!ids?.length) {
    lists.delete(k);
    return;
  }
  lists.set(k, { at: Date.now(), ids: [...ids] });
}

export function getOwnerLastList(tenantId: string, phone: string): string[] {
  const k = key(tenantId, phone);
  const row = lists.get(k);
  if (!row || Date.now() - row.at > TTL_MS) {
    if (row) lists.delete(k);
    return [];
  }
  return row.ids;
}
