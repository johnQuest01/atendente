import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addReminderOwner,
  listReminderOwners,
  listReminders,
  removeReminderOwner,
  setReminderOwnerSchedule,
  setReminderOwnerSecretary,
  type ReminderOwnerRow,
} from '../db/queries/reminders';
import { AppError, NotFoundError } from '../utils/errors';
import { parseConnectionIdQuery, requireConnection } from './connectionScope';
import {
  currentWindowEndAt,
  defaultWeekdayHours,
  nextOpenAt,
  normalizeWeeklyHours,
  secretaryIsAvailable,
  type WeeklyHours,
} from '../services/reminders/owner-schedule';
import { DEFAULT_TZ, formatForOwner } from '../services/reminders/time';

/**
 * Whitelist do assistente pessoal: quais números, dentro da empresa, podem
 * mandar lembretes pelo WhatsApp em vez de serem tratados como clientes.
 */

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'Use HH:mm (ex.: 08:00).')
  .transform((s) => s.slice(0, 5));
const dayWindowSchema = z
  .object({ start: hhmm, end: hhmm })
  .nullable()
  .optional();
const weeklyHoursSchema = z
  .object({
    '0': dayWindowSchema,
    '1': dayWindowSchema,
    '2': dayWindowSchema,
    '3': dayWindowSchema,
    '4': dayWindowSchema,
    '5': dayWindowSchema,
    '6': dayWindowSchema,
  })
  .partial();

function presentOwner(row: ReminderOwnerRow) {
  const now = new Date();
  const hours = row.weekly_hours;
  const available = secretaryIsAvailable({
    secretaryEnabled: row.secretary_enabled,
    scheduleEnabled: row.schedule_enabled,
    weeklyHours: hours,
    now,
  });
  const next = row.schedule_enabled ? nextOpenAt(hours, now) : null;
  const closes = row.schedule_enabled ? currentWindowEndAt(hours, now) : null;
  return {
    phone: row.phone,
    label: row.label,
    secretary_enabled: row.secretary_enabled,
    schedule_enabled: row.schedule_enabled,
    weekly_hours: hours,
    active_now: available,
    next_open_label:
      row.schedule_enabled && !available && next && next.getTime() > now.getTime()
        ? formatForOwner(next, DEFAULT_TZ)
        : null,
    closes_at_label: closes ? formatForOwner(closes, DEFAULT_TZ) : null,
  };
}

export async function getReminderOwners(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners: owners.map(presentOwner) });
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
  res.status(201).json({ owners: owners.map(presentOwner) });
}

export const reminderOwnerParamSchema = z.object({ phone: z.string().min(8).max(20) });

export const patchReminderOwnerSchema = z
  .object({
    secretaryEnabled: z.boolean().optional(),
    scheduleEnabled: z.boolean().optional(),
    weeklyHours: weeklyHoursSchema.optional(),
  })
  .refine(
    (v) =>
      v.secretaryEnabled !== undefined ||
      v.scheduleEnabled !== undefined ||
      v.weeklyHours !== undefined,
    { message: 'Informe secretaryEnabled, scheduleEnabled ou weeklyHours.' },
  );

/** Liga/desliga o assistente ou grava a grade de horário semanal. */
export async function patchReminderOwner(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const { phone } = req.params as z.infer<typeof reminderOwnerParamSchema>;
  const body = req.body as z.infer<typeof patchReminderOwnerSchema>;
  const digits = onlyDigits(phone);

  if (body.secretaryEnabled !== undefined) {
    const ok = await setReminderOwnerSecretary(
      req.user!.tenant_id,
      digits,
      body.secretaryEnabled,
      connectionId,
    );
    if (!ok) throw new NotFoundError('Número autorizado');
  }

  if (body.scheduleEnabled !== undefined || body.weeklyHours !== undefined) {
    let weeklyHours: WeeklyHours | undefined =
      body.weeklyHours !== undefined ? normalizeWeeklyHours(body.weeklyHours) : undefined;
    if (body.scheduleEnabled === true && weeklyHours === undefined) {
      const current = (await listReminderOwners(req.user!.tenant_id, connectionId)).find(
        (o) => o.phone === digits,
      );
      if (current && Object.keys(current.weekly_hours).length === 0) {
        weeklyHours = defaultWeekdayHours();
      }
    }
    const ok = await setReminderOwnerSchedule(
      req.user!.tenant_id,
      digits,
      { scheduleEnabled: body.scheduleEnabled, weeklyHours },
      connectionId,
    );
    if (!ok) throw new NotFoundError('Número autorizado');
  }

  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners: owners.map(presentOwner) });
}

export async function deleteReminderOwner(req: Request, res: Response): Promise<void> {
  const connectionId = parseConnectionIdQuery(req);
  if (connectionId) await requireConnection(req.user!.tenant_id, connectionId);
  const { phone } = req.params as z.infer<typeof reminderOwnerParamSchema>;
  const ok = await removeReminderOwner(req.user!.tenant_id, onlyDigits(phone), connectionId);
  if (!ok) throw new NotFoundError('Número autorizado');
  const owners = await listReminderOwners(req.user!.tenant_id, connectionId);
  res.json({ owners: owners.map(presentOwner) });
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
