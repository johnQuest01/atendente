import { query, queryOne } from '../index';
import type { PublicUser, User } from '../../types';

const PUBLIC_COLS = 'id, name, email, role, created_at';

export async function findUserByEmail(email: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
}

export async function findUserById(id: string): Promise<PublicUser | null> {
  return queryOne<PublicUser>(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1`, [id]);
}

export async function createUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'operator';
}): Promise<PublicUser> {
  const { rows } = await query<PublicUser>(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${PUBLIC_COLS}`,
    [input.name, input.email.toLowerCase(), input.passwordHash, input.role],
  );
  return rows[0];
}
