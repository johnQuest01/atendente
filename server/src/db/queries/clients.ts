import { query, queryOne } from '../index';
import type { Client } from '../../types';

export async function findClientByPhone(phone: string): Promise<Client | null> {
  return queryOne<Client>('SELECT * FROM clients WHERE phone = $1', [phone]);
}

export async function findOrCreateClient(phone: string, name?: string | null): Promise<Client> {
  const existing = await findClientByPhone(phone);
  if (existing) {
    const { rows } = await query<Client>(
      `UPDATE clients
         SET last_contact_at = NOW(),
             name = COALESCE(name, $2)
       WHERE phone = $1
       RETURNING *`,
      [phone, name ?? null],
    );
    return rows[0];
  }

  const { rows } = await query<Client>(
    `INSERT INTO clients (phone, name)
     VALUES ($1, $2)
     RETURNING *`,
    [phone, name ?? null],
  );
  return rows[0];
}

export async function listClients(): Promise<Client[]> {
  const { rows } = await query<Client>(
    'SELECT * FROM clients ORDER BY last_contact_at DESC LIMIT 200',
  );
  return rows;
}

export async function updateClient(
  id: string,
  patch: Partial<Pick<Client, 'name' | 'company_name' | 'segment' | 'notes' | 'is_active'>>,
): Promise<Client | null> {
  const { rows } = await query<Client>(
    `UPDATE clients SET
       name = COALESCE($2, name),
       company_name = COALESCE($3, company_name),
       segment = COALESCE($4, segment),
       notes = COALESCE($5, notes),
       is_active = COALESCE($6, is_active)
     WHERE id = $1
     RETURNING *`,
    [id, patch.name ?? null, patch.company_name ?? null, patch.segment ?? null, patch.notes ?? null, patch.is_active ?? null],
  );
  return rows[0] ?? null;
}
