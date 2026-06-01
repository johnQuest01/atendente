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

export async function listAudios(activeOnly = false): Promise<Audio[]> {
  const where = activeOnly ? 'WHERE is_active = true' : '';
  const { rows } = await query<Audio>(
    `SELECT ${AUDIO_COLUMNS} FROM audios ${where} ORDER BY category ASC, created_at DESC`,
  );
  return rows;
}

export async function getAudioById(id: string): Promise<Audio | null> {
  return queryOne<Audio>(`SELECT ${AUDIO_COLUMNS} FROM audios WHERE id = $1`, [id]);
}

/** Retorna os bytes do áudio (para servir em /media/audios/:id). */
export async function getAudioBinary(
  id: string,
): Promise<{ data: Buffer; mime: string } | null> {
  const row = await queryOne<{ file_data: Buffer | null; mime_type: string | null }>(
    'SELECT file_data, mime_type FROM audios WHERE id = $1',
    [id],
  );
  if (!row || !row.file_data) return null;
  return { data: row.file_data, mime: row.mime_type ?? 'audio/ogg' };
}

export async function setAudioFileUrl(id: string, fileUrl: string): Promise<void> {
  await query('UPDATE audios SET file_url = $2 WHERE id = $1', [id, fileUrl]);
}

export async function createAudio(input: CreateAudioInput): Promise<Audio> {
  const { rows } = await query<Audio>(
    `INSERT INTO audios
       (title, category, tone, situation, file_url, file_size_kb, duration_seconds, transcription, keywords, created_by, file_data, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${AUDIO_COLUMNS}`,
    [
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
  id: string,
  patch: Partial<Pick<Audio, 'title' | 'category' | 'tone' | 'situation' | 'transcription' | 'keywords' | 'is_active'>>,
): Promise<Audio | null> {
  const { rows } = await query<Audio>(
    `UPDATE audios SET
       title = COALESCE($2, title),
       category = COALESCE($3, category),
       tone = COALESCE($4, tone),
       situation = COALESCE($5, situation),
       transcription = COALESCE($6, transcription),
       keywords = COALESCE($7, keywords),
       is_active = COALESCE($8, is_active)
     WHERE id = $1
     RETURNING *`,
    [
      id,
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

export async function deleteAudio(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM audios WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function incrementAudioUsage(id: string): Promise<void> {
  await query('UPDATE audios SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}
