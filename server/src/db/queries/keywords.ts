import { query, queryOne } from '../index';
import type { ContentType, Keyword } from '../../types';

export interface CreateKeywordInput {
  keyword: string;
  intent: string;
  contentType: ContentType;
  contentId?: string | null;
  priority?: number;
}

export async function listKeywords(tenantId: string, activeOnly = false): Promise<Keyword[]> {
  const activeFilter = activeOnly ? 'AND is_active = true' : '';
  const { rows } = await query<Keyword>(
    `SELECT * FROM keywords
      WHERE tenant_id = $1 ${activeFilter}
      ORDER BY priority DESC, keyword ASC`,
    [tenantId],
  );
  return rows;
}

/** Retorna todas as keywords ativas para o matcher (ordenadas por prioridade). */
export async function getActiveKeywords(tenantId: string): Promise<Keyword[]> {
  const { rows } = await query<Keyword>(
    `SELECT * FROM keywords WHERE tenant_id = $1 AND is_active = true ORDER BY priority DESC`,
    [tenantId],
  );
  return rows;
}

export async function getKeywordById(tenantId: string, id: string): Promise<Keyword | null> {
  return queryOne<Keyword>('SELECT * FROM keywords WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

export async function createKeyword(tenantId: string, input: CreateKeywordInput): Promise<Keyword> {
  const { rows } = await query<Keyword>(
    `INSERT INTO keywords (tenant_id, keyword, intent, content_type, content_id, priority)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, input.keyword, input.intent, input.contentType, input.contentId ?? null, input.priority ?? 1],
  );
  return rows[0];
}

export async function updateKeyword(
  tenantId: string,
  id: string,
  patch: Partial<{
    keyword: string;
    intent: string;
    content_type: ContentType;
    content_id: string | null;
    priority: number;
    is_active: boolean;
  }>,
): Promise<Keyword | null> {
  const { rows } = await query<Keyword>(
    `UPDATE keywords SET
       keyword = COALESCE($3, keyword),
       intent = COALESCE($4, intent),
       content_type = COALESCE($5, content_type),
       content_id = COALESCE($6, content_id),
       priority = COALESCE($7, priority),
       is_active = COALESCE($8, is_active)
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [
      id,
      tenantId,
      patch.keyword ?? null,
      patch.intent ?? null,
      patch.content_type ?? null,
      patch.content_id ?? null,
      patch.priority ?? null,
      patch.is_active ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteKeyword(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM keywords WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return (rowCount ?? 0) > 0;
}
