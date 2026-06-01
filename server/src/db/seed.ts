import bcrypt from 'bcryptjs';
import { pool, closePool, queryOne } from './index';
import { env } from '../config/env';
import { logger } from '../config/logger';
import type { User } from '../types';

async function seedAdmin(): Promise<void> {
  const existing = await queryOne<User>('SELECT id FROM users WHERE email = $1', [
    env.SEED_ADMIN_EMAIL,
  ]);

  if (existing) {
    logger.info(`Usuário admin já existe (${env.SEED_ADMIN_EMAIL}). Nada a fazer.`);
    return;
  }

  const hash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')`,
    [env.SEED_ADMIN_NAME, env.SEED_ADMIN_EMAIL, hash],
  );

  logger.info(`Usuário admin criado: ${env.SEED_ADMIN_EMAIL} / senha definida em SEED_ADMIN_PASSWORD`);
}

seedAdmin()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('Erro no seed', err);
    await closePool();
    process.exit(1);
  });
