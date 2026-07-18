import { query, queryOne } from '../index';

export interface InsertMediaFileInput {
  kind?: string;
  mime: string;
  data: Buffer;
  sizeKb?: number | null;
}

/** Salva um arquivo binário no banco e retorna o id gerado. */
export async function insertMediaFile(tenantId: string, input: InsertMediaFileInput): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO media_files (tenant_id, kind, mime, data, size_kb)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, input.kind ?? 'image', input.mime, input.data, input.sizeKb ?? null],
  );
  return rows[0].id;
}

/**
 * Lê os bytes de um arquivo de mídia (para servir em /media/files/:id).
 * Com tenant (token): filtra por empresa. Sem tenant: só no fallback legado.
 */
export async function getMediaFile(
  id: string,
  tenantId: string | null,
): Promise<{ data: Buffer; mime: string } | null> {
  const row = tenantId
    ? await queryOne<{ data: Buffer | null; mime: string | null }>(
        'SELECT data, mime FROM media_files WHERE id = $1 AND tenant_id = $2',
        [id, tenantId],
      )
    : await queryOne<{ data: Buffer | null; mime: string | null }>(
        'SELECT data, mime FROM media_files WHERE id = $1',
        [id],
      );
  if (!row || !row.data) return null;
  return { data: row.data, mime: row.mime ?? 'application/octet-stream' };
}
