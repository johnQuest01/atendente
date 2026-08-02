import { query, queryOne } from '../index';
import type { Client } from '../../types';

export async function findClientByPhone(tenantId: string, phone: string): Promise<Client | null> {
  return queryOne<Client>('SELECT * FROM clients WHERE tenant_id = $1 AND phone = $2', [
    tenantId,
    phone,
  ]);
}

export async function findOrCreateClient(
  tenantId: string,
  phone: string,
  name?: string | null,
): Promise<Client> {
  // Upsert atômico: evita a corrida em que duas mensagens simultâneas de um
  // número NOVO violariam a restrição UNIQUE(tenant_id, phone) e fariam a 2ª
  // falhar. Mantém o nome já cadastrado (só preenche se estiver vazio) e
  // atualiza o último contato.
  const { rows } = await query<Client>(
    `INSERT INTO clients (tenant_id, phone, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE
       SET last_contact_at = NOW(),
           name = COALESCE(clients.name, EXCLUDED.name)
     RETURNING *`,
    [tenantId, phone, name ?? null],
  );
  return rows[0];
}

export async function listClients(tenantId: string): Promise<Client[]> {
  const { rows } = await query<Client>(
    'SELECT * FROM clients WHERE tenant_id = $1 ORDER BY last_contact_at DESC LIMIT 200',
    [tenantId],
  );
  return rows;
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
       -- string vazia limpa o prompt; undefined mantém o que já existe.
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
