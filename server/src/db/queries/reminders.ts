import { assertTenantMatchesScope, query, queryOne, withTransaction } from '../index';
import type { Reminder, ReminderCategory, ReminderStatus } from '../../types';
import { AppError } from '../../utils/errors';
import type { WeeklyHours } from '../../services/reminders/owner-schedule';
import { normalizeWeeklyHours } from '../../services/reminders/owner-schedule';

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
  schedule_enabled: boolean;
  weekly_hours: WeeklyHours;
}

function mapOwnerRow(row: {
  phone: string;
  label: string | null;
  connection_id?: string;
  secretary_enabled: boolean;
  schedule_enabled?: boolean;
  weekly_hours?: unknown;
}): ReminderOwnerRow {
  return {
    phone: row.phone,
    label: row.label,
    connection_id: row.connection_id,
    secretary_enabled: row.secretary_enabled !== false,
    schedule_enabled: row.schedule_enabled === true,
    weekly_hours: normalizeWeeklyHours(row.weekly_hours),
  };
}

const OWNER_SELECT =
  'phone, label, connection_id, secretary_enabled, schedule_enabled, weekly_hours';

/** Número autorizado E com a alavanca do assistente ligada (ignora horário). */
export async function isReminderOwner(
  tenantId: string,
  phone: string,
  connectionId?: string | null,
): Promise<boolean> {
  const row = await getReminderOwner(tenantId, phone, connectionId);
  return row?.secretary_enabled === true;
}

export async function getReminderOwner(
  tenantId: string,
  phone: string,
  connectionId?: string | null,
): Promise<ReminderOwnerRow | null> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const row = await queryOne<{
      phone: string;
      label: string | null;
      connection_id?: string;
      secretary_enabled: boolean;
      schedule_enabled: boolean;
      weekly_hours: unknown;
    }>(
      `SELECT ${OWNER_SELECT} FROM reminder_owners
        WHERE tenant_id = $1 AND phone = $2 AND connection_id = $3`,
      [tenantId, phone, connectionId],
    );
    return row ? mapOwnerRow(row) : null;
  }
  const row = await queryOne<{
    phone: string;
    label: string | null;
    connection_id?: string;
    secretary_enabled: boolean;
    schedule_enabled: boolean;
    weekly_hours: unknown;
  }>(
    `SELECT ${OWNER_SELECT} FROM reminder_owners
      WHERE tenant_id = $1 AND phone = $2`,
    [tenantId, phone],
  );
  return row ? mapOwnerRow(row) : null;
}

