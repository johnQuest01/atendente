import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addReminderOwner,
  listReminderOwners,
  listReminders,
  removeReminderOwner,
  setReminderOwnerSecretary,
} from '../db/queries/reminders';
import { AppError, NotFoundError } from '../utils/errors';
import { parseConnectionIdQuery, requireConnection } from './connectionScope';

/**
 * Whitelist do assistente pessoal: quais números, dentro da empresa, podem
 * mandar lembretes pelo WhatsApp em vez de serem tratados como clientes.
 */

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export async function getReminderOwners(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners });
}

export const createReminderOwnerSchema = z.object({
  // Aceita o número como a pessoa digita; normalizamos para dígitos, que é o
  // formato com que o telefone chega no webhook.
  phone: z
    .string()
    .trim()
    .min(10, 'Informe o número com DDD.')
    .max(20)
    .refine((v) => onlyDigits(v).length >= 10, 'Número inválido.'),
  label: z.string().trim().max(100).optional(),
});

export async function postReminderOwner(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (!connectionId) {
    throw new AppError(
      'Escolha de qual número WhatsApp este contato autoriza lembretes.',
      400,
      'CONNECTION_REQUIRED',
    );
  }
  await requireConnection(req.user!.tenant_id, connectionId);
  const input = req.body as z.infer<typeof createReminderOwnerSchema>;
  const phone = onlyDigits(input.phone);
  await addReminderOwner(req.user!.tenant_id, phone, input.label ?? null, connectionId);
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.status(201).json({ owners });
}

export const reminderOwnerParamSchema = z.object({ phone: z.string().min(8).max(20) });

export const patchReminderOwnerSchema = z.object({
  secretaryEnabled: z.boolean(),
});

/** Liga/desliga o assistente secretário para um número autorizado. */
export async function patchReminderOwner(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const { phone } = req.params as z.infer<typeof reminderOwnerParamSchema>;
  const { secretaryEnabled } = req.body as z.infer<typeof patchReminderOwnerSchema>;
  const ok = await setReminderOwnerSecretary(
    req.user!.tenant_id,
    onlyDigits(phone),
    secretaryEnabled,
    connectionId,
  );
  if (!ok) throw new NotFoundError('Número autorizado');
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners });
}

export async function deleteReminderOwner(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const { phone } = req.params as z.infer<typeof reminderOwnerParamSchema>;
  const ok = await removeReminderOwner(req.user!.tenant_id, onlyDigits(phone), connectionId);
  if (!ok) throw new NotFoundError('Número autorizado');
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners });
}

/** Lembretes de um dono, para conferência pelo painel (o uso real é no WhatsApp). */
export const listRemindersQuerySchema = z.object({
  phone: z.string().min(8).max(20),
});

export async function getReminders(req: Request, res: Response): Promise<void> {
  const { phone } = req.query as z.infer<typeof listRemindersQuerySchema>;
  const reminders = await listReminders(req.user!.tenant_id, onlyDigits(phone), { limit: 50 });
  res.json({ reminders });
}
