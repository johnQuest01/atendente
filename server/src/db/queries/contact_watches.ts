import { assertTenantMatchesScope, query, queryOne } from '../index';

export type ContactWatchMode = 'once' | 'always';
export type ContactWatchStatus = 'active' | 'fired' | 'cancelled';

export interface ContactMessageWatch {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  owner_phone: string;
  client_id: string | null;
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
  clientId: string | null;
  mode: ContactWatchMode;
  connectionId?: string | null;
}): Promise<ContactMessageWatch> {
  assertTenantMatchesScope(input.tenantId);
  const connectionId = input.connectionId ?? null;
  const clientId = input.clientId;

  const existing = clientId
    ? connectionId
      ? await queryOne<ContactMessageWatch>(
          `SELECT * FROM contact_message_watches
            WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
              AND connection_id = $4 AND status = 'active'`,
          [input.tenantId, input.ownerPhone, clientId, connectionId],
        )
      : await queryOne<ContactMessageWatch>(
          `SELECT * FROM contact_message_watches
            WHERE tenant_id = $1 AND owner_phone = $2 AND client_id = $3
              AND connection_id IS NULL AND status = 'active'`,
          [input.tenantId, input.ownerPhone, clientId],
        )
    : connectionId
      ? await queryOne<ContactMessageWatch>(
          `SELECT * FROM contact_message_watches
            WHERE tenant_id = $1 AND owner_phone = $2 AND client_id IS NULL
              AND connection_id = $3 AND status = 'active'`,
          [input.tenantId, input.ownerPhone, connectionId],
        )
      : await queryOne<ContactMessageWatch>(
          `SELECT * FROM contact_message_watches
            WHERE tenant_id = $1 AND owner_phone = $2 AND client_id IS NULL
              AND connection_id IS NULL AND status = 'active'`,
          [input.tenantId, input.ownerPhone],
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
    [input.tenantId, connectionId, input.ownerPhone, clientId, input.mode],
  );
  if (!row) throw new Error('Falha ao gravar aviso de contato.');
  return row;
}

export async function cancelContactWatch(input: {
  tenantId: string;
  ownerPhone: string;
  clientId: string | null;
  connectionId?: string | null;
}): Promise<boolean> {
  assertTenantMatchesScope(input.tenantId);
  const params: unknown[] = [input.tenantId, input.ownerPhone];
  let sql = `UPDATE contact_message_watches SET status = 'cancelled'
      WHERE tenant_id = $1 AND owner_phone = $2 AND status = 'active'`;
  if (input.clientId) {
    params.push(input.clientId);
    sql += ` AND client_id = $${params.length}`;
  } else {
    sql += ` AND client_id IS NULL`;
  }
  if (input.connectionId) {
    params.push(input.connectionId);
    sql += ` AND connection_id = $${params.length}`;
  }
  const { rowCount } = await query(sql, params);
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
         LEFT JOIN clients c ON c.id = w.client_id
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
       LEFT JOIN clients c ON c.id = w.client_id
      WHERE w.tenant_id = $1 AND w.owner_phone = $2 AND w.status = 'active'
      ORDER BY w.created_at ASC`,
    [tenantId, ownerPhone],
  );
  return rows;
}

/** Avisos ativos deste contato OU de qualquer pessoa neste WhatsApp. */
export async function listActiveWatchesForClient(
  tenantId: string,
  clientId: string,
  connectionId?: string | null,
): Promise<ContactMessageWatch[]> {
  assertTenantMatchesScope(tenantId);
  if (connectionId) {
    const { rows } = await query<ContactMessageWatch>(
      `SELECT * FROM contact_message_watches
        WHERE tenant_id = $1 AND status = 'active' AND connection_id = $2
          AND (client_id = $3 OR client_id IS NULL)`,
      [tenantId, connectionId, clientId],
    );
    return rows;
  }
  const { rows } = await query<ContactMessageWatch>(
    `SELECT * FROM contact_message_watches
      WHERE tenant_id = $1 AND status = 'active'
        AND (client_id = $2 OR client_id IS NULL)`,
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

/** Só marca o horário (aviso global: um toque por contato, sem travar os outros). */
export async function stampWatchNotified(tenantId: string, id: string): Promise<void> {
  assertTenantMatchesScope(tenantId);
  await query(
    `UPDATE contact_message_watches SET last_notified_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tenantId, id],
  );
}
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
