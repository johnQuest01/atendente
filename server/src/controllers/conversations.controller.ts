import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getConversationById,
  getConversationMessages,
  listConversations,
  markInboundAsRead,
  updateConversationStatus,
} from '../db/queries/conversations';
import { queryOne } from '../db/index';
import { dispatchAudio, dispatchProduct, dispatchText } from '../services/dispatch.service';
import { emitConversationUpdated } from '../socket';
import { NotFoundError } from '../utils/errors';
import type { Client } from '../types';

export const listQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'waiting']).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export const statusBodySchema = z.object({
  status: z.enum(['open', 'closed', 'waiting']),
});

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(4096),
});

export const sendAudioSchema = z.object({
  audio_id: z.string().uuid(),
});

export const sendProductSchema = z.object({
  product_id: z.string().uuid(),
});

export async function getConversations(req: Request, res: Response): Promise<void> {
  const { status } = req.query as z.infer<typeof listQuerySchema>;
  const conversations = await listConversations(status);
  res.json({ conversations });
}

export async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const conversation = await getConversationById(id);
  if (!conversation) throw new NotFoundError('Conversa');

  const [messages, client] = await Promise.all([
    getConversationMessages(id),
    queryOne<Client>('SELECT * FROM clients WHERE id = $1', [conversation.client_id]),
  ]);

  await markInboundAsRead(id);

  res.json({ conversation, client, messages });
}

export async function patchConversationStatus(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { status } = req.body as z.infer<typeof statusBodySchema>;

  const conversation = await updateConversationStatus(id, status);
  if (!conversation) throw new NotFoundError('Conversa');

  emitConversationUpdated(conversation);
  res.json({ conversation });
}

/** Envio manual de texto pela atendente. */
export async function sendManualMessage(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { text } = req.body as z.infer<typeof sendMessageSchema>;

  const conversation = await getConversationById(id);
  if (!conversation) throw new NotFoundError('Conversa');

  const client = await queryOne<Client>('SELECT * FROM clients WHERE id = $1', [conversation.client_id]);
  if (!client) throw new NotFoundError('Cliente');

  const message = await dispatchText({ conversation, client }, text);
  res.status(201).json({ message });
}

/** Envio manual de um áudio do banco pela atendente. */
export async function sendManualAudio(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { audio_id } = req.body as z.infer<typeof sendAudioSchema>;

  const conversation = await getConversationById(id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await queryOne<Client>('SELECT * FROM clients WHERE id = $1', [conversation.client_id]);
  if (!client) throw new NotFoundError('Cliente');

  const message = await dispatchAudio({ conversation, client }, audio_id);
  if (!message) throw new NotFoundError('Áudio');
  res.status(201).json({ message });
}

/** Envio manual de um produto pela atendente. */
export async function sendManualProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { product_id } = req.body as z.infer<typeof sendProductSchema>;

  const conversation = await getConversationById(id);
  if (!conversation) throw new NotFoundError('Conversa');
  const client = await queryOne<Client>('SELECT * FROM clients WHERE id = $1', [conversation.client_id]);
  if (!client) throw new NotFoundError('Cliente');

  const message = await dispatchProduct({ conversation, client }, product_id);
  if (!message) throw new NotFoundError('Produto');
  res.status(201).json({ message });
}
