import { query, queryOne } from '../index';
import type { PublicUser, User } from '../../types';

const PUBLIC_COLS = 'id, name, email, role, tenant_id, phone, created_at';

export async function findUserByEmail(email: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
}

export async function findUserById(id: string): Promise<PublicUser | null> {
  return queryOne<PublicUser>(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1`, [id]);
}

/** Atualiza apenas o hash da senha (usado no rehash transparente do login). */
export async function updateUserPasswordHash(id: string, passwordHash: string): Promise<void> {
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'operator';
  tenantId: string;
  phone?: string | null;
}): Promise<PublicUser> {
  const { rows } = await query<PublicUser>(
    `INSERT INTO users (name, email, password_hash, role, tenant_id, phone)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${PUBLIC_COLS}`,
    [
      input.name,
      input.email.toLowerCase(),
      input.passwordHash,
      input.role,
      input.tenantId,
      input.phone?.trim() || null,
    ],
  );
  return rows[0];
}

/** Admin do tenant com telefone (cadastro por convite) — para liberar a secretária. */
export async function findTenantAdminWithPhone(
  tenantId: string,
): Promise<{ id: string; name: string; phone: string } | null> {
  return queryOne<{ id: string; name: string; phone: string }>(
    `SELECT id, name, phone FROM users
      WHERE tenant_id = $1 AND role = 'admin' AND phone IS NOT NULL AND phone <> ''
      ORDER BY created_at ASC
      LIMIT 1`,
    [tenantId],
  );
}
