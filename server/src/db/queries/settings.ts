import { query, queryOne } from '../index';
import { DEFAULT_AI_PERSONA } from '../../config/persona';

const AGENT_KEY = 'agent_enabled';
const PERSONA_KEY = 'ai_persona';

/**
 * Caches em memória, POR tenant, para evitar uma consulta ao banco a cada
 * mensagem recebida no webhook (caminho quente). São atualizados na escrita
 * (write-through) e cada entrada expira após o TTL.
 */
const agentCache = new Map<string, { enabled: boolean; at: number }>();
const personaCache = new Map<string, { prompt: string; at: number }>();
const CACHE_TTL_MS = 5_000;

async function readSetting(tenantId: string, key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    'SELECT value FROM settings WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return row?.value ?? null;
}

async function writeSetting(tenantId: string, key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [tenantId, key, value],
  );
}

/** Indica se o atendente de IA deve responder automaticamente. Default: true. */
export async function isAgentEnabled(tenantId: string): Promise<boolean> {
  const cached = agentCache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.enabled;
  }
  const value = await readSetting(tenantId, AGENT_KEY);
  const enabled = value === null ? true : value === 'true';
  agentCache.set(tenantId, { enabled, at: Date.now() });
  return enabled;
}

/** Liga/desliga o atendente de IA e atualiza o cache imediatamente. */
export async function setAgentEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
  await writeSetting(tenantId, AGENT_KEY, enabled ? 'true' : 'false');
  agentCache.set(tenantId, { enabled, at: Date.now() });
  return enabled;
}

// ---------------------------------------------------------------------------
// Persona / instruções da IA (system prompt editável pelo app)
// ---------------------------------------------------------------------------

/**
 * Retorna a persona (system prompt) que a IA deve seguir. Se o usuário não
 * personalizou, devolve o padrão. Usa cache curto para não consultar o banco a
 * cada mensagem recebida (caminho quente do webhook).
 */
export async function getAiPersona(tenantId: string): Promise<string> {
  const cached = personaCache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.prompt;
  }
  const value = await readSetting(tenantId, PERSONA_KEY);
  const prompt = value && value.trim() ? value : DEFAULT_AI_PERSONA;
  personaCache.set(tenantId, { prompt, at: Date.now() });
  return prompt;
}

/**
 * Salva a persona personalizada. Texto vazio limpa a personalização (volta ao
 * padrão). Atualiza o cache imediatamente (write-through).
 */
export async function setAiPersona(tenantId: string, prompt: string): Promise<string> {
  const clean = prompt.trim();
  await writeSetting(tenantId, PERSONA_KEY, clean);
  const effective = clean ? clean : DEFAULT_AI_PERSONA;
  personaCache.set(tenantId, { prompt: effective, at: Date.now() });
  return effective;
}
