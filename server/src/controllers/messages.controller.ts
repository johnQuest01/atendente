import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createScript,
  deleteScript,
  listScripts,
  updateScript,
} from '../db/queries/messages_scripts';
import { NotFoundError } from '../utils/errors';

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createScriptSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1),
  keywords: z.array(z.string()).default([]),
});

export const updateScriptSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

export async function getScripts(_req: Request, res: Response): Promise<void> {
  const scripts = await listScripts(false);
  res.json({ scripts });
}

export async function postScript(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createScriptSchema>;
  const script = await createScript({
    title: body.title,
    category: body.category,
    content: body.content,
    keywords: body.keywords,
    createdBy: req.user?.sub ?? null,
  });
  res.status(201).json({ script });
}

export async function patchScript(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const script = await updateScript(id, req.body as z.infer<typeof updateScriptSchema>);
  if (!script) throw new NotFoundError('Script');
  res.json({ script });
}

export async function removeScript(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteScript(id);
  if (!ok) throw new NotFoundError('Script');
  res.status(204).send();
}
