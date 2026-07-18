import type { Request, Response } from 'express';
import { env } from '../config/env';
import { runWithTenant } from '../db';
import { getAudioBinary } from '../db/queries/audios';
import { getMediaFile } from '../db/queries/media_files';
import { verifyMediaToken } from '../utils/media-token';
import { NotFoundError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenFromReq(req: Request): string | undefined {
  const t = req.query.t;
  return typeof t === 'string' ? t : undefined;
}

/**
 * Serve o áudio guardado no banco (Neon) como arquivo binário.
 * Rota pública (Z-API precisa baixar). Com ?t= válido, escopa por tenant + RLS.
 * Sem token: só se MEDIA_LEGACY_FALLBACK=true (compat até o backfill).
 */
export async function getAudioMedia(req: Request, res: Response): Promise<void> {
  const id = (req.params.id ?? '').replace(/\.[a-zA-Z0-9]+$/, '');
  if (!UUID_RE.test(id)) throw new NotFoundError('Áudio');

  const tenantId = verifyMediaToken(id, tokenFromReq(req));
  if (!tenantId && !env.MEDIA_LEGACY_FALLBACK) throw new NotFoundError('Áudio');

  const bin = tenantId
    ? await runWithTenant(tenantId, () => getAudioBinary(id, tenantId))
    : await getAudioBinary(id, null);

  if (!bin) throw new NotFoundError('Áudio');

  res.setHeader('Content-Type', bin.mime || 'audio/ogg');
  res.setHeader('Content-Length', String(bin.data.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(bin.data);
}

/**
 * Serve arquivo de mídia genérico. Mesma regra de token / fallback legado.
 */
export async function getFileMedia(req: Request, res: Response): Promise<void> {
  const id = (req.params.id ?? '').replace(/\.[a-zA-Z0-9]+$/, '');
  if (!UUID_RE.test(id)) throw new NotFoundError('Arquivo');

  const tenantId = verifyMediaToken(id, tokenFromReq(req));
  if (!tenantId && !env.MEDIA_LEGACY_FALLBACK) throw new NotFoundError('Arquivo');

  const file = tenantId
    ? await runWithTenant(tenantId, () => getMediaFile(id, tenantId))
    : await getMediaFile(id, null);

  if (!file) throw new NotFoundError('Arquivo');

  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.data.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(file.data);
}
