import { logger } from '../../config/logger';
import {
  claimLeadReminder,
  claimReminder,
  getDueLeadReminders,
  getDueReminders,
  markReminderFired,
  rescheduleReminder,
} from '../../db/queries/reminders';
import { isTenantBlocked } from '../../middleware/tenantAccess.middleware';
import { getTenantWhatsapp, getWhatsappByConnection } from '../whatsapp.service';
import type { Reminder } from '../../types';
import { describeLead, describeRecurrence } from './parse.service';
import { formatForOwner, nextOccurrence } from './time';
import { tickBroadcasts } from '../broadcast.service';
import { purgeExpiredMemories } from '../../db/queries/client_memories';
import { tickWhatsappOnboarding } from '../whatsapp-onboarding.service';
import { sendOwnerRelay } from '../owner-relay.service';

/**
 * Agendador dos lembretes: a cada minuto varre os vencidos e dispara no
 * WhatsApp do dono (na mesma instância em que o lembrete foi criado).
 */

const TICK_MS = 60_000;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;

function reminderText(reminder: Reminder): string {
  // Só a tarefa — sem prefixo "Lembrete", para parecer um toque humano.
  const repeat = reminder.recurrence ? `\n(repete ${describeRecurrence(reminder.recurrence)})` : '';
  return `${reminder.task}${repeat}`;
}

async function whatsappForReminder(reminder: Reminder) {
  if (reminder.connection_id) {
    return getWhatsappByConnection(reminder.tenant_id, reminder.connection_id);
  }
  return getTenantWhatsapp(reminder.tenant_id);
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
    const wa = await whatsappForReminder(reminder);
    const targetId = reminder.target_client_id;
    const relayBody = reminder.relay_body?.trim();

    // Relay: envia ao CONTATO e avisa o dono.
    if (targetId && relayBody) {
      const sent = await sendOwnerRelay({
        tenantId: reminder.tenant_id,
        connectionId: reminder.connection_id,
        clientId: targetId,
        body: relayBody,
      });
      if (!sent.ok) {
        throw new Error(sent.error);
      }
      const preview = relayBody.length > 120 ? `${relayBody.slice(0, 117)}…` : relayBody;
      await wa.sendText(
        reminder.owner_phone,
        `Enviei pra *${sent.name}*: "${preview}"`,
      );
      logger.info(
        `Lembrete relay (${reminder.id}) → contato ${sent.phone}; dono ${reminder.owner_phone} avisado.`,
      );
    } else {
      await wa.sendText(reminder.owner_phone, reminderText(reminder));
      logger.info(
        `Lembrete enviado (${reminder.id}) para ${reminder.owner_phone}` +
          (reminder.connection_id ? ` via ${reminder.connection_id}` : ' (1ª conexão).'),
      );
    }
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

/**
 * Toque ANTECIPADO ("me avise 1h antes"). Não mexe no status nem no
 * next_fire_at: o lembrete continua pendente e dispara de novo na hora certa.
 */
async function fireLead(reminder: Reminder): Promise<void> {
  const claimed = await claimLeadReminder(reminder.id);
  if (!claimed) return;

  if (await isTenantBlocked(reminder.tenant_id)) return;

  const quando = formatForOwner(new Date(reminder.next_fire_at), reminder.timezone);
  const antes = reminder.lead_minutes ? describeLead(reminder.lead_minutes) : 'em breve';
  const text = `${reminder.task}\n${quando} · te aviso ${antes}`;

  try {
    const wa = await whatsappForReminder(reminder);
    await wa.sendText(reminder.owner_phone, text);
    logger.info(`Aviso antecipado enviado (${reminder.id}).`);
  } catch (err) {
    logger.warn(`Falha no aviso antecipado ${reminder.id}`, err);
  }
}

async function tick(): Promise<void> {
  // Um tick por vez: um envio lento não pode empilhar varreduras.
  if (running) return;
  running = true;
  try {
    // Avisos antecipados primeiro: são sensíveis ao horário e baratos.
    const leads = await getDueLeadReminders(BATCH);
    for (const reminder of leads) {
      await fireLead(reminder).catch((err) =>
        logger.warn(`Erro no aviso antecipado ${reminder.id}`, err),
      );
    }

    const due = await getDueReminders(BATCH);
    for (const reminder of due) {
      await fire(reminder).catch((err) =>
        logger.warn(`Erro ao processar lembrete ${reminder.id}`, err),
      );
    }

    // Campanhas em massa (throttle/teto ficam no serviço).
    await tickBroadcasts().catch((err) => logger.warn('Falha na varredura de disparos', err));

    // LGPD: limpa memórias com expires_at vencido (best-effort).
    await purgeExpiredMemories().catch(() => 0);

    // Onboarding: QR expirado + recycle de pool quando trial de 7 dias acaba.
    await tickWhatsappOnboarding().catch((err) =>
      logger.warn('Falha na varredura de onboarding WhatsApp', err),
    );
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
