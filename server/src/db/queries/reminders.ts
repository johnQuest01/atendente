import { query, queryOne } from '../index';
import type { Reminder, ReminderCategory, ReminderStatus } from '../../types';

/**
 * Lembretes pessoais do dono e a whitelist de números autorizados.
 * Mesmo padrão das demais queries: `tenantId` como primeiro argumento e filtro
 * por `tenant_id` em toda leitura/escrita.
 *
 * Exceção deliberada: `getDueReminders` roda FORA do escopo de um tenant (é o
 * agendador varrendo todas as empresas) e por isso não recebe tenantId.
 */

export async function isReminderOwner(tenantId: string, phone: string): Promise<boolean> {
  const row = await queryOne<{ phone: string }>(
    'SELECT phone FROM reminder_owners WHERE tenant_id = $1 AND phone = $2',
    [tenantId, phone],
  );
  return row !== null;
}

export async function listReminderOwners(
  tenantId: string,
): Promise<Array<{ phone: string; label: string | null }>> {
  const { rows } = await query<{ phone: string; label: string | null }>(
    'SELECT phone, label FROM reminder_owners WHERE tenant_id = $1 ORDER BY created_at ASC',
    [tenantId],
  );
  return rows;
}

export async function addReminderOwner(
  tenantId: string,
  phone: string,
  label?: string | null,
): Promise<void> {
  await query(
    `INSERT INTO reminder_owners (tenant_id, phone, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET label = EXCLUDED.label`,
    [tenantId, phone, label ?? null],
  );
}

export async function removeReminderOwner(tenantId: string, phone: string): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM reminder_owners WHERE tenant_id = $1 AND phone = $2',
    [tenantId, phone],
  );
  return (rowCount ?? 0) > 0;
}

export interface CreateReminderInput {
  ownerPhone: string;
  task: string;
  category: ReminderCategory;
  recurrence?: string | null;
  nextFireAt: Date;
  timezone?: string;
  notes?: string | null;
  /** Minutos de aviso prévio ("me avise 1h antes" = 60). */
  leadMinutes?: number | null;
}

export async function createReminder(
  tenantId: string,
  input: CreateReminderInput,
): Promise<Reminder> {
  const { rows } = await query<Reminder>(
    `INSERT INTO reminders
       (tenant_id, owner_phone, task, category, recurrence, next_fire_at, timezone, notes, lead_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      tenantId,
      input.ownerPhone,
      input.task,
      input.category,
      input.recurrence ?? null,
      input.nextFireAt.toISOString(),
      input.timezone ?? 'America/Sao_Paulo',
      input.notes ?? null,
      input.leadMinutes ?? null,
    ],
  );
  return rows[0];
}

export interface ListRemindersFilter {
  /** Só lembretes que disparam a partir de agora até este limite. */
  until?: Date;
  from?: Date;
  category?: ReminderCategory;
  /** Padrão: apenas 'pendente'. */
  statuses?: ReminderStatus[];
  limit?: number;
}

export async function listReminders(
  tenantId: string,
  ownerPhone: string,
  filter: ListRemindersFilter = {},
): Promise<Reminder[]> {
  const params: unknown[] = [tenantId, ownerPhone];
  const where: string[] = ['tenant_id = $1', 'owner_phone = $2'];

  const statuses = filter.statuses ?? ['pendente'];
  params.push(statuses);
  where.push(`status = ANY($${params.length}::varchar[])`);

  if (filter.from) {
    params.push(filter.from.toISOString());
    where.push(`next_fire_at >= $${params.length}`);
  }
  if (filter.until) {
    params.push(filter.until.toISOString());
    where.push(`next_fire_at <= $${params.length}`);
  }
  if (filter.category) {
    params.push(filter.category);
    where.push(`category = $${params.length}`);
  }

  params.push(filter.limit ?? 30);
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE ${where.join(' AND ')}
      ORDER BY next_fire_at ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getReminderById(tenantId: string, id: string): Promise<Reminder | null> {
  return queryOne<Reminder>('SELECT * FROM reminders WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

/**
 * Lembretes vencidos, de TODAS as empresas — é o agendador rodando como tarefa
 * de sistema (a policy da 019 é permissiva quando `app.tenant_id` está vazio).
 */
export async function getDueReminders(limit = 50): Promise<Reminder[]> {
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE status = 'pendente' AND next_fire_at <= NOW()
      ORDER BY next_fire_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Fecha um disparo. `nextFireAt` null encerra (único); com data, reagenda a
 * recorrência. A condição `status = 'pendente'` torna a operação idempotente:
 * dois ticks concorrentes não disparam o mesmo lembrete duas vezes.
 */
export async function markReminderFired(
  id: string,
  nextFireAt: Date | null,
  newStatus: ReminderStatus,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE reminders
        SET status = $2,
            next_fire_at = COALESCE($3, next_fire_at),
            last_fired_at = NOW()
      WHERE id = $1 AND status = 'pendente'`,
    [id, newStatus, nextFireAt ? nextFireAt.toISOString() : null],
  );
  return (rowCount ?? 0) > 0;
}

/** Reserva o lembrete antes de enviar, para dois ticks não duplicarem o envio. */
export async function claimReminder(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'enviado', last_fired_at = NOW()
      WHERE id = $1 AND status = 'pendente'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Reagenda uma recorrência já reservada (volta para 'pendente').
 * Zera `lead_fired_at`: o aviso prévio do próximo ciclo ainda não aconteceu.
 */
export async function rescheduleReminder(id: string, nextFireAt: Date): Promise<void> {
  await query(
    `UPDATE reminders
        SET status = 'pendente', next_fire_at = $2, lead_fired_at = NULL
      WHERE id = $1`,
    [id, nextFireAt.toISOString()],
  );
}

/**
 * Lembretes cujo AVISO PRÉVIO venceu — passou do (horário − antecedência) e o
 * horário principal ainda não chegou. Tarefa de sistema, varre todos os tenants.
 */
export async function getDueLeadReminders(limit = 50): Promise<Reminder[]> {
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE status = 'pendente'
        AND lead_minutes IS NOT NULL
        AND lead_fired_at IS NULL
        AND next_fire_at > NOW()
        AND next_fire_at - (lead_minutes || ' minutes')::interval <= NOW()
      ORDER BY next_fire_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Reserva o aviso prévio, para dois ticks não mandarem o mesmo alerta duas vezes. */
export async function claimLeadReminder(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE reminders SET lead_fired_at = NOW()
      WHERE id = $1 AND lead_fired_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function completeReminder(
  tenantId: string,
  ownerPhone: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'concluido'
      WHERE id = $1 AND tenant_id = $2 AND owner_phone = $3`,
    [id, tenantId, ownerPhone],
  );
  return (rowCount ?? 0) > 0;
}

export async function cancelReminder(
  tenantId: string,
  ownerPhone: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'cancelado'
      WHERE id = $1 AND tenant_id = $2 AND owner_phone = $3`,
    [id, tenantId, ownerPhone],
  );
  return (rowCount ?? 0) > 0;
}
