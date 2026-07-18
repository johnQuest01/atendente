import { query, queryOne } from '../index';
import type { Audio } from '../../types';

export interface CreateAudioInput {
  title: string;
  category: string;
  tone?: string | null;
  situation?: string | null;
  fileUrl: string;
  fileSizeKb?: number | null;
  durationSeconds?: number | null;
  transcription?: string | null;
  keywords?: string[];
  createdBy?: string | null;
  // Conteúdo do áudio (.ogg) guardado direto no banco.
  fileData?: Buffer | null;
  mimeType?: string | null;
}

// Colunas seguras para listar/retornar na API: NUNCA inclui o blob `file_data`
// (pesado). `has_file_data` indica se há bytes salvos no banco.
const AUDIO_COLUMNS = `
  id, title, category, tone, situation, file_url, file_size_kb, duration_seconds,
  transcription, keywords, usage_count, is_active, created_by, created_at, mime_type,
  (file_data IS NOT NULL) AS has_file_data
`;

export async function listAudios(tenantId: string, activeOnly = false): Promise<Audio[]> {
  const activeFilter = activeOnly ? 'AND is_active = true' : '';
  const { rows } = await query<Audio>(
    `SELECT ${AUDIO_COLUMNS} FROM audios
      WHERE tenant_id = $1 ${activeFilter}
      ORDER BY category ASC, created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function getAudioById(tenantId: string, id: string): Promise<Audio | null> {
  return queryOne<Audio>(`SELECT ${AUDIO_COLUMNS} FROM audios WHERE id = $1 AND tenant_id = $2`, [
    id,
    tenantId,
  ]);
}

/**
 * Retorna os bytes do áudio (para servir em /media/audios/:id).
 * Com tenant (token): filtra por empresa. Sem tenant: só no fallback legado.
 */
export async function getAudioBinary(
  id: string,
  tenantId: string | null,
): Promise<{ data: Buffer; mime: string } | null> {
  const row = tenantId
    ? await queryOne<{ file_data: Buffer | null; mime_type: string | null }>(
        'SELECT file_data, mime_type FROM audios WHERE id = $1 AND tenant_id = $2',
        [id, tenantId],
      )
    : await queryOne<{ file_data: Buffer | null; mime_type: string | null }>(
        'SELECT file_data, mime_type FROM audios WHERE id = $1',
        [id],
      );
  if (!row || !row.file_data) return null;
  return { data: row.file_data, mime: row.mime_type ?? 'audio/ogg' };
}

export async function setAudioFileUrl(tenantId: string, id: string, fileUrl: string): Promise<void> {
  await query('UPDATE audios SET file_url = $3 WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
    fileUrl,
  ]);
}

export interface UpdateAudioFileInput {
  // null no modo remoto (R2): o conteúdo vive no bucket, não no banco.
  fileData: Buffer | null;
  mimeType: string | null;
  fileUrl: string;
  fileSizeKb?: number | null;
  durationSeconds?: number | null;
}

/** Substitui apenas o arquivo de um áudio existente (mantém título, palavras-chave, etc). */
export async function updateAudioFile(
  tenantId: string,
  id: string,
  input: UpdateAudioFileInput,
): Promise<Audio | null> {
  const { rows } = await query<Audio>(
    `UPDATE audios
       SET file_data = $3, mime_type = $4, file_url = $5, file_size_kb = $6, duration_seconds = $7
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${AUDIO_COLUMNS}`,
    [id, tenantId, input.fileData, input.mimeType, input.fileUrl, input.fileSizeKb ?? null, input.durationSeconds ?? null],
  );
  return rows[0] ?? null;
}

export async function createAudio(tenantId: string, input: CreateAudioInput): Promise<Audio> {
  const { rows } = await query<Audio>(
    `INSERT INTO audios
       (tenant_id, title, category, tone, situation, file_url, file_size_kb, duration_seconds, transcription, keywords, created_by, file_data, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${AUDIO_COLUMNS}`,
    [
      tenantId,
      input.title,
      input.category,
      input.tone ?? null,
      input.situation ?? null,
      input.fileUrl,
      input.fileSizeKb ?? null,
      input.durationSeconds ?? null,
      input.transcription ?? null,
      input.keywords ?? [],
      input.createdBy ?? null,
      input.fileData ?? null,
      input.mimeType ?? null,
    ],
  );
  return rows[0];
}

export async function updateAudio(
  tenantId: string,
  id: string,
  patch: Partial<Pick<Audio, 'title' | 'category' | 'tone' | 'situation' | 'transcription' | 'keywords' | 'is_active'>>,
): Promise<Audio | null> {
  const { rows } = await query<Audio>(
    `UPDATE audios SET
       title = COALESCE($3, title),
       category = COALESCE($4, category),
       tone = COALESCE($5, tone),
       situation = COALESCE($6, situation),
       transcription = COALESCE($7, transcription),
       keywords = COALESCE($8, keywords),
       is_active = COALESCE($9, is_active)
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${AUDIO_COLUMNS}`,
    [
      id,
      tenantId,
      patch.title ?? null,
      patch.category ?? null,
      patch.tone ?? null,
      patch.situation ?? null,
      patch.transcription ?? null,
      patch.keywords ?? null,
      patch.is_active ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteAudio(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM audios WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function incrementAudioUsage(tenantId: string, id: string): Promise<void> {
  await query('UPDATE audios SET usage_count = usage_count + 1 WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}
