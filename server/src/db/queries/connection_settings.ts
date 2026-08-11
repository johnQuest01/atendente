import { query, queryOne } from '../index';

/**
 * Settings key-value escopadas por conexão WhatsApp.
 * RLS por tenant; sempre filtrar tenant_id + connection_id.
 */

export async function readConnectionSetting(
  tenantId: string,
  connectionId: string,
  key: string,
): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM connection_settings
      WHERE tenant_id = $1 AND connection_id = $2 AND key = $3`,
    [tenantId, connectionId, key],
  );
  return row?.value ?? null;
}

export async function writeConnectionSetting(
  tenantId: string,
  connectionId: string,
  key: string,
  value: string,
): Promise<void> {
  await query(
    `INSERT INTO connection_settings (tenant_id, connection_id, key, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, connection_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [tenantId, connectionId, key, value],
  );
}

export async function listConnectionSettings(
  tenantId: string,
  connectionId: string,
): Promise<Array<{ key: string; value: string }>> {
  const { rows } = await query<{ key: string; value: string }>(
    `SELECT key, value FROM connection_settings
      WHERE tenant_id = $1 AND connection_id = $2`,
    [tenantId, connectionId],
  );
  return rows;
}
