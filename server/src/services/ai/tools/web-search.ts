import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import type { Tool, ToolExecutor } from './types';

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 5;

/**
 * Tool neutra `web_search` — buscas atuais via API real (Tavily / Brave).
 * Só deve ser registrada se houver chave configurada.
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Busca informações atuais na web (Tavily). Use SOMENTE quando o dono pedir fato atual que você não sabe: cotação, notícia, horário, dado recente. NÃO use para conversa, lembrete, contato, raciocínio ou opinião — nesses casos responda direto, sem pesquisar.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Consulta de busca em linguagem natural.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

function resolveSearchConfig(): {
  provider: 'tavily' | 'brave' | null;
  apiKey: string | null;
} {
  // Preferência: SEARCH_* (fase 3). Compat: WEB_SEARCH_* já em produção.
  const searchProvider = (env.SEARCH_PROVIDER || '').toLowerCase();
  const webProvider = (env.WEB_SEARCH_PROVIDER || '').toLowerCase();

  const tavilyKey = env.TAVILY_API_KEY || env.WEB_SEARCH_API_KEY || '';
  const braveKey = env.BRAVE_API_KEY || '';

  if (searchProvider === 'tavily' || (!searchProvider && webProvider === 'tavily')) {
    return tavilyKey ? { provider: 'tavily', apiKey: tavilyKey } : { provider: null, apiKey: null };
  }
  if (searchProvider === 'brave') {
    return braveKey ? { provider: 'brave', apiKey: braveKey } : { provider: null, apiKey: null };
  }
  // Auto: usa a primeira chave disponível.
  if (searchProvider === 'none' || webProvider === 'none') {
    return { provider: null, apiKey: null };
  }
  if (tavilyKey) return { provider: 'tavily', apiKey: tavilyKey };
  if (braveKey) return { provider: 'brave', apiKey: braveKey };
  return { provider: null, apiKey: null };
}

/** Há chave de busca? Sem chave a tool NÃO é oferecida ao modelo. */
export function isWebSearchToolAvailable(): boolean {
  return resolveSearchConfig().provider != null;
}

function formatHits(
  hits: Array<{ title: string; url: string; snippet: string }>,
  query: string,
): string {
  if (!hits.length) return `Nenhum resultado encontrado para: ${query}`;
  return hits
    .slice(0, MAX_RESULTS)
    .map((h, i) => `${i + 1}. ${h.title} · ${h.url} · ${h.snippet}`)
    .join('\n');
}

async function searchTavily(query: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: MAX_RESULTS,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${detail.slice(0, 160)}`);
  }
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits = (json.results ?? [])
    .map((r) => ({
      title: (r.title ?? '').trim() || '(sem título)',
      url: (r.url ?? '').trim() || '',
      snippet: (r.content ?? '').trim().slice(0, 280),
    }))
    .filter((h) => h.url || h.snippet);
  return formatHits(hits, query);
}

async function searchBrave(query: string, apiKey: string): Promise<string> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(MAX_RESULTS));
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brave HTTP ${res.status}: ${detail.slice(0, 160)}`);
  }
  const json = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const hits = (json.web?.results ?? [])
    .map((r) => ({
      title: (r.title ?? '').trim() || '(sem título)',
      url: (r.url ?? '').trim() || '',
      snippet: (r.description ?? '').trim().slice(0, 280),
    }))
    .filter((h) => h.url || h.snippet);
  return formatHits(hits, query);
}

export const executeWebSearch: ToolExecutor = async (input) => {
  const query =
    input && typeof input === 'object' && 'query' in input
      ? String((input as { query: unknown }).query ?? '').trim().slice(0, 400)
      : '';
  if (!query) return 'Nenhum resultado encontrado para: (consulta vazia)';

  const cfg = resolveSearchConfig();
  if (!cfg.provider || !cfg.apiKey) {
    return `Nenhum resultado encontrado para: ${query}`;
  }

  logger.info(`tool web_search: query="${query.slice(0, 120)}" provider=${cfg.provider}`);

  try {
    if (cfg.provider === 'tavily') return await searchTavily(query, cfg.apiKey);
    return await searchBrave(query, cfg.apiKey);
  } catch (err) {
    logger.warn('tool web_search falhou', err);
    return `Nenhum resultado encontrado para: ${query}`;
  }
};
