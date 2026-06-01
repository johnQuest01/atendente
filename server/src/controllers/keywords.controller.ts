import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createKeyword,
  deleteKeyword,
  listKeywords,
  updateKeyword,
} from '../db/queries/keywords';
import { NotFoundError } from '../utils/errors';

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createKeywordSchema = z.object({
  keyword: z.string().min(1).max(100),
  intent: z.string().min(1).max(100),
  content_type: z.enum(['audio', 'text', 'product', 'claude']),
  content_id: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).default(1),
});

export const updateKeywordSchema = z.object({
  keyword: z.string().min(1).max(100).optional(),
  intent: z.string().min(1).max(100).optional(),
  content_type: z.enum(['audio', 'text', 'product', 'claude']).optional(),
  content_id: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).optional(),
  is_active: z.boolean().optional(),
});

export async function getKeywords(_req: Request, res: Response): Promise<void> {
  const keywords = await listKeywords(false);
  res.json({ keywords });
}

export async function postKeyword(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createKeywordSchema>;
  const keyword = await createKeyword({
    keyword: body.keyword,
    intent: body.intent,
    contentType: body.content_type,
    contentId: body.content_id ?? null,
    priority: body.priority,
  });
  res.status(201).json({ keyword });
}

export async function patchKeyword(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const keyword = await updateKeyword(id, req.body as z.infer<typeof updateKeywordSchema>);
  if (!keyword) throw new NotFoundError('Keyword');
  res.json({ keyword });
}

export async function removeKeyword(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteKeyword(id);
  if (!ok) throw new NotFoundError('Keyword');
  res.status(204).send();
}
