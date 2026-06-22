import { query, queryOne } from '../index';
import type { TextScript } from '../../types';

export interface CreateScriptInput {
  title: string;
  category: string;
  content: string;
  keywords?: string[];
  createdBy?: string | null;
}

export async function listScripts(tenantId: string, activeOnly = false): Promise<TextScript[]> {
  const activeFilter = activeOnly ? 'AND is_active = true' : '';
  const { rows } = await query<TextScript>(
    `SELECT * FROM text_scripts
      WHERE tenant_id = $1 ${activeFilter}
      ORDER BY category ASC, created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function getScriptById(tenantId: string, id: string): Promise<TextScript | null> {
  return queryOne<TextScript>('SELECT * FROM text_scripts WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

export async function createScript(tenantId: string, input: CreateScriptInput): Promise<TextScript> {
  const { rows } = await query<TextScript>(
    `INSERT INTO text_scripts (tenant_id, title, category, content, keywords, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, input.title, input.category, input.content, input.keywords ?? [], input.createdBy ?? null],
  );
  return rows[0];
}

export async function updateScript(
  tenantId: string,
  id: string,
  patch: Partial<Pick<TextScript, 'title' | 'category' | 'content' | 'keywords' | 'is_active'>>,
): Promise<TextScript | null> {
  const { rows } = await query<TextScript>(
    `UPDATE text_scripts SET
       title = COALESCE($3, title),
       category = COALESCE($4, category),
       content = COALESCE($5, content),
       keywords = COALESCE($6, keywords),
       is_active = COALESCE($7, is_active)
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, patch.title ?? null, patch.category ?? null, patch.content ?? null, patch.keywords ?? null, patch.is_active ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteScript(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM text_scripts WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function incrementScriptUsage(tenantId: string, id: string): Promise<void> {
  await query(
    'UPDATE text_scripts SET usage_count = usage_count + 1 WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
}
