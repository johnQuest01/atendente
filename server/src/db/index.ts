import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Pool de conexão único para o Neon PostgreSQL.
 * O Neon exige SSL; usamos pooling para reaproveitar conexões em serverless.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error('Erro inesperado no pool do PostgreSQL', err);
});

/**
 * Escopo de tenant da requisição (BUG 1 — RLS / defesa em profundidade).
 *
 * Guardamos o tenant_id do usuário autenticado (ou resolvido no webhook) num
 * AsyncLocalStorage. Quando há tenant no escopo, cada query roda numa transação
 * curta com `SET LOCAL app.tenant_id` — a variável de sessão que as policies de
 * Row-Level Security usam para filtrar as linhas no PRÓPRIO banco. Assim, mesmo
 * que uma query futura esqueça o `WHERE tenant_id = ...`, o banco recusa o
 * vazamento entre empresas.
 *
 * Usamos transação curta por query (em vez de segurar uma conexão durante toda
 * a requisição) para NÃO reter conexões do pool durante chamadas externas
 * lentas (IA, Z-API) — o `SET LOCAL` é revertido automaticamente no COMMIT.
 *
 * Super-admin e tarefas de sistema (seed/migrations) rodam SEM tenant no escopo:
 * a policy é permissiva quando a variável está vazia, então operações
 * cross-tenant legítimas continuam funcionando.
 */
const tenantStorage = new AsyncLocalStorage<string>();

/** Executa `fn` com o tenant no escopo (ativa o RLS por requisição). */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!env.RLS_ENFORCE || !tenantId) return fn();
  return tenantStorage.run(tenantId, fn);
}

/** Tenant atualmente no escopo (ou undefined fora de requisição/escopo). */
export function currentTenantId(): string | undefined {
  return tenantStorage.getStore();
}

/**
 * Guard de aplicação (defesa em profundidade SOBRE o RLS). Se há um tenant no
 * escopo da requisição e ele NÃO bate com o `tenantId` que a query vai usar,
 * aborta: um bug que passe o tenant errado dentro de um `runWithTenant` de outra
 * empresa falha alto, em vez de vazar silenciosamente. Tarefas de sistema (sem
 * escopo — agendador, seed) passam livremente, que é onde varremos todas as
 * empresas de propósito.
 */
export function assertTenantMatchesScope(tenantId: string): void {
  const scoped = tenantStorage.getStore();
  if (scoped && tenantId && scoped !== tenantId) {
    throw new Error(
      `Guard de tenant: consulta para "${tenantId}" dentro do escopo "${scoped}". ` +
        'Operação cross-tenant abortada.',
    );
  }
}

/** Roda uma operação numa transação curta com `app.tenant_id` setado (RLS). */
async function runScoped<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* conexão pode já estar inutilizável; o release a descarta */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Executa uma query parametrizada. NUNCA concatene SQL manualmente —
 * sempre passe valores via `params` ($1, $2, ...).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const tenantId = tenantStorage.getStore();
  const result = tenantId
    ? await runScoped(tenantId, (client) => client.query<T>(text, params as unknown[]))
    : await pool.query<T>(text, params as unknown[]);
  const duration = Date.now() - start;
  if (env.isDev) {
    logger.debug('SQL', { duration_ms: duration, rows: result.rowCount, text: text.replace(/\s+/g, ' ').trim().slice(0, 120) });
  }
  return result;
}

/** Atalho para retornar apenas a primeira linha (ou null). */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const { rows } = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Executa um conjunto de operações dentro de uma transação. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const tenantId = tenantStorage.getStore();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Mantém o isolamento RLS também nas operações atômicas multi-statement.
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error('Falha ao conectar no banco', err);
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