export async function listReminderOwners(
  tenantId: string,
  connectionId?: string | null,
): Promise<ReminderOwnerRow[]> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rows } = await query<{
      phone: string;
      label: string | null;
      connection_id?: string;
      secretary_enabled: boolean;
      schedule_enabled: boolean;
      weekly_hours: unknown;
    }>(
      `SELECT ${OWNER_SELECT} FROM reminder_owners
        WHERE tenant_id = $1 AND connection_id = $2
        ORDER BY created_at ASC`,
      [tenantId, connectionId],
    );
    return rows.map(mapOwnerRow);
  }
  const { rows } = await query<{
    phone: string;
    label: string | null;
    connection_id?: string;
    secretary_enabled: boolean;
    schedule_enabled: boolean;
    weekly_hours: unknown;
  }>(
    `SELECT ${OWNER_SELECT} FROM reminder_owners
      WHERE tenant_id = $1 ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows.map(mapOwnerRow);
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

export async function setReminderOwnerSchedule(
  tenantId: string,
  phone: string,
  patch: { scheduleEnabled?: boolean; weeklyHours?: WeeklyHours },
  connectionId?: string | null,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const hours = patch.weeklyHours !== undefined ? normalizeWeeklyHours(patch.weeklyHours) : undefined;
  if (connectionId) {
    const { rowCount } = await query(
      `UPDATE reminder_owners
          SET schedule_enabled = COALESCE($4, schedule_enabled),
              weekly_hours = COALESCE($5::jsonb, weekly_hours)
        WHERE tenant_id = $1 AND phone = $2 AND connection_id = $3`,
      [
        tenantId,
        phone,
        connectionId,
        patch.scheduleEnabled ?? null,
        hours !== undefined ? JSON.stringify(hours) : null,
      ],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await query(
    `UPDATE reminder_owners
        SET schedule_enabled = COALESCE($3, schedule_enabled),
            weekly_hours = COALESCE($4::jsonb, weekly_hours)
      WHERE tenant_id = $1 AND phone = $2`,
    [tenantId, phone, patch.scheduleEnabled ?? null, hours !== undefined ? JSON.stringify(hours) : null],
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

/** Pendentes do tenant cuja tarefa contém todos os tokens (dono cancelando caderno de contato). */
export async function listPendingRemindersMatchingTokens(
  tenantId: string,
  tokens: string[],
  opts?: { ownerPhone?: string | null; limit?: number },
): Promise<Reminder[]> {
  assertTenantMatchesScope(tenantId);
  const safe = tokens.map(likeSafe).filter((t) => t.length >= 3).slice(0, 6);
  if (!safe.length) return [];
  const params: unknown[] = [tenantId];
  const where: string[] = [`tenant_id = $1`, `status = 'pendente'`];
  if (opts?.ownerPhone) {
    params.push(opts.ownerPhone);
    where.push(`owner_phone = $${params.length}`);
  }
  for (const t of safe) {
    params.push(`%${t}%`);
    where.push(`(task ILIKE $${params.length} OR COALESCE(relay_body, '') ILIKE $${params.length})`);
  }
  params.push(Math.min(opts?.limit ?? 30, 40));
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE ${where.join(' AND ')}
      ORDER BY next_fire_at ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Mesma tarefa já pendente (horário próximo) ou recém tocou/cancelou — não recadastrar. */
export async function findSimilarPendingReminder(
  tenantId: string,
  ownerPhone: string,
  task: string,
  nextFireAt: Date,
  windowMinutes = 90,
): Promise<Reminder | null> {
  assertTenantMatchesScope(tenantId);
  const { rows } = await query<Reminder>(
    `SELECT * FROM reminders
      WHERE tenant_id = $1 AND owner_phone = $2
        AND (
          (status = 'pendente'
            AND next_fire_at BETWEEN ($3::timestamptz - ($4::int * interval '1 minute'))
                                 AND ($3::timestamptz + ($4::int * interval '1 minute')))
          OR (status IN ('enviado', 'cancelado')
            AND COALESCE(last_fired_at, created_at) > NOW() - interval '12 hours')
        )
      ORDER BY created_at DESC
      LIMIT 20`,
    [tenantId, ownerPhone, nextFireAt.toISOString(), windowMinutes],
  );
  const folded = foldTask(task);
  if (!folded) return rows[0] ?? null;
  return (
    rows.find((r) => {
      const rt = foldTask(r.task);
      return rt === folded || rt.includes(folded) || folded.includes(rt);
    }) ?? null
  );
}

function foldTask(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bcamiseta\b/g, 'camisa')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function likeSafe(fragment: string): string {
  return fragment.replace(/[%_\\]/g, '').trim();
}

/**
 * Compromissos "para o contato X": relay com target_client_id, tarefa/notas
 * citando o nome, e o caderno próprio daquele telefone (acesso livre).
 */
export async function listRemindersAboutContact(
  tenantId: string,
  ownerPhone: string,
  opts: {
    clientId?: string | null;
    contactPhone?: string | null;
    clientIds?: string[];
    contactPhones?: string[];
    nameHints: string[];
    filter?: ListRemindersFilter;
  },
): Promise<Reminder[]> {
  assertTenantMatchesScope(tenantId);
  const filter = opts.filter ?? {};
  const clientIds = [
    ...new Set(
      [...(opts.clientIds ?? []), opts.clientId].filter((id): id is string => Boolean(id)),
    ),
  ];
  const extraPhones = [
    ...new Set(
      [...(opts.contactPhones ?? []), opts.contactPhone].filter((p): p is string => Boolean(p)),
    ),
  ];
  const phones = [...new Set([ownerPhone, ...extraPhones])];

  const params: unknown[] = [tenantId, phones];
  const where: string[] = ['tenant_id = $1', 'owner_phone = ANY($2::varchar[])'];

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

  const matchParts: string[] = [];
  if (clientIds.length) {
    params.push(clientIds);
    matchParts.push(`target_client_id = ANY($${params.length}::uuid[])`);
  }
  if (extraPhones.length) {
    params.push(extraPhones);
    matchParts.push(`owner_phone = ANY($${params.length}::varchar[])`);
  }
  const seenHints = new Set<string>();
  for (const raw of opts.nameHints) {
    const hint = likeSafe(raw);
    if (hint.length < 3) continue;
    const key = hint.toLowerCase();
    if (seenHints.has(key)) continue;
    seenHints.add(key);
    params.push(`%${hint}%`);
    const i = params.length;
    matchParts.push(
      `(task ILIKE $${i} OR COALESCE(relay_body, '') ILIKE $${i} OR COALESCE(notes, '') ILIKE $${i})`,
    );
  }
  if (matchParts.length) {
    where.push(`(${matchParts.join(' OR ')})`);
  } else {
    where.push('FALSE');
  }

  params.push(filter.limit ?? 40);
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

/** Falha no aviso prévio: libera para o próximo tick tentar de novo. */
export async function releaseLeadReminder(id: string): Promise<void> {
  await query(`UPDATE reminders SET lead_fired_at = NULL WHERE id = $1`, [id]);
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

/** Cancela pelo id no tenant (lista do dono pode incluir caderno de contato). */
export async function cancelReminderById(tenantId: string, id: string): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'cancelado'
      WHERE id = $1 AND tenant_id = $2 AND status = 'pendente'`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function completeReminderById(tenantId: string, id: string): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'concluido'
      WHERE id = $1 AND tenant_id = $2 AND status = 'pendente'`,
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

/** Cancela todos os pendentes deste número — param de tocar e saem da lista. */
export async function cancelAllPendingReminders(
  tenantId: string,
  ownerPhone: string,
): Promise<number> {
  assertTenantMatchesScope(tenantId);
  const { rowCount } = await query(
    `UPDATE reminders SET status = 'cancelado'
      WHERE tenant_id = $1 AND owner_phone = $2 AND status = 'pendente'`,
    [tenantId, ownerPhone],
  );
  return rowCount ?? 0;
}
