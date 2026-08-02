import { logger } from '../../config/logger';
import {
  claimReminder,
  getDueReminders,
  markReminderFired,
  rescheduleReminder,
} from '../../db/queries/reminders';
import { isTenantBlocked } from '../../middleware/tenantAccess.middleware';
import { getTenantWhatsapp } from '../whatsapp.service';
import type { Reminder } from '../../types';
import { describeRecurrence } from './parse.service';
import { nextOccurrence } from './time';

/**
 * Agendador dos lembretes: a cada minuto varre os vencidos e dispara no
 * WhatsApp do dono.
 *
 * Roda como TAREFA DE SISTEMA, sem `runWithTenant`: a policy de RLS da 019 é
 * permissiva quando `app.tenant_id` está vazio, então a varredura enxerga todas
 * as empresas. O envio, esse sim, usa a conexão de cada tenant.
 */

const TICK_MS = 60_000;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;

function reminderText(reminder: Reminder): string {
  const flag = reminder.category === 'importante' ? '⚠️ ' : '';
  const repeat = reminder.recurrence ? `\n🔁 ${describeRecurrence(reminder.recurrence)}` : '';
  return `⏰ *Lembrete*\n${flag}${reminder.task}${repeat}`;
}

async function fire(reminder: Reminder): Promise<void> {
  // Reserva antes de enviar: se dois ticks se cruzarem, só um envia.
  const claimed = await claimReminder(reminder.id);
  if (!claimed) return;

  // Empresa com teste vencido/desativada não recebe disparo — mas o lembrete
  // não é perdido: volta para pendente e sai de novo quando ela reativar.
  if (await isTenantBlocked(reminder.tenant_id)) {
    await rescheduleReminder(reminder.id, new Date(Date.now() + 6 * 60 * 60_000));
    return;
  }

  try {
    const wa = await getTenantWhatsapp(reminder.tenant_id);
    await wa.sendText(reminder.owner_phone, reminderText(reminder));
    logger.info(`Lembrete enviado (${reminder.id}) para ${reminder.owner_phone}.`);
  } catch (err) {
    logger.warn(`Falha ao enviar lembrete ${reminder.id} — será tentado de novo em 10min`, err);
    await rescheduleReminder(reminder.id, new Date(Date.now() + 10 * 60_000));
    return;
  }

  if (!reminder.recurrence) {
    // Único: já ficou 'enviado' no claim. Só registra o disparo.
    await markReminderFired(reminder.id, null, 'enviado');
    return;
  }

  const next = nextOccurrence(
    reminder.recurrence,
    new Date(reminder.next_fire_at),
    reminder.timezone,
  );
  if (!next) {
    logger.warn(`Lembrete ${reminder.id}: recorrência "${reminder.recurrence}" não pôde ser recalculada.`);
    return;
  }
  await rescheduleReminder(reminder.id, next);
}

async function tick(): Promise<void> {
  // Um tick por vez: um envio lento não pode empilhar varreduras.
  if (running) return;
  running = true;
  try {
    const due = await getDueReminders(BATCH);
    for (const reminder of due) {
      await fire(reminder).catch((err) =>
        logger.warn(`Erro ao processar lembrete ${reminder.id}`, err),
      );
    }
  } catch (err) {
    logger.warn('Falha na varredura de lembretes', err);
  } finally {
    running = false;
  }
}

export function startReminderScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // unref: o agendador não segura o processo no encerramento.
  timer.unref?.();
  logger.info(`Agendador de lembretes iniciado (varredura a cada ${TICK_MS / 1000}s).`);
  void tick();
}

export function stopReminderScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
