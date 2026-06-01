import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool } from './index';
import { logger } from '../config/logger';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getApplied(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM _migrations');
  return new Set(rows.map((r) => r.filename));
}

async function run(): Promise<void> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.error(`Pasta de migrations não encontrada: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  await ensureMigrationsTable();
  const applied = await getApplied();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      logger.debug(`Pulando migration já aplicada: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info(`Migration aplicada: ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Falha na migration ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    logger.info('Nenhuma migration pendente. Banco já está atualizado.');
  } else {
    logger.info(`${count} migration(s) aplicada(s) com sucesso.`);
  }
}

run()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('Erro ao rodar migrations', err);
    await closePool();
    process.exit(1);
  });
