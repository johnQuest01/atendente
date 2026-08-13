import { assertTenantMatchesScope, query, queryOne } from '../index';

export type ContactWatchMode = 'once' | 'always';
export type ContactWatchStatus = 'active' | 'fired' | 'cancelled';

export interface ContactMessageWatch {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  owner_phone: string;
  client_id: string;
  mode: ContactWatchMode;
  status: ContactWatchStatus;
  last_notified_at: string | null;
  created_at: string;
  client_name?: string | null;
  client_phone?: string | null;
}

export async function upsertContactWatch(input: {
  tenantId: string;
  ownerPhone: string;
  clientId: string;
  mode: ContactWatchMode;
  connectionId?: string | null;
}): Promise<ContactMessageWatch> {
  assertTenantMatchesScope(input.tenantId);
  const connectionId = input.connectionId ?? null;

  const existing = connectionId
    ? await queryOne<ContactMessageWatch>(
        `SELECT * FROM contact_message_watches
          WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
            AND connection_id = $4 AND status = 'active'`,
        [input.tenantId, input.ownerPhone, input.clientId, connectionId],
      )
    : await queryOne<ContactMessageWatch>(
        `SELECT * FROM contact_message_watches
          WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
            AND connection_id IS NULL AND status = 'active'`,
        [input.tenantId, input.ownerPhone, input.clientId],
      );

  if (existing) {
    const row = await queryOne<ContactMessageWatch>(
      `UPDATE contact_message_watches SET mode = $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [input.tenantId, existing.id, input.mode],
    );
    return row ?? existing;
  }

  const row = await queryOne<ContactMessageWatch>(
    `INSERT INTO contact_message_watches
       (tenant_id, connection_id, owner_phone, client_id, mode, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING *`,
    [input.tenantId, connectionId, input.ownerPhone, input.clientId, input.mode],
  );
  if (!row) throw new Error('Falha ao gravar aviso de contato.');
  return row;
}

export async function cancelContactWatch(input: {
  tenantId: string;
  ownerPhone: string;
  clientId: string;
  connectionId?: string | null;
}): Promise<boolean> {
  assertTenantMatchesScope(input.tenantId);
  if (input.connectionId) {
    const { rowCount } = await query(
      `UPDATE contact_message_watches
          SET status = 'cancelled'
        WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
          AND connection_id = $4 AND status = 'active'`,
      [input.tenantId, input.ownerPhone, input.clientId, input.connectionId],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await query(
    `UPDATE contact_message_watches
        SET status = 'cancelled'
      WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
        AND status = 'active'`,
    [input.tenantId, input.ownerPhone, input.clientId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listActiveWatches(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<ContactMessageWatch[]> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rows } = await query<ContactMessageWatch>(
      `SELECT w.*, c.name AS client_name, c.phone AS client_phone
         FROM contact_message_watches w
         JOIN clients c ON c.id = w.client_id
        WHERE w.tenant_id = $1 AND w.owner_phone = $2 AND w.status = 'active'
          AND w.connection_id = $3
        ORDER BY w.created_at ASC`,
      [tenantId, ownerPhone, connectionId],
    );
    return rows;
  }
  const { rows } = await query<ContactMessageWatch>(
    `SELECT w.*, c.name AS client_name, c.phone AS client_phone
       FROM contact_message_watches w
       JOIN clients c ON c.id = w.client_id
      WHERE w.tenant_id = $1 AND w.owner_phone = $2 AND w.status = 'active'
      ORDER BY w.created_at ASC`,
    [tenantId, ownerPhone],
  );
  return rows;
}

/** Avisos ativos deste contato neste WhatsApp (para disparar no inbound). */
export async function listActiveWatchesForClient(
  tenantId: string,
  clientId: string,
  connectionId?: string | null,
): Promise<ContactMessageWatch[]> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rows } = await query<ContactMessageWatch>(
      `SELECT * FROM contact_message_watches
        WHERE tenant_id = $1 AND client_id = $2 AND status = 'active'
          AND connection_id = $3`,
      [tenantId, clientId, connectionId],
    );
    return rows;
  }
  const { rows } = await query<ContactMessageWatch>(
    `SELECT * FROM contact_message_watches
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'active'`,
    [tenantId, clientId],
  );
  return rows;
}

/** Marca aviso único como disparado. Retorna false se outro tick já pegou. */
export async function claimOnceWatch(tenantId: string, id: string): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const row = await queryOne<{ id: string }>(
    `UPDATE contact_message_watches
        SET status = 'fired', last_notified_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND mode = 'once'
      RETURNING id`,
    [tenantId, id],
  );
  return row !== null;
}

/** Atualiza last_notified_at se passou o debounce (avisos recorrentes). */
export async function touchAlwaysWatch(
  tenantId: string,
  id: string,
  debounceSeconds = 120,
): Promise<boolean> {
  assertTenantMatchesScope(tenantId);
  const row = await queryOne<{ id: string }>(
    `UPDATE contact_message_watches
        SET last_notified_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND mode = 'always'
        AND (
          last_notified_at IS NULL
          OR last_notified_at < NOW() - ($3 || ' seconds')::interval
        )
      RETURNING id`,
    [tenantId, id, String(debounceSeconds)],
  );
  return row !== null;
}
