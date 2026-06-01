import { query, queryOne } from '../index';

const AGENT_KEY = 'agent_enabled';

/**
 * Cache em memória para evitar uma consulta ao banco a cada mensagem recebida
 * no webhook (caminho quente). O valor é atualizado na escrita (write-through)
 * e expira sozinho após o TTL, garantindo consistência mesmo se for alterado
 * por outra instância/fora do app.
 */
let agentCache: { enabled: boolean; at: number } | null = null;
const CACHE_TTL_MS = 5_000;

async function readSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

/** Indica se o atendente de IA deve responder automaticamente. Default: true. */
export async function isAgentEnabled(): Promise<boolean> {
  if (agentCache && Date.now() - agentCache.at < CACHE_TTL_MS) {
    return agentCache.enabled;
  }
  const value = await readSetting(AGENT_KEY);
  const enabled = value === null ? true : value === 'true';
  agentCache = { enabled, at: Date.now() };
  return enabled;
}

/** Liga/desliga o atendente de IA e atualiza o cache imediatamente. */
export async function setAgentEnabled(enabled: boolean): Promise<boolean> {
  await writeSetting(AGENT_KEY, enabled ? 'true' : 'false');
  agentCache = { enabled, at: Date.now() };
  return enabled;
}
