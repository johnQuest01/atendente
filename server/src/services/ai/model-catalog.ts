import type { AiCredentials, AiKeyCheck, AiKind } from './types';

/**
 * Catalogo de modelos por provedor. Serve para:
 *   1. VALIDAR de verdade um modelo digitado (existe nesse provedor?), e nao so
 *      checar se a chave responde — um modelo errado passava no "Testar chave"
 *      e so quebrava (404) na hora de responder o cliente.
 *   2. SUGERIR o nome certo quando o usuario erra a digitacao (campo "Outro").
 *
 * Tudo via os endpoints publicos de listagem (GET /models) de cada provedor —
 * sem consumir tokens.
 */

export interface ModelListResult {
  /** Conseguiu listar (endpoint respondeu 200). */
  ok: boolean;
  /** Chave invalida/sem permissao (401/403 — Gemini as vezes 400). */
  authError: boolean;
  status?: number;
  /** IDs dos modelos, "limpos" (sem o prefixo "models/" do Gemini). */
  models: string[];
  error?: string;
}

const DEFAULT_BASE: Record<AiKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

const LIST_TIMEOUT_MS = 8000;

function trimBase(kind: AiKind, baseUrl?: string | null): string {
  return (baseUrl || DEFAULT_BASE[kind]).replace(/\/+$/, '');
}

function netError(err: unknown): ModelListResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, authError: false, models: [], error: msg.includes('timeout') ? 'tempo esgotado' : msg };
}

interface OpenAiModelsBody {
  data?: Array<{ id?: unknown }>;
}
interface AnthropicModelsBody {
  data?: Array<{ id?: unknown }>;
}
interface GeminiModelsBody {
  models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
}

function ids(arr: Array<{ id?: unknown }> | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter((s): s is string => s.length > 0);
}

async function fetchOpenAi(creds: AiCredentials): Promise<ModelListResult> {
  const base = trimBase('openai', creds.baseUrl);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true, status: res.status, models: [] };
    if (!res.ok) return { ok: false, authError: false, status: res.status, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as OpenAiModelsBody;
    return { ok: true, authError: false, status: res.status, models: ids(body.data) };
  } catch (err) {
    return netError(err);
  }
}

async function fetchAnthropic(creds: AiCredentials): Promise<ModelListResult> {
  const base = trimBase('anthropic', creds.baseUrl);
  try {
    // limit=1000 traz o catalogo inteiro de uma vez (default da API e 20).
    const res = await fetch(`${base}/v1/models?limit=1000`, {
      headers: { 'x-api-key': creds.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, authError: true, status: res.status, models: [] };
    if (!res.ok) return { ok: false, authError: false, status: res.status, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as AnthropicModelsBody;
    return { ok: true, authError: false, status: res.status, models: ids(body.data) };
  } catch (err) {
    return netError(err);
  }
}

async function fetchGemini(creds: AiCredentials): Promise<ModelListResult> {
  const base = trimBase('gemini', creds.baseUrl);
  try {
    const res = await fetch(`${base}/models?key=${encodeURIComponent(creds.apiKey)}&pageSize=1000`, {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, authError: true, status: res.status, models: [] };
    }
    if (!res.ok) return { ok: false, authError: false, status: res.status, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as GeminiModelsBody;
    const models = (Array.isArray(body.models) ? body.models : [])
      .map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : ''))
      .filter((s): s is string => s.length > 0);
    return { ok: true, authError: false, status: res.status, models };
  } catch (err) {
    return netError(err);
  }
}

/** Lista os modelos disponiveis de um provedor usando a chave informada. */
export function fetchModels(kind: AiKind, creds: AiCredentials): Promise<ModelListResult> {
  if (kind === 'anthropic') return fetchAnthropic(creds);
  if (kind === 'gemini') return fetchGemini(creds);
  return fetchOpenAi(creds);
}

/** Distancia de Levenshtein (edicoes) entre duas strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function similarityScore(target: string, candidate: string): number {
  if (target === candidate) return 0;
  // Conter um ao outro (ex.: "gpt-5.4" vs "gpt-5.4-mini") conta como bem proximo.
  if (candidate.includes(target) || target.includes(candidate)) return 1;
  return levenshtein(target, candidate);
}

/**
 * Sugere os modelos mais parecidos com o que o usuario digitou (corrige typos).
 * Ignora candidatos absurdamente distantes para nao poluir com palpites ruins.
 */
export function suggestModels(target: string, candidates: string[], limit = 3): string[] {
  const t = target.trim().toLowerCase();
  if (!t || candidates.length === 0) return [];
  const maxDistance = Math.max(4, Math.ceil(t.length * 0.6));
  return candidates
    .map((c) => ({ id: c, score: similarityScore(t, c.toLowerCase()) }))
    .filter((x) => x.score <= maxDistance)
    .sort((a, b) => a.score - b.score || a.id.length - b.id.length || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

/**
 * Valida a chave E o modelo: confirma que a chave responde e que o modelo
 * informado existe de fato no provedor. Se o modelo nao existir, sugere os
 * nomes mais proximos. Usado tanto pelo "Testar chave" quanto pelo health-check.
 */
export async function validateKeyAndModel(kind: AiKind, creds: AiCredentials): Promise<AiKeyCheck> {
  const r = await fetchModels(kind, creds);
  if (r.authError) return { ok: false, detail: 'Chave inválida ou sem permissão (não foi possível listar os modelos).' };
  if (!r.ok) {
    return {
      ok: false,
      detail: r.error ? `Não foi possível validar agora (${r.error}).` : `Provedor respondeu HTTP ${r.status ?? '???'}.`,
    };
  }
  if (r.models.length === 0) {
    return { ok: true, detail: `Chave válida (não consegui listar modelos para conferir "${creds.model}").` };
  }
  if (r.models.includes(creds.model)) {
    return { ok: true, detail: `Chave válida e modelo "${creds.model}" disponível.` };
  }
  const near = suggestModels(creds.model, r.models, 3);
  const hint = near.length
    ? ` Você quis dizer: ${near.join(', ')}?`
    : ' Confira o identificador exato no painel do provedor.';
  return { ok: false, detail: `Chave OK, mas o modelo "${creds.model}" não existe nesse provedor.${hint}` };
}
