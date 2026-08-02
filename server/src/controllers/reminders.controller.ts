import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addReminderOwner,
  listReminderOwners,
  listReminders,
  removeReminderOwner,
} from '../db/queries/reminders';
import { NotFoundError } from '../utils/errors';

/**
 * Whitelist do assistente pessoal: quais números, dentro da empresa, podem
 * mandar lembretes pelo WhatsApp em vez de serem tratados como clientes.
 */

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export async function getReminderOwners(req: Request, res: Response): Promise<void> {
  const owners = await listReminderOwners(req.user!.tenant_id);
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
  const input = req.body as z.infer<typeof createReminderOwnerSchema>;
  const phone = onlyDigits(input.phone);
  await addReminderOwner(req.user!.tenant_id, phone, input.label ?? null);
  const owners = await listReminderOwners(req.user!.tenant_id);
  res.status(201).json({ owners });
}

export const reminderOwnerParamSchema = z.object({ phone: z.string().min(8).max(20) });

export async function deleteReminderOwner(req: Request, res: Response): Promise<void> {
  const { phone } = req.params as z.infer<typeof reminderOwnerParamSchema>;
  const ok = await removeReminderOwner(req.user!.tenant_id, onlyDigits(phone));
  if (!ok) throw new NotFoundError('Número autorizado');
  const owners = await listReminderOwners(req.user!.tenant_id);
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
