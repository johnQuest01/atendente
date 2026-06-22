import { query, queryOne } from '../index';

export interface DashboardMetrics {
  open_conversations: number;
  waiting_conversations: number;
  messages_sent_today: number;
  messages_received_today: number;
  active_clients: number;
}

export interface TopAudio {
  id: string;
  title: string;
  category: string;
  usage_count: number;
}

export interface ActivityPoint {
  hour: string;
  inbound: number;
  outbound: number;
}

export async function getDashboardMetrics(tenantId: string): Promise<DashboardMetrics> {
  const row = await queryOne<DashboardMetrics>(
    `SELECT
        (SELECT COUNT(*) FROM conversations WHERE tenant_id = $1 AND status = 'open')::int AS open_conversations,
        (SELECT COUNT(*) FROM conversations WHERE tenant_id = $1 AND status = 'waiting')::int AS waiting_conversations,
        (SELECT COUNT(*) FROM messages_log WHERE tenant_id = $1 AND direction = 'outbound' AND sent_at >= date_trunc('day', NOW()))::int AS messages_sent_today,
        (SELECT COUNT(*) FROM messages_log WHERE tenant_id = $1 AND direction = 'inbound' AND sent_at >= date_trunc('day', NOW()))::int AS messages_received_today,
        (SELECT COUNT(*) FROM clients WHERE tenant_id = $1 AND is_active = true)::int AS active_clients`,
    [tenantId],
  );
  return (
    row ?? {
      open_conversations: 0,
      waiting_conversations: 0,
      messages_sent_today: 0,
      messages_received_today: 0,
      active_clients: 0,
    }
  );
}

export async function getTopAudios(tenantId: string, limit = 5): Promise<TopAudio[]> {
  const { rows } = await query<TopAudio>(
    `SELECT id, title, category, usage_count
       FROM audios
      WHERE tenant_id = $1 AND usage_count > 0
      ORDER BY usage_count DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function getActivityByHour(tenantId: string): Promise<ActivityPoint[]> {
  const { rows } = await query<ActivityPoint>(
    `SELECT
        to_char(date_trunc('hour', sent_at), 'HH24:00') AS hour,
        COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
        COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound
      FROM messages_log
      WHERE tenant_id = $1 AND sent_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 1`,
    [tenantId],
  );
  return rows;
}
