import { pool, closePool, queryOne } from './index';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import { hasEncryptionKey } from '../utils/crypto';
import { hashPassword } from '../utils/password';
import {
  getConnectionByTenant,
  upsertConnection,
  type WhatsappSecrets,
} from './queries/whatsapp_connections';
import { countAiProviders, createAiProvider } from './queries/ai_providers';
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

  const hash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, tenant_id)
     VALUES ($1, $2, $3, 'admin', $4)`,
    [env.SEED_ADMIN_NAME, env.SEED_ADMIN_EMAIL, hash, DEFAULT_TENANT_ID],
  );

  logger.info(`Usuário admin criado: ${env.SEED_ADMIN_EMAIL} / senha definida em SEED_ADMIN_PASSWORD`);
}

/**
 * Garante o dono da plataforma (super-admin). Se SUPERADMIN_EMAIL existir entre
 * os usuários, promove a 'superadmin'. Se não existir e houver
 * SUPERADMIN_PASSWORD, cria a conta no tenant padrão. Idempotente.
 */
async function ensureSuperAdmin(): Promise<void> {
  const email = env.SUPERADMIN_EMAIL;
  if (!email) {
    logger.info('SUPERADMIN_EMAIL não definido — pulando criação do super-admin.');
    return;
  }

  const existing = await queryOne<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE email = $1',
    [email.toLowerCase()],
  );

  if (existing) {
    if (existing.role !== 'superadmin') {
      await pool.query(`UPDATE users SET role = 'superadmin' WHERE id = $1`, [existing.id]);
      logger.info(`Usuário ${email} promovido a super-admin (dono da plataforma).`);
    } else {
      logger.info(`Super-admin já configurado (${email}). Nada a fazer.`);
    }
    return;
  }

  if (!env.SUPERADMIN_PASSWORD) {
    logger.warn(
      `SUPERADMIN_EMAIL (${email}) não existe e SUPERADMIN_PASSWORD não foi definido — ` +
        'crie o usuário ou defina a senha para o seed criar a conta.',
    );
    return;
  }

  const hash = await hashPassword(env.SUPERADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, tenant_id)
     VALUES ($1, $2, $3, 'superadmin', $4)`,
    ['Plataforma', email.toLowerCase(), hash, DEFAULT_TENANT_ID],
  );
  logger.info(`Super-admin criado: ${email} / senha definida em SUPERADMIN_PASSWORD`);
}

function logWebhookUrl(token: string): void {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  logger.info(`URL de webhook da empresa padrão (configure na Z-API): ${base}/webhook/whatsapp/${token}`);
}

/**
 * Continuidade (Fase 2): cria a conexão de WhatsApp da empresa padrão a partir
 * das credenciais do .env, para a operação atual seguir funcionando com a nova
 * arquitetura por empresa. Idempotente: se já existir conexão, não recria.
 */
async function ensureDefaultWhatsappConnection(): Promise<void> {
  if (!hasEncryptionKey()) {
    logger.warn(
      'ENCRYPTION_KEY ausente — não migrei a conexão do .env. O tenant padrão segue no fallback do .env.',
    );
    return;
  }

  const existing = await getConnectionByTenant(DEFAULT_TENANT_ID);
  if (existing) {
    logger.info('Conexão de WhatsApp do tenant padrão já existe. Nada a fazer.');
    logWebhookUrl(existing.webhook_token);
    return;
  }

  const provider = env.WHATSAPP_PROVIDER;
  const hasCreds =
    provider === 'evolution'
      ? Boolean(env.EVOLUTION_API_KEY && env.EVOLUTION_INSTANCE)
      : Boolean(env.ZAPI_INSTANCE_ID && env.ZAPI_TOKEN);
  if (!hasCreds) {
    logger.info('Sem credenciais de WhatsApp no .env — pulando criação da conexão padrão.');
    return;
  }

  const secrets: WhatsappSecrets =
    provider === 'evolution'
      ? { apiKey: env.EVOLUTION_API_KEY, instance: env.EVOLUTION_INSTANCE }
      : {
          instanceId: env.ZAPI_INSTANCE_ID,
          token: env.ZAPI_TOKEN,
          clientToken: env.ZAPI_CLIENT_TOKEN,
        };
  const baseUrl = provider === 'evolution' ? env.EVOLUTION_BASE_URL : env.ZAPI_BASE_URL;

  const conn = await upsertConnection(DEFAULT_TENANT_ID, { provider, secrets, baseUrl });
  logger.info('Conexão de WhatsApp do tenant padrão criada a partir do .env.');
  logWebhookUrl(conn.webhook_token);
}

/**
 * Continuidade da IA: se ainda não houver provedores cadastrados e existir
 * ANTHROPIC_API_KEY no .env, cria o Claude como provedor padrão (prioridade 0).
 * Assim a automação segue igual e o dono pode adicionar Gemini/Groq/OpenAI no
 * painel para o failover. Idempotente. Requer ENCRYPTION_KEY (para cifrar a chave).
 */
async function ensureDefaultAiProvider(): Promise<void> {
  if (!hasEncryptionKey()) {
    logger.warn(
      'ENCRYPTION_KEY ausente — não cadastrei o provedor de IA padrão. A IA segue no fallback do .env (Claude).',
    );
    return;
  }

  const count = await countAiProviders(null);
  if (count > 0) {
    logger.info(`Provedores de IA globais já cadastrados (${count}). Nada a fazer.`);
    return;
  }

  if (!env.hasAnthropic) {
    logger.info('Sem ANTHROPIC_API_KEY no .env — nenhum provedor de IA padrão criado. Cadastre em /admin.');
    return;
  }

  await createAiProvider({
    tenantId: null,
    kind: 'anthropic',
    label: 'Claude',
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.CLAUDE_MODEL,
    priority: 0,
    isActive: true,
  });
  logger.info('Provedor de IA padrão criado a partir do .env: Claude (Anthropic).');
}

ensureDefaultTenant()
  .then(() => seedAdmin())
  .then(() => ensureSuperAdmin())
  .then(() => ensureDefaultWhatsappConnection())
  .then(() => ensureDefaultAiProvider())
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('Erro no seed', err);
    await closePool();
    process.exit(1);
  });
