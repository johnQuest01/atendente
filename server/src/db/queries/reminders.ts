import { assertTenantMatchesScope, query, queryOne, withTransaction } from '../index';
import type { Reminder, ReminderCategory, ReminderStatus } from '../../types';
import { AppError } from '../../utils/errors';

/**
 * Lembretes pessoais do dono e a whitelist de números autorizados.
 * Mesmo padrão das demais queries: `tenantId` como primeiro argumento e filtro
 * por `tenant_id` em toda leitura/escrita.
 *
 * Exceção deliberada: `getDueReminders` roda FORA do escopo de um tenant (é o
 * agendador varrendo todas as empresas) e por isso não recebe tenantId.
 */

export interface ReminderOwnerRow {
  phone: string;
  label: string | null;
  connection_id?: string;
  secretary_enabled: boolean;
}

/** Número autorizado E com a alavanca do assistente ligada. */
export async function isReminderOwner(
  tenantId: string,
  phone: string,
  connectionId?: string | null,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const row = await queryOne<{ phone: string }>(
      `SELECT phone FROM reminder_owners
        WHERE tenant_id = $1 AND phone = $2 AND connection_id = $3
          AND secretary_enabled = true`,
      [tenantId, phone, connectionId],
    );
    return row !== null;
  }
  const row = await queryOne<{ phone: string }>(
    `SELECT phone FROM reminder_owners
      WHERE tenant_id = $1 AND phone = $2 AND secretary_enabled = true`,
    [tenantId, phone],
  );
  return row !== null;
}

export async function listReminderOwners(
  tenantId: string,
  connectionId?: string | null,
): Promise<ReminderOwnerRow[]> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rows } = await query<ReminderOwnerRow>(
      `SELECT phone, label, connection_id, secretary_enabled FROM reminder_owners
        WHERE tenant_id = $1 AND connection_id = $2
        ORDER BY created_at ASC`,
      [tenantId, connectionId],
    );
    return rows;
  }
  const { rows } = await query<ReminderOwnerRow>(
    `SELECT phone, label, connection_id, secretary_enabled FROM reminder_owners
      WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows;
}

export async function addReminderOwner(
  tenantId: string,
  phone: string,
  label?: string | null,
  connectionId?: string | null,
): Promise<void> {
  assertTenantMatchesScope(tenantId);
  if (!connectionId) {
    throw new AppError(
      'Escolha de qual número WhatsApp este contato autoriza lembretes.',
      400,
      'CONNECTION_REQUIRED',
    );
  }
  await query(
    `INSERT INTO reminder_owners (tenant_id, phone, label, connection_id, secretary_enabled)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (tenant_id, phone, connection_id) DO UPDATE SET label = EXCLUDED.label`,
    [tenantId, phone, label ?? null, connectionId],
  );
}

/** Liga/desliga o assistente secretário para um número da whitelist. */
export async function setReminderOwnerSecretary(
  tenantId: string,
  phone: string,
  enabled: boolean,
  connectionId?: string | null,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rowCount } = await query(
      `UPDATE reminder_owners
          SET secretary_enabled = $4
        WHERE tenant_id = $1 AND phone = $2 AND connection_id = $3`,
      [tenantId, phone, connectionId, enabled],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await query(
    `UPDATE reminder_owners SET secretary_enabled = $3
      WHERE tenant_id = $1 AND phone = $2`,
    [tenantId, phone, enabled],
  );
  return (rowCount ?? 0) > 0;
}

export async function removeReminderOwner(
  tenantId: string,
  phone: string,
  connectionId?: string | null,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rowCount } = await query(
      `DELETE FROM reminder_owners
        WHERE tenant_id = $1 AND phone = $2 AND connection_id = $3`,
      [tenantId, phone, connectionId],
    );
    return (rowCount ?? 0) > 0;
  }
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
  /** Instância WhatsApp que enviará o alarme. */
  connectionId?: string | null;
  /** Contato que receberá relay_body no horário (opcional). */
  targetClientId?: string | null;
  /** Texto enviado ao contato (opcional; exige targetClientId). */
  relayBody?: string | null;
}

export async function createReminder(
  tenantId: string,
  input: CreateReminderInput,
): Promise<Reminder> {
  assertTenantMatchesScope(tenantId);
  const { rows } = await query<Reminder>(
    `INSERT INTO reminders
       (tenant_id, owner_phone, task, category, recurrence, next_fire_at, timezone, notes, lead_minutes, connection_id, target_client_id, relay_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      input.connectionId ?? null,
      input.targetClientId ?? null,
      input.relayBody ?? null,
    ],
  );
  return rows[0];
}

