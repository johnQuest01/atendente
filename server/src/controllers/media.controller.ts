import type { Request, Response } from 'express';
import { getAudioBinary } from '../db/queries/audios';
import { getMediaFile } from '../db/queries/media_files';
import { NotFoundError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serve o áudio guardado no banco (Neon) como arquivo binário.
 * Rota PÚBLICA (sem auth) porque a Z-API precisa baixar a mídia para enviar
 * ao cliente no WhatsApp. Aceita o id com ou sem extensão (ex.: ".ogg").
 */
export async function getAudioMedia(req: Request, res: Response): Promise<void> {
  const id = (req.params.id ?? '').replace(/\.[a-zA-Z0-9]+$/, '');
  if (!UUID_RE.test(id)) throw new NotFoundError('Áudio');

  const bin = await getAudioBinary(id);
  if (!bin) throw new NotFoundError('Áudio');

  res.setHeader('Content-Type', bin.mime || 'audio/ogg');
  res.setHeader('Content-Length', String(bin.data.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(bin.data);
}

/**
 * Serve um arquivo de mídia genérico (ex.: imagens de produto) guardado no
 * banco. Rota PÚBLICA porque a Z-API precisa baixar a imagem para enviar.
 */
export async function getFileMedia(req: Request, res: Response): Promise<void> {
  const id = (req.params.id ?? '').replace(/\.[a-zA-Z0-9]+$/, '');
  if (!UUID_RE.test(id)) throw new NotFoundError('Arquivo');

  const file = await getMediaFile(id);
  if (!file) throw new NotFoundError('Arquivo');

  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.data.length));
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(file.data);
}
