import { query, queryOne } from '../index';

export type BroadcastContentType = 'text' | 'audio' | 'product';
export type BroadcastStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'done' | 'cancelled';
export type TargetStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface Broadcast {
  id: string;
  tenant_id: string;
  title: string;
  content_type: BroadcastContentType;
  content_ref: string | null;
  body_text: string | null;
  status: BroadcastStatus;
  scheduled_at: string | null;
  throttle_min_ms: number;
  throttle_max_ms: number;
  daily_cap: number;
  with_price: boolean;
  /** Número/instância WhatsApp que envia a campanha. */
  connection_id: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BroadcastTarget {
  id: string;
  tenant_id: string;
  broadcast_id: string;
  client_id: string;
  status: TargetStatus;
  error: string | null;
  sent_at: string | null;
  phone?: string;
  name?: string | null;
}

export async function createBroadcast(
  tenantId: string,
  input: {
    title: string;
    contentType: BroadcastContentType;
    contentRef?: string | null;
    bodyText?: string | null;
    scheduledAt?: Date | null;
    withPrice?: boolean;
    createdBy?: string | null;
    throttleMinMs?: number;
    throttleMaxMs?: number;
    dailyCap?: number;
    connectionId: string;
  },
): Promise<Broadcast> {
  const { rows } = await query<Broadcast>(
    `INSERT INTO broadcasts
       (tenant_id, title, content_type, content_ref, body_text, status, scheduled_at,
        with_price, created_by, throttle_min_ms, throttle_max_ms, daily_cap, connection_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      tenantId,
      input.title.trim().slice(0, 150),
      input.contentType,
      input.contentRef ?? null,
      input.bodyText ?? null,
      input.scheduledAt ? 'scheduled' : 'draft',
      input.scheduledAt ?? null,
      input.withPrice ?? true,
      input.createdBy ?? null,
      input.throttleMinMs ?? 8000,
      input.throttleMaxMs ?? 25000,
      input.dailyCap ?? 80,
      input.connectionId,
    ],
  );
  return rows[0];
}

export async function listBroadcasts(tenantId: string): Promise<Broadcast[]> {
  const { rows } = await query<Broadcast>(
    `SELECT * FROM broadcasts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [tenantId],
  );
  return rows;
}

export async function getBroadcast(tenantId: string, id: string): Promise<Broadcast | null> {
  return queryOne<Broadcast>(`SELECT * FROM broadcasts WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
}

export async function addBroadcastTargets(
  tenantId: string,
  broadcastId: string,
  clientIds: string[],
): Promise<number> {
  let n = 0;
  for (const clientId of clientIds) {
    const { rowCount } = await query(
      `INSERT INTO broadcast_targets (tenant_id, broadcast_id, client_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (broadcast_id, client_id) DO NOTHING`,
      [tenantId, broadcastId, clientId],
    );
    n += rowCount ?? 0;
  }
  return n;
}

/** Clientes ativos do tenant, excluindo bloqueados. */
export async function listEligibleClientIds(tenantId: string): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT c.id FROM clients c
      WHERE c.tenant_id = $1 AND c.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM blocked_numbers b
           WHERE b.tenant_id = c.tenant_id AND b.phone = c.phone
        )
      ORDER BY c.last_contact_at DESC NULLS LAST
      LIMIT 2000`,
    [tenantId],
  );
  return rows.map((r) => r.id);
}

export async function countTargets(
  tenantId: string,
  broadcastId: string,
): Promise<{ total: number; pending: number; sent: number; failed: number; skipped: number }> {
  const row = await queryOne<{
    total: string;
    pending: string;
    sent: string;
    failed: string;
    skipped: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
       COUNT(*) FILTER (WHERE status = 'sent')::text AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE status = 'skipped')::text AS skipped
     FROM broadcast_targets
     WHERE tenant_id = $1 AND broadcast_id = $2`,
    [tenantId, broadcastId],
  );
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
    skipped: Number(row?.skipped ?? 0),
  };
}

export async function setBroadcastStatus(
  tenantId: string,
  id: string,
  status: BroadcastStatus,
  extra?: { started?: boolean; finished?: boolean },
): Promise<Broadcast | null> {
  return queryOne<Broadcast>(
    `UPDATE broadcasts SET
       status = $3,
       started_at = CASE WHEN $4 THEN COALESCE(started_at, NOW()) ELSE started_at END,
       finished_at = CASE WHEN $5 THEN NOW() ELSE finished_at END,
       updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId, id, status, extra?.started ?? false, extra?.finished ?? false],
  );
}

/**
 * Reserva o próximo alvo pendente (evita dois ticks enviarem o mesmo).
 * Se o envio falhar, o serviço chama markTargetFailed.
 */
export async function claimNextPendingTarget(
  broadcastId: string,
): Promise<(BroadcastTarget & { phone: string }) | null> {
  return queryOne<BroadcastTarget & { phone: string }>(
    `WITH next AS (
       SELECT t.id
         FROM broadcast_targets t
        WHERE t.broadcast_id = $1 AND t.status = 'pending'
        ORDER BY t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     ),
     updated AS (
       UPDATE broadcast_targets t
          SET status = 'sent', sent_at = NOW()
         FROM next
        WHERE t.id = next.id
       RETURNING t.*
     )
     SELECT u.*, c.phone
       FROM updated u
       JOIN clients c ON c.id = u.client_id`,
    [broadcastId],
  );
}

export async function markTargetFailed(targetId: string, error: string): Promise<void> {
  await query(
    `UPDATE broadcast_targets
        SET status = 'failed', error = $2
      WHERE id = $1`,
    [targetId, error.slice(0, 500)],
  );
}

export async function markTargetSkipped(targetId: string, reason: string): Promise<void> {
  await query(
    `UPDATE broadcast_targets SET status = 'skipped', error = $2 WHERE id = $1`,
    [targetId, reason.slice(0, 500)],
  );
}

export async function countSentToday(tenantId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM broadcast_targets
      WHERE tenant_id = $1 AND status = 'sent'
        AND sent_at >= date_trunc('day', NOW())`,
    [tenantId],
  );
  return Number(row?.n ?? 0);
}

export async function listDueBroadcasts(): Promise<Broadcast[]> {
  const { rows } = await query<Broadcast>(
    `SELECT * FROM broadcasts
      WHERE status IN ('scheduled', 'running')
        AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      ORDER BY scheduled_at NULLS FIRST
      LIMIT 20`,
  );
  return rows;
}

export async function getTargetClient(
  tenantId: string,
  clientId: string,
): Promise<{ id: string; phone: string; name: string | null } | null> {
  return queryOne(
    `SELECT id, phone, name FROM clients WHERE tenant_id = $1 AND id = $2`,
    [tenantId, clientId],
  );
}