/**
 * Criação em MASSA, tudo-ou-nada. Insere todos os lembretes numa transação: se
 * um falhar, faz rollback de todos (o dono não fica com metade da lista salva).
 * Reusa o mesmo INSERT do createReminder, num loop dentro da transação.
 */
export async function createRemindersBulk(
  tenantId: string,
  inputs: CreateReminderInput[],
): Promise<Reminder[]> {
  assertTenantMatchesScope(tenantId);
  if (inputs.length === 0) return [];
  return withTransaction(async (client) => {
    const created: Reminder[] = [];
    for (const input of inputs) {
      const { rows } = await client.query<Reminder>(
        `INSERT INTO reminders
           (tenant_id, owner_phone, task, category, recurrence, next_fire_at, timezone, notes, lead_minutes, connection_id, target_client_id, relay_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          input.connectionId ?? null,
          input.targetClientId ?? null,
          input.relayBody ?? null,
        ],
      );
      created.push(rows[0]);
    }
    return created;
  });
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
  assertTenantMatchesScope(tenantId);
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
  assertTenantMatchesScope(tenantId);
  return queryOne<Reminder>('SELECT * FROM reminders WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

/**
 * Lembretes pendentes de HOJE do dono (no fuso de cada lembrete). SQL puro —
 * zero IA. Usado pelo disparo por palavra-chave (Parte 2). A comparação usa a
 * timezone gravada na linha, então funciona mesmo com donos em fusos distintos.
 */
export async function getTodayReminders(tenantId: string, ownerPhone: string): Promise<Reminder[]> {
  assertTenantMatchesScope(tenantId);
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE tenant_id = $1 AND owner_phone = $2 AND status = 'pendente'
        AND (next_fire_at AT TIME ZONE timezone)::date = (NOW() AT TIME ZONE timezone)::date
      ORDER BY next_fire_at ASC`,
    [tenantId, ownerPhone],
  );
  return rows;
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
 * O dono pede para mudar horário/tarefa de um compromisso ainda pendente.
 * Zera `lead_fired_at` para o aviso prévio valer no novo horário.
 */
export async function updateOwnerReminder(
  tenantId: string,
  ownerPhone: string,
  id: string,
  patch: {
    nextFireAt: Date;
    recurrence?: string | null;
    task?: string;
    leadMinutes?: number | null;
  },
): Promise<Reminder | null> {
  assertTenantMatchesScope(tenantId);
  return queryOne<Reminder>(
    `UPDATE reminders
        SET next_fire_at = $4,
            recurrence = COALESCE($5, recurrence),
            task = COALESCE($6, task),
            lead_minutes = COALESCE($7, lead_minutes),
            lead_fired_at = NULL
      WHERE id = $3 AND tenant_id = $1 AND owner_phone = $2 AND status = 'pendente'
      RETURNING *`,
    [
      tenantId,
      ownerPhone,
      id,
      patch.nextFireAt.toISOString(),
      patch.recurrence === undefined ? null : patch.recurrence,
      patch.task ?? null,
      patch.leadMinutes === undefined ? null : patch.leadMinutes,
    ],
  );
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
  assertTenantMatchesScope(tenantId);
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
  assertTenantMatchesScope(tenantId);
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'cancelado'
      WHERE id = $1 AND tenant_id = $2 AND owner_phone = $3`,
    [id, tenantId, ownerPhone],
  );
  return (rowCount ?? 0) > 0;
}
