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
 * Executa uma query parametrizada. NUNCA concatene SQL manualmente —
 * sempre passe valores via `params` ($1, $2, ...).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params as unknown[]);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
