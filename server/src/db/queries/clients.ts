import { query, queryOne } from '../index';
import type { Client } from '../../types';

export async function findClientByPhone(tenantId: string, phone: string): Promise<Client | null> {
  return queryOne<Client>('SELECT * FROM clients WHERE tenant_id = $1 AND phone = $2', [
    tenantId,
    phone,
  ]);
}

export async function findClientByLid(tenantId: string, lid: string): Promise<Client | null> {
  return queryOne<Client>(
    `SELECT * FROM clients
      WHERE tenant_id = $1 AND (whatsapp_lid = $2 OR phone = $2)
      ORDER BY CASE WHEN whatsapp_lid = $2 AND phone <> $2 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, lid],
  );
}

async function setClientLid(tenantId: string, clientId: string, lid: string): Promise<void> {
  await query(
    `UPDATE clients
        SET whatsapp_lid = $3,
            last_contact_at = NOW()
      WHERE id = $1 AND tenant_id = $2
        AND (whatsapp_lid IS NULL OR whatsapp_lid = $3)`,
    [clientId, tenantId, lid],
  );
}

/**
 * Une um cliente-órfão (phone = lid) no cliente real (phone E.164):
 * move conversas e apaga o órfão. Best-effort — se der conflito de unique, só
 * liga o lid no cliente real.
 */
async function mergeOrphanLidClient(
  tenantId: string,
  orphanId: string,
  realId: string,
): Promise<void> {
  if (orphanId === realId) return;
  try {
    // Reaponta conversas do órfão; se já existir open no destino p/ mesma conexão,
    // as msgs do órfão passam para a conversa aberta do real.
    const { rows: orphanConvs } = await query<{ id: string; connection_id: string | null; status: string }>(
      `SELECT id, connection_id, status FROM conversations
        WHERE tenant_id = $1 AND client_id = $2`,
      [tenantId, orphanId],
    );
    for (const oc of orphanConvs) {
      const target = await queryOne<{ id: string }>(
        `SELECT id FROM conversations
          WHERE tenant_id = $1 AND client_id = $2
            AND status <> 'closed'
            AND connection_id IS NOT DISTINCT FROM $3
          ORDER BY started_at DESC
          LIMIT 1`,
        [tenantId, realId, oc.connection_id],
      );
      if (target && target.id !== oc.id) {
        await query(`UPDATE messages_log SET conversation_id = $2 WHERE conversation_id = $1`, [
          oc.id,
          target.id,
        ]);
        await query(`DELETE FROM conversations WHERE id = $1 AND tenant_id = $2`, [oc.id, tenantId]);
      } else {
        await query(`UPDATE conversations SET client_id = $2 WHERE id = $1 AND tenant_id = $3`, [
          oc.id,
          realId,
          tenantId,
        ]);
      }
    }
    await query(`DELETE FROM clients WHERE id = $1 AND tenant_id = $2`, [orphanId, tenantId]);
  } catch {
    // Conflito de unique / corrida — o lid no cliente real já basta para o próximo fromMe.
  }
}

export interface ResolveWhatsappClientInput {
  phone: string;
  lid?: string | null;
  name?: string | null;
  /** true = `phone` é o próprio LID (eco fromMe sem número). */
  phoneIsLid?: boolean;
}

/**
 * Resolve o cliente certo para um webhook WhatsApp, lidando com @lid da Z-API.
 */
export async function findOrCreateClient(
  tenantId: string,
  phone: string,
  name?: string | null,
  opts?: { lid?: string | null; phoneIsLid?: boolean },
): Promise<Client> {
  const lid = opts?.lid?.trim() || null;
  const phoneIsLid = Boolean(opts?.phoneIsLid);

  // 1) fromMe só com LID: achar cliente real que já tem esse lid.
  if (phoneIsLid && (lid || phone)) {
    const key = lid || phone;
    const byLid = await findClientByLid(tenantId, key);
    if (byLid) {
      await query(`UPDATE clients SET last_contact_at = NOW() WHERE id = $1`, [byLid.id]);
      return byLid;
    }
  }

  // 2) Número real (+ lid opcional): upsert por phone e amarra o lid.
  if (!phoneIsLid && phone) {
    const { rows } = await query<Client>(
      `INSERT INTO clients (tenant_id, phone, name, whatsapp_lid)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET last_contact_at = NOW(),
             name = CASE
               WHEN EXCLUDED.name IS NULL OR btrim(EXCLUDED.name) = '' THEN clients.name
               WHEN clients.name IS NULL OR btrim(clients.name) = '' THEN EXCLUDED.name
               WHEN clients.name ~ '^[0-9+\\s.-]+$' THEN EXCLUDED.name
               ELSE clients.name
             END,
             whatsapp_lid = COALESCE(EXCLUDED.whatsapp_lid, clients.whatsapp_lid)
       RETURNING *`,
      [tenantId, phone, name ?? null, lid],
    );
    const client = rows[0];

    // Se existia órfão com phone=lid, funde nele.
    if (lid) {
      const orphan = await findClientByPhone(tenantId, lid);
      if (orphan && orphan.id !== client.id) {
        await mergeOrphanLidClient(tenantId, orphan.id, client.id);
      }
      await setClientLid(tenantId, client.id, lid);
    }
    return (await findClientByPhone(tenantId, phone)) ?? client;
  }

  // 3) Fallback: cria órfão (phone = lid) até chegar um inbound com número real.
  const key = phone || lid;
  if (!key) throw new Error('findOrCreateClient: phone/lid ausente');
  const { rows } = await query<Client>(
    `INSERT INTO clients (tenant_id, phone, name, whatsapp_lid)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, phone) DO UPDATE
       SET last_contact_at = NOW(),
           name = CASE
             WHEN EXCLUDED.name IS NULL OR btrim(EXCLUDED.name) = '' THEN clients.name
             WHEN clients.name IS NULL OR btrim(clients.name) = '' THEN EXCLUDED.name
             WHEN clients.name ~ '^[0-9+\\s.-]+$' THEN EXCLUDED.name
             ELSE clients.name
           END,
           whatsapp_lid = COALESCE(EXCLUDED.whatsapp_lid, clients.whatsapp_lid)
     RETURNING *`,
    [tenantId, key, name ?? null, lid || key],
  );
  return rows[0];
}

/**
 * Upsert de contato da agenda WhatsApp → CRM.
 * `forceName`: sync da agenda sobrescreve o nome com o salvo no aparelho.
 */
export async function upsertClientContact(
  tenantId: string,
  phone: string,
  name: string | null,
  opts?: { forceName?: boolean },
): Promise<'created' | 'updated' | 'skipped'> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return 'skipped';
  const cleanName = name?.trim() ? name.trim().slice(0, 120) : null;
  const existing = await findClientByPhone(tenantId, digits);

  if (!existing) {
    await query(
      `INSERT INTO clients (tenant_id, phone, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, phone) DO NOTHING`,
      [tenantId, digits, cleanName],
    );
    return 'created';
  }

  if (!cleanName) return 'skipped';
  const cur = (existing.name ?? '').trim();
  if (cur.toLowerCase() === cleanName.toLowerCase()) return 'skipped';

  const force = Boolean(opts?.forceName);
  const should =
    force || !cur || /^[0-9+\s.-]+$/.test(cur);
  if (!should) return 'skipped';

  await query(`UPDATE clients SET name = $3 WHERE id = $1 AND tenant_id = $2`, [
    existing.id,
    tenantId,
    cleanName,
  ]);
  return 'updated';
}

export async function listClients(tenantId: string): Promise<Client[]> {
  const { rows } = await query<Client>(
    'SELECT * FROM clients WHERE tenant_id = $1 ORDER BY last_contact_at DESC LIMIT 200',
    [tenantId],
  );
  return rows;
}

/**
 * Lista para export de agenda.
 * Com `connectionId`: só clientes que já conversaram nesse WhatsApp (não vaza outros números).
 */
export async function listClientsForExport(
  tenantId: string,
  connectionId?: string | null,
): Promise<Client[]> {
  if (connectionId) {
    const { rows } = await query<Client>(
      `SELECT DISTINCT cl.*
         FROM clients cl
         INNER JOIN conversations c
           ON c.client_id = cl.id AND c.tenant_id = cl.tenant_id
        WHERE cl.tenant_id = $1
          AND cl.is_active = true
          AND c.connection_id = $2
        ORDER BY COALESCE(cl.name, cl.phone) ASC
        LIMIT 5000`,
      [tenantId, connectionId],
    );
    return rows;
  }
  const { rows } = await query<Client>(
    `SELECT * FROM clients
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY COALESCE(name, phone) ASC
      LIMIT 5000`,
    [tenantId],
  );
  return rows;
}

/**
 * Busca contatos pelo nome (lista da secretária). Preferência a quem já
 * conversou na conexão; match parcial case-insensitive.
 */
/**
 * Busca livre por nome/empresa/telefone (IA / secretária).
 * Aceita trechos curtos, várias palavras e dígitos do telefone.
 */
export async function findClientsByName(
  tenantId: string,
  nameQuery: string,
  opts?: { connectionId?: string | null; limit?: number },
): Promise<Client[]> {
  const q = nameQuery.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(opts?.limit ?? 12, 1), 30);
  const connectionId = opts?.connectionId ?? null;
  const digits = q.replace(/\D/g, '');
  const tokens = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)
    .slice(0, 6);
  if (!tokens.length && digits.length < 4) return [];

  const params: unknown[] = [tenantId];
  const parts: string[] = [];

  for (const t of tokens) {
    params.push(`%${t}%`);
    const i = params.length;
    parts.push(`(cl.name ILIKE $${i} OR cl.company_name ILIKE $${i})`);
  }

  let phoneIdx: number | null = null;
  if (digits.length >= 4) {
    params.push(`%${digits}%`);
    phoneIdx = params.length;
  }

  const nameMatch = parts.length ? `(${parts.join(' AND ')})` : '';
  const phoneMatch = phoneIdx != null ? `cl.phone LIKE $${phoneIdx}` : '';
  const whereMatch =
    nameMatch && phoneMatch
      ? `(${nameMatch} OR ${phoneMatch})`
      : nameMatch || phoneMatch;

  params.push(q);
  const qIdx = params.length;
  params.push(limit);
  const limIdx = params.length;

  if (connectionId) {
    params.push(connectionId);
    const connIdx = params.length;
    const { rows } = await query<Client>(
      `SELECT cl.*
         FROM clients cl
         LEFT JOIN conversations c
           ON c.client_id = cl.id
          AND c.tenant_id = cl.tenant_id
          AND c.connection_id = $${connIdx}
        WHERE cl.tenant_id = $1
          AND cl.is_active = true
          AND (${whereMatch})
        GROUP BY cl.id
        ORDER BY
          MAX(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) DESC,
          CASE
            WHEN lower(COALESCE(cl.name, '')) = lower($${qIdx}) THEN 0
            WHEN cl.name ILIKE $${qIdx} || '%' THEN 1
            ELSE 2
          END,
          cl.last_contact_at DESC NULLS LAST
        LIMIT $${limIdx}`,
      params,
    );
    if (rows.length > 0) return rows;
  }

  const baseParams = params.slice(0, limIdx);
  const { rows } = await query<Client>(
    `SELECT cl.*
       FROM clients cl
      WHERE cl.tenant_id = $1
        AND cl.is_active = true
        AND (${whereMatch})
      ORDER BY
        CASE
          WHEN lower(COALESCE(cl.name, '')) = lower($${qIdx}) THEN 0
          WHEN cl.name ILIKE $${qIdx} || '%' THEN 1
          ELSE 2
        END,
        cl.last_contact_at DESC NULLS LAST
      LIMIT $${limIdx}`,
    baseParams,
  );
  return rows;
}

export async function getClientById(tenantId: string, id: string): Promise<Client | null> {
  return queryOne<Client>('SELECT * FROM clients WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

export async function updateClient(
  tenantId: string,
  id: string,
  patch: Partial<
    Pick<Client, 'name' | 'company_name' | 'segment' | 'notes' | 'is_active' | 'ai_enabled' | 'ai_prompt'>
  >,
): Promise<Client | null> {
  const { rows } = await query<Client>(
    `UPDATE clients SET
       name = COALESCE($3, name),
       company_name = COALESCE($4, company_name),
       segment = COALESCE($5, segment),
       notes = COALESCE($6, notes),
       is_active = COALESCE($7, is_active),
       ai_enabled = COALESCE($8, ai_enabled),
       ai_prompt = CASE WHEN $9::text IS NULL THEN ai_prompt
                        WHEN $9 = '' THEN NULL
                        ELSE $9 END
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [
      id,
      tenantId,
      patch.name ?? null,
      patch.company_name ?? null,
      patch.segment ?? null,
      patch.notes ?? null,
      patch.is_active ?? null,
      patch.ai_enabled ?? null,
      patch.ai_prompt ?? null,
    ],
  );
  return rows[0] ?? null;
}
