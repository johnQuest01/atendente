import { query, queryOne } from '../index';
import type { ContentType, Keyword } from '../../types';

export interface CreateKeywordInput {
  keyword: string;
  intent: string;
  contentType: ContentType;
  contentId?: string | null;
  priority?: number;
}

export async function listKeywords(activeOnly = false): Promise<Keyword[]> {
  const where = activeOnly ? 'WHERE is_active = true' : '';
  const { rows } = await query<Keyword>(
    `SELECT * FROM keywords ${where} ORDER BY priority DESC, keyword ASC`,
  );
  return rows;
}

/** Retorna todas as keywords ativas para o matcher (ordenadas por prioridade). */
export async function getActiveKeywords(): Promise<Keyword[]> {
  const { rows } = await query<Keyword>(
    `SELECT * FROM keywords WHERE is_active = true ORDER BY priority DESC`,
  );
  return rows;
}

export async function getKeywordById(id: string): Promise<Keyword | null> {
  return queryOne<Keyword>('SELECT * FROM keywords WHERE id = $1', [id]);
}

export async function createKeyword(input: CreateKeywordInput): Promise<Keyword> {
  const { rows } = await query<Keyword>(
    `INSERT INTO keywords (keyword, intent, content_type, content_id, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.keyword, input.intent, input.contentType, input.contentId ?? null, input.priority ?? 1],
  );
  return rows[0];
}

export async function updateKeyword(
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
       keyword = COALESCE($2, keyword),
       intent = COALESCE($3, intent),
       content_type = COALESCE($4, content_type),
       content_id = COALESCE($5, content_id),
       priority = COALESCE($6, priority),
       is_active = COALESCE($7, is_active)
     WHERE id = $1
     RETURNING *`,
    [
      id,
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

export async function deleteKeyword(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM keywords WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
