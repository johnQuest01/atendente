import { query, queryOne } from '../index';
import type { ContentType, Keyword } from '../../types';

export interface CreateKeywordInput {
  keyword: string;
  intent: string;
  contentType: ContentType;
  contentId?: string | null;
  priority?: number;
  /** Instância WhatsApp que dispara esta palavra (NULL = todas). */
  connectionId?: string | null;
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

/**
 * Keywords ativas para matcher/disparo.
 * Com `connectionId`: inclui as da instância + as de “todas” (connection_id NULL).
 */
export async function getActiveKeywords(
  tenantId: string,
  connectionId?: string | null,
): Promise<Keyword[]> {
  if (connectionId) {
    const { rows } = await query<Keyword>(
      `SELECT * FROM keywords
        WHERE tenant_id = $1
          AND is_active = true
          AND (connection_id IS NULL OR connection_id = $2)
        ORDER BY
          CASE WHEN connection_id = $2 THEN 0 ELSE 1 END,
          priority DESC`,
      [tenantId, connectionId],
    );
    return rows;
  }
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
    `INSERT INTO keywords (tenant_id, keyword, intent, content_type, content_id, priority, connection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      tenantId,
      input.keyword,
      input.intent,
      input.contentType,
      input.contentId ?? null,
      input.priority ?? 1,
      input.connectionId ?? null,
    ],
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
    connection_id: string | null;
  }>,
): Promise<Keyword | null> {
  const { rows } = await query<Keyword>(
    `UPDATE keywords SET
       keyword = COALESCE($3, keyword),
       intent = COALESCE($4, intent),
       content_type = COALESCE($5, content_type),
       content_id = COALESCE($6, content_id),
       priority = COALESCE($7, priority),
       is_active = COALESCE($8, is_active),
       connection_id = CASE WHEN $9::boolean THEN $10::uuid ELSE connection_id END
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
      patch.connection_id !== undefined,
      patch.connection_id ?? null,
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
