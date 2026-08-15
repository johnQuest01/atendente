import { logger } from '../../config/logger';
import {
  claimLeadReminder,
  claimReminder,
  getDueLeadReminders,
  getDueReminders,
  markReminderFired,
  rescheduleReminder,
  releaseLeadReminder,
} from '../../db/queries/reminders';
import { isTenantBlocked } from '../../middleware/tenantAccess.middleware';
import { getTenantWhatsapp, getWhatsappByConnection } from '../whatsapp.service';
import { isTransientNetworkError } from '../zapi.service';
import type { Reminder } from '../../types';
import { bumpUntilFuture, describeLead, describeRecurrence } from './parse.service';
import { formatForOwner, nextOccurrence } from './time';
import { tickBroadcasts } from '../broadcast.service';
import { purgeExpiredMemories } from '../../db/queries/client_memories';
import { tickWhatsappOnboarding } from '../whatsapp-onboarding.service';
import { sendOwnerRelay } from '../owner-relay.service';
import { appendOwnerChatMessage } from '../../db/queries/owner_chat_messages';
import { searchAndAnswer } from '../ai/search-summarize';
import { extractSearchQuery, taskLooksLikeSearch } from './reminder-actions';

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

function reminderWantsSearch(reminder: Reminder): boolean {
  return reminder.fire_action === 'search' || taskLooksLikeSearch(reminder.task);
}

async function buildFiredBody(reminder: Reminder): Promise<string> {
  if (!reminderWantsSearch(reminder)) return reminderText(reminder);

  const query = (reminder.search_query || extractSearchQuery(reminder.task)).trim();
  return searchAndAnswer({
    query,
    tenantId: reminder.tenant_id,
    connectionId: reminder.connection_id,
    ownerPhone: reminder.owner_phone,
    wantLink: true,
  });
}

async function whatsappForReminder(reminder: Reminder) {
  if (reminder.connection_id) {
    return getWhatsappByConnection(reminder.tenant_id, reminder.connection_id);
  }
  return getTenantWhatsapp(reminder.tenant_id);
}

const TRANSIENT_BACKOFF_MS = [5_000, 15_000, 45_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch failed: tenta de novo no mesmo minuto (5s → 15s → 45s). Só depois cai nos 10min. */
async function withTransientRetry(reminderId: string, send: () => Promise<void>): Promise<void> {
  const maxTries = TRANSIENT_BACKOFF_MS.length + 1;
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    try {
      await send();
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || i === maxTries - 1) throw err;
      const wait = TRANSIENT_BACKOFF_MS[i]!;
      logger.warn(
        `Lembrete ${reminderId}: falha de rede, retry em ${wait / 1000}s (tentativa ${i + 1}/${maxTries})`,
        err,
      );
      await sleep(wait);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function rememberFiredChat(reminder: Reminder, text: string): Promise<void> {
  await appendOwnerChatMessage({
    tenantId: reminder.tenant_id,
    ownerPhone: reminder.owner_phone,
    role: 'assistant',
    content: text,
    connectionId: reminder.connection_id,
  }).catch((err) => logger.warn(`Lembrete ${reminder.id}: falha ao gravar disparo no fio`, err));
}

async function fire(reminder: Reminder): Promise<void> {
  // Reserva antes de enviar: se dois ticks se cruzarem, só um envia.
  const claimed = await claimReminder(reminder.id);
  if (!claimed) return;

  const overdueMs = Date.now() - new Date(reminder.next_fire_at).getTime();
  if (overdueMs > 6 * 60 * 60_000) {
    const snapped = bumpUntilFuture(
      new Date(reminder.next_fire_at),
      new Date(),
      reminder.timezone,
      reminder.recurrence,
    );
    if (snapped.getTime() > Date.now() + 60_000) {
      logger.warn(
        `Lembrete ${reminder.id}: horário velho (${reminder.next_fire_at}) — reagendado para ${snapped.toISOString()} sem disparar agora.`,
      );
      await rescheduleReminder(reminder.id, snapped);
      return;
    }
    logger.warn(`Lembrete ${reminder.id}: horário velho demais, não disparo.`);
    return;
  }

  // Empresa com teste vencido/desativada não recebe disparo — mas o lembrete
  // não é perdido: volta para pendente e sai de novo quando ela reativar.
  if (await isTenantBlocked(reminder.tenant_id)) {
    await rescheduleReminder(reminder.id, new Date(Date.now() + 6 * 60 * 60_000));
    return;
  }

  try {
    await withTransientRetry(reminder.id, async () => {
      const wa = await whatsappForReminder(reminder);
      const targetId = reminder.target_client_id;
      const relayBody = reminder.relay_body?.trim();

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
        const ownerText = `Enviei pra *${sent.name}*: "${preview}"`;
        await wa.sendText(reminder.owner_phone, ownerText);
        await rememberFiredChat(reminder, ownerText);
        logger.info(
          `Lembrete relay (${reminder.id}) → contato ${sent.phone}; dono ${reminder.owner_phone} avisado.`,
        );
        return;
      }

      const body = await buildFiredBody(reminder);
      await wa.sendText(reminder.owner_phone, body);
      await rememberFiredChat(reminder, body);
      logger.info(
        `Lembrete enviado (${reminder.id}) para ${reminder.owner_phone}` +
          (reminderWantsSearch(reminder) ? ' [pesquisa]' : '') +
          (reminder.connection_id ? ` via ${reminder.connection_id}` : ' (1ª conexão).'),
      );
    });
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
    await rememberFiredChat(reminder, text);
    logger.info(`Aviso antecipado enviado (${reminder.id}).`);
  } catch (err) {
    logger.warn(`Falha no aviso antecipado ${reminder.id}`, err);
    await releaseLeadReminder(reminder.id);
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
