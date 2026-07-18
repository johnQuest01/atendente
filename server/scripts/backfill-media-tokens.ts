/**
 * Reescreve URLs /media/... sem ?t= adicionando o token assinado do tenant.
 * Idempotente: URLs que já têm ?t= (ou &t=) são ignoradas.
 *
 * Uso: npm run backfill-media-tokens --workspace server
 */
import { pool } from '../src/db';
import { signMediaToken } from '../src/utils/media-token';

const MEDIA_PATH_RE = /^(https?:\/\/[^/]+)?(\/media\/(audios|files)\/([0-9a-f-]{36})(?:\.[a-z0-9]+)?)(\?.*)?$/i;

function needsToken(url: string): boolean {
  if (!url.includes('/media/')) return false;
  if (/[?&]t=/.test(url)) return false;
  return MEDIA_PATH_RE.test(url);
}

function withToken(url: string, tenantId: string): string | null {
  const m = url.match(MEDIA_PATH_RE);
  if (!m) return null;
  const origin = m[1] ?? '';
  const path = m[2];
  const id = m[4];
  const token = signMediaToken(tenantId, id);
  // Descarta query antiga (sem t) e anexa só o token.
  return `${origin}${path}?t=${token}`;
}

async function backfillTable(
  label: string,
  selectSql: string,
  updateSql: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; tenant_id: string; url: string }>(selectSql);
  let updated = 0;
  for (const row of rows) {
    if (!needsToken(row.url)) continue;
    const next = withToken(row.url, row.tenant_id);
    if (!next || next === row.url) continue;
    await pool.query(updateSql, [next, row.id, row.tenant_id]);
    updated += 1;
  }
  console.log(`[backfill] ${label}: ${updated} URL(s) atualizada(s) de ${rows.length} candidata(s).`);
  return updated;
}

async function main(): Promise<void> {
  let total = 0;

  total += await backfillTable(
    'audios.file_url',
    `SELECT id, tenant_id, file_url AS url FROM audios
      WHERE file_url LIKE '%/media/%' AND file_url NOT LIKE '%t=%'`,
    'UPDATE audios SET file_url = $1 WHERE id = $2 AND tenant_id = $3',
  );

  total += await backfillTable(
    'messages_log.media_url',
    `SELECT id, tenant_id, media_url AS url FROM messages_log
      WHERE media_url LIKE '%/media/%' AND media_url NOT LIKE '%t=%'`,
    'UPDATE messages_log SET media_url = $1 WHERE id = $2 AND tenant_id = $3',
  );

  // image_urls é text[] — reescreve elemento a elemento.
  const { rows: products } = await pool.query<{
    id: string;
    tenant_id: string;
    image_urls: string[] | null;
  }>(
    `SELECT id, tenant_id, image_urls FROM products
      WHERE image_urls IS NOT NULL AND cardinality(image_urls) > 0`,
  );
  let prodUpdated = 0;
  for (const p of products) {
    const urls = p.image_urls ?? [];
    let changed = false;
    const next = urls.map((u) => {
      if (!needsToken(u)) return u;
      const rewritten = withToken(u, p.tenant_id);
      if (rewritten && rewritten !== u) {
        changed = true;
        return rewritten;
      }
      return u;
    });
    if (!changed) continue;
    await pool.query('UPDATE products SET image_urls = $1 WHERE id = $2 AND tenant_id = $3', [
      next,
      p.id,
      p.tenant_id,
    ]);
    prodUpdated += 1;
  }
  console.log(`[backfill] products.image_urls: ${prodUpdated} produto(s) atualizado(s).`);
  total += prodUpdated;

  console.log(`[backfill] concluído. Total de registros tocados: ${total}.`);
  console.log('[backfill] Depois valide e defina MEDIA_LEGACY_FALLBACK=false.');
  await pool.end();
}

void main().catch(async (err) => {
  console.error('[backfill] falhou:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
