import { query, queryOne } from '../index';
import { DEFAULT_AI_PERSONA } from '../../config/persona';

const AGENT_KEY = 'agent_enabled';
const PERSONA_KEY = 'ai_persona';
const TEMPERATURE_KEY = 'ai_temperature';
const MAX_TOKENS_KEY = 'ai_max_tokens';

/**
 * Caches em memória, POR tenant, para evitar uma consulta ao banco a cada
 * mensagem recebida no webhook (caminho quente). São atualizados na escrita
 * (write-through) e cada entrada expira após o TTL.
 */
const agentCache = new Map<string, { enabled: boolean; at: number }>();
const personaCache = new Map<string, { prompt: string; at: number }>();
const temperatureCache = new Map<string, { value: number; at: number }>();
const maxTokensCache = new Map<string, { value: number; at: number }>();
const CACHE_TTL_MS = 5_000;

const DEFAULT_AI_TEMPERATURE = 0.7;
const DEFAULT_AI_MAX_TOKENS = 500;

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

// ---------------------------------------------------------------------------
// Temperatura da IA (criatividade) — mesma tabela chave-valor das settings
// ---------------------------------------------------------------------------

function clampTemperature(n: number): number {
  return Math.min(1.5, Math.max(0, n));
}

/** Temperatura usada no atendimento real (generateReply). Default 0.7. */
export async function getAiTemperature(tenantId: string): Promise<number> {
  const cached = temperatureCache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await readSetting(tenantId, TEMPERATURE_KEY);
  const parsed = value !== null ? Number(value) : DEFAULT_AI_TEMPERATURE;
  const temp = Number.isFinite(parsed) ? clampTemperature(parsed) : DEFAULT_AI_TEMPERATURE;
  temperatureCache.set(tenantId, { value: temp, at: Date.now() });
  return temp;
}

/** Persiste a temperatura da IA no atendimento real. */
export async function setAiTemperature(tenantId: string, temperature: number): Promise<number> {
  const temp = clampTemperature(temperature);
  await writeSetting(tenantId, TEMPERATURE_KEY, String(temp));
  temperatureCache.set(tenantId, { value: temp, at: Date.now() });
  return temp;
}

function clampMaxTokens(n: number): number {
  return Math.min(1200, Math.max(50, Math.round(n)));
}

/** maxTokens do atendimento real. Default 500. */
export async function getAiMaxTokens(tenantId: string): Promise<number> {
  const cached = maxTokensCache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await readSetting(tenantId, MAX_TOKENS_KEY);
  const parsed = value !== null ? Number(value) : DEFAULT_AI_MAX_TOKENS;
  const tokens = Number.isFinite(parsed) ? clampMaxTokens(parsed) : DEFAULT_AI_MAX_TOKENS;
  maxTokensCache.set(tenantId, { value: tokens, at: Date.now() });
  return tokens;
}

export async function setAiMaxTokens(tenantId: string, maxTokens: number): Promise<number> {
  const tokens = clampMaxTokens(maxTokens);
  await writeSetting(tenantId, MAX_TOKENS_KEY, String(tokens));
  maxTokensCache.set(tenantId, { value: tokens, at: Date.now() });
  return tokens;
}
