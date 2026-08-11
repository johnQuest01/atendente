import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createKeyword,
  deleteKeyword,
  listKeywords,
  updateKeyword,
} from '../db/queries/keywords';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { AppError, NotFoundError } from '../utils/errors';

export const idParamSchema = z.object({ id: z.string().uuid() });

const CONTENT_TYPES = ['audio', 'text', 'product', 'claude', 'reminders_today'] as const;

export const createKeywordSchema = z.object({
  keyword: z.string().min(1).max(100),
  intent: z.string().min(1).max(100),
  content_type: z.enum(CONTENT_TYPES),
  content_id: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).default(1),
  /** Número/instância WhatsApp (obrigatório para palavras de disparo). */
  connection_id: z.string().uuid().nullable().optional(),
});

export const updateKeywordSchema = z.object({
  keyword: z.string().min(1).max(100).optional(),
  intent: z.string().min(1).max(100).optional(),
  content_type: z.enum(CONTENT_TYPES).optional(),
  content_id: z.string().uuid().nullable().optional(),
  priority: z.coerce.number().int().min(1).optional(),
  is_active: z.boolean().optional(),
  connection_id: z.string().uuid().nullable().optional(),
});

async function assertConnection(
  tenantId: string,
  connectionId: string | null | undefined,
): Promise<void> {
  if (!connectionId) return;
  const conn = await getConnectionById(tenantId, connectionId);
  if (!conn) {
    throw new AppError('Número WhatsApp inválido nesta conta.', 400, 'CONNECTION_INVALID');
  }
}

export async function getKeywords(req: Request, res: Response): Promise<void> {
  const keywords = await listKeywords(req.user!.tenant_id, false);
  res.json({ keywords });
}

export async function postKeyword(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createKeywordSchema>;
  const tenantId = req.user!.tenant_id;

  if (body.content_type === 'reminders_today' && !body.connection_id) {
    throw new AppError(
      'Escolha de qual número WhatsApp esta palavra de disparo vale.',
      400,
      'CONNECTION_REQUIRED',
    );
  }
  await assertConnection(tenantId, body.connection_id);

  const keyword = await createKeyword(tenantId, {
    keyword: body.keyword,
    intent: body.intent,
    contentType: body.content_type,
    contentId: body.content_id ?? null,
    priority: body.priority,
    connectionId: body.connection_id ?? null,
  });
  res.status(201).json({ keyword });
}

export async function patchKeyword(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateKeywordSchema>;
  await assertConnection(req.user!.tenant_id, body.connection_id);
  const keyword = await updateKeyword(req.user!.tenant_id, id, body);
  if (!keyword) throw new NotFoundError('Keyword');
  res.json({ keyword });
}

export async function removeKeyword(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteKeyword(req.user!.tenant_id, id);
  if (!ok) throw new NotFoundError('Keyword');
  res.status(204).send();
}
