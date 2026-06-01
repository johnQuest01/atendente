import type { Request, Response } from 'express';
import { getAudioBinary } from '../db/queries/audios';
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
