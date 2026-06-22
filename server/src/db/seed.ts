import bcrypt from 'bcryptjs';
import { pool, closePool, queryOne } from './index';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import type { User } from '../types';

/** Garante a empresa (tenant) padrão da Fase 1, com UUID fixo. Idempotente. */
async function ensureDefaultTenant(): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_TENANT_ID, 'Empresa 1'],
  );
  logger.info(`Tenant padrão garantido (${DEFAULT_TENANT_ID}).`);
}

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
    `INSERT INTO users (name, email, password_hash, role, tenant_id)
     VALUES ($1, $2, $3, 'admin', $4)`,
    [env.SEED_ADMIN_NAME, env.SEED_ADMIN_EMAIL, hash, DEFAULT_TENANT_ID],
  );

  logger.info(`Usuário admin criado: ${env.SEED_ADMIN_EMAIL} / senha definida em SEED_ADMIN_PASSWORD`);
}

ensureDefaultTenant()
  .then(() => seedAdmin())
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('Erro no seed', err);
    await closePool();
    process.exit(1);
  });
