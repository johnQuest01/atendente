import { query, queryOne } from '../index';
import { DEFAULT_AI_PERSONA } from '../../config/persona';

const AGENT_KEY = 'agent_enabled';
const PERSONA_KEY = 'ai_persona';

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

// ---------------------------------------------------------------------------
// Persona / instruções da IA (system prompt editável pelo app)
// ---------------------------------------------------------------------------

let personaCache: { prompt: string; at: number } | null = null;

/**
 * Retorna a persona (system prompt) que a IA deve seguir. Se o usuário não
 * personalizou, devolve o padrão. Usa cache curto para não consultar o banco a
 * cada mensagem recebida (caminho quente do webhook).
 */
export async function getAiPersona(): Promise<string> {
  if (personaCache && Date.now() - personaCache.at < CACHE_TTL_MS) {
    return personaCache.prompt;
  }
  const value = await readSetting(PERSONA_KEY);
  const prompt = value && value.trim() ? value : DEFAULT_AI_PERSONA;
  personaCache = { prompt, at: Date.now() };
  return prompt;
}

/**
 * Salva a persona personalizada. Texto vazio limpa a personalização (volta ao
 * padrão). Atualiza o cache imediatamente (write-through).
 */
export async function setAiPersona(prompt: string): Promise<string> {
  const clean = prompt.trim();
  await writeSetting(PERSONA_KEY, clean);
  const effective = clean ? clean : DEFAULT_AI_PERSONA;
  personaCache = { prompt: effective, at: Date.now() };
  return effective;
}
