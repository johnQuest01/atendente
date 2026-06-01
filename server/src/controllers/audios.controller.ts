import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  deleteAudio,
  getAudioById,
  listAudios,
  updateAudio,
} from '../db/queries/audios';
import { processAndStoreAudio } from '../services/audio.service';
import { cleanupTmp } from '../services/storage.service';
import { AppError, NotFoundError } from '../utils/errors';

const keywordsField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v;
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  });

export const createAudioSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  tone: z.string().max(50).optional(),
  situation: z.string().optional(),
  transcription: z.string().optional(),
  keywords: keywordsField,
});

export const updateAudioSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  tone: z.string().max(50).optional(),
  situation: z.string().optional(),
  transcription: z.string().optional(),
  keywords: keywordsField,
  is_active: z.boolean().optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export async function getAudios(_req: Request, res: Response): Promise<void> {
  const audios = await listAudios(false);
  res.json({ audios });
}

export async function getAudio(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const audio = await getAudioById(id);
  if (!audio) throw new NotFoundError('Áudio');
  res.json({ audio });
}

export async function uploadAudioHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) throw new AppError('Nenhum arquivo de áudio enviado.', 422, 'NO_FILE');

  try {
    const body = createAudioSchema.parse(req.body);
    const audio = await processAndStoreAudio({
      tmpFilePath: req.file.path,
      title: body.title,
      category: body.category,
      tone: body.tone ?? null,
      situation: body.situation ?? null,
      transcription: body.transcription ?? null,
      keywords: body.keywords ?? [],
      createdBy: req.user?.sub ?? null,
    });
    res.status(201).json({ audio });
  } catch (err) {
    await cleanupTmp(req.file.path);
    throw err;
  }
}

export async function patchAudio(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const patch = req.body as z.infer<typeof updateAudioSchema>;
  const audio = await updateAudio(id, patch);
  if (!audio) throw new NotFoundError('Áudio');
  res.json({ audio });
}

export async function removeAudio(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteAudio(id);
  if (!ok) throw new NotFoundError('Áudio');
  res.status(204).send();
}
