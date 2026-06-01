import { query, queryOne } from '../index';
import type { TextScript } from '../../types';

export interface CreateScriptInput {
  title: string;
  category: string;
  content: string;
  keywords?: string[];
  createdBy?: string | null;
}

export async function listScripts(activeOnly = false): Promise<TextScript[]> {
  const where = activeOnly ? 'WHERE is_active = true' : '';
  const { rows } = await query<TextScript>(
    `SELECT * FROM text_scripts ${where} ORDER BY category ASC, created_at DESC`,
  );
  return rows;
}

export async function getScriptById(id: string): Promise<TextScript | null> {
  return queryOne<TextScript>('SELECT * FROM text_scripts WHERE id = $1', [id]);
}

export async function createScript(input: CreateScriptInput): Promise<TextScript> {
  const { rows } = await query<TextScript>(
    `INSERT INTO text_scripts (title, category, content, keywords, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.title, input.category, input.content, input.keywords ?? [], input.createdBy ?? null],
  );
  return rows[0];
}

export async function updateScript(
  id: string,
  patch: Partial<Pick<TextScript, 'title' | 'category' | 'content' | 'keywords' | 'is_active'>>,
): Promise<TextScript | null> {
  const { rows } = await query<TextScript>(
    `UPDATE text_scripts SET
       title = COALESCE($2, title),
       category = COALESCE($3, category),
       content = COALESCE($4, content),
       keywords = COALESCE($5, keywords),
       is_active = COALESCE($6, is_active)
     WHERE id = $1
     RETURNING *`,
    [id, patch.title ?? null, patch.category ?? null, patch.content ?? null, patch.keywords ?? null, patch.is_active ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteScript(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM text_scripts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function incrementScriptUsage(id: string): Promise<void> {
  await query('UPDATE text_scripts SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}
