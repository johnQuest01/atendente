import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addBroadcastTargets,
  createBroadcast,
  getBroadcast,
  listBroadcasts,
  listEligibleClientIds,
  setBroadcastStatus,
} from '../db/queries/broadcasts';
import { getBroadcastProgress, processBroadcast } from '../services/broadcast.service';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { AppError, NotFoundError } from '../utils/errors';

export const createBroadcastSchema = z.object({
  title: z.string().trim().min(1).max(150),
  content_type: z.enum(['text', 'audio', 'product']),
  content_ref: z.string().uuid().optional().nullable(),
  body_text: z.string().trim().max(4096).optional().nullable(),
  scheduled_at: z.string().datetime().optional().nullable(),
  with_price: z.boolean().optional().default(true),
  /** Número/instância WhatsApp que envia (obrigatório). */
  connection_id: z.string().uuid(),
  /** Se true, inclui todos os clientes ativos (exceto bloqueados). */
  all_clients: z.boolean().optional().default(false),
  client_ids: z.array(z.string().uuid()).max(500).optional().default([]),
  daily_cap: z.number().int().min(1).max(500).optional(),
});

export const broadcastIdSchema = z.object({ id: z.string().uuid() });

export async function getBroadcasts(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const broadcasts = await listBroadcasts(tenantId);
  res.json({ broadcasts });
}

export async function getBroadcastDetail(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof broadcastIdSchema>;
  const progress = await getBroadcastProgress(tenantId, id);
  if (!progress) throw new NotFoundError('Campanha');
  res.json(progress);
}

export async function postBroadcast(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const input = req.body as z.infer<typeof createBroadcastSchema>;

  if (input.content_type === 'text' && !input.body_text?.trim()) {
    throw new AppError('Informe o texto da campanha.', 400, 'VALIDATION');
  }
  if ((input.content_type === 'audio' || input.content_type === 'product') && !input.content_ref) {
    throw new AppError('Informe o áudio ou produto da campanha.', 400, 'VALIDATION');
  }

  const conn = await getConnectionById(tenantId, input.connection_id);
  if (!conn) {
    throw new AppError('Número WhatsApp inválido nesta conta.', 400, 'CONNECTION_INVALID');
  }

  const clientIds = input.all_clients
    ? await listEligibleClientIds(tenantId)
    : (input.client_ids ?? []);
  if (clientIds.length === 0) {
    throw new AppError('Selecione ao menos um destinatário.', 400, 'NO_TARGETS');
  }

  const broadcast = await createBroadcast(tenantId, {
    title: input.title,
    contentType: input.content_type,
    contentRef: input.content_ref,
    bodyText: input.body_text,
    scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : null,
    withPrice: input.with_price,
    createdBy: req.user!.sub,
    dailyCap: input.daily_cap,
    connectionId: input.connection_id,
  });

  const added = await addBroadcastTargets(tenantId, broadcast.id, clientIds);

  // Sem agendamento: já enfileira como running para o próximo tick (ou processa um pouco agora).
  if (!input.scheduled_at) {
    await setBroadcastStatus(tenantId, broadcast.id, 'running', { started: true });
    void processBroadcast({ ...broadcast, status: 'running' }).catch(() => undefined);
  }

  res.status(201).json({ broadcast, targets_added: added });
}

export async function startBroadcast(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof broadcastIdSchema>;
  const existing = await getBroadcast(tenantId, id);
  if (!existing) throw new NotFoundError('Campanha');
  if (existing.status === 'done' || existing.status === 'cancelled') {
    throw new AppError('Campanha já finalizada.', 400, 'DONE');
  }
  const updated = await setBroadcastStatus(tenantId, id, 'running', { started: true });
  void processBroadcast(updated!).catch(() => undefined);
  res.json({ broadcast: updated });
}

export async function cancelBroadcast(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenant_id;
  const { id } = req.params as z.infer<typeof broadcastIdSchema>;
  const updated = await setBroadcastStatus(tenantId, id, 'cancelled', { finished: true });
  if (!updated) throw new NotFoundError('Campanha');
  res.json({ broadcast: updated });
}
