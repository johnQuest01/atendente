import type { Request, Response } from 'express';
import { z } from 'zod';
import { deleteClientMemory, listClientMemories } from '../db/queries/client_memories';
import { getConversationById } from '../db/queries/conversations';
import { NotFoundError } from '../utils/errors';

export const clientIdParamSchema = z.object({
  clientId: z.string().uuid(),
});

export const memoryIdParamSchema = z.object({
  clientId: z.string().uuid(),
  memoryId: z.string().uuid(),
});

export const conversationIdParamSchema = z.object({
  id: z.string().uuid(),
});

/** Lista memórias do cliente da conversa aberta (LGPD: operador vê e apaga). */
export async function listMemoriesForConversation(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof conversationIdParamSchema>;
  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const memories = await listClientMemories(tenantId, conversation.client_id, 50);
  res.json({ memories, clientId: conversation.client_id });
}

export async function listMemories(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { clientId } = req.params as z.infer<typeof clientIdParamSchema>;
  const memories = await listClientMemories(tenantId, clientId, 50);
  res.json({ memories });
}

export async function removeMemory(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { clientId, memoryId } = req.params as z.infer<typeof memoryIdParamSchema>;
  const ok = await deleteClientMemory(tenantId, clientId, memoryId);
  if (!ok) throw new NotFoundError('Memória');
  res.status(204).send();
}

export const conversationMemoryParamSchema = z.object({
  id: z.string().uuid(),
  memoryId: z.string().uuid(),
});

/** Apaga memória a partir da conversa (resolve client_id). */
export async function removeMemoryForConversation(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id, memoryId } = req.params as z.infer<typeof conversationMemoryParamSchema>;
  const conversation = await getConversationById(tenantId, id);
  if (!conversation) throw new NotFoundError('Conversa');
  const ok = await deleteClientMemory(tenantId, conversation.client_id, memoryId);
  if (!ok) throw new NotFoundError('Memória');
  res.status(204).send();
}
