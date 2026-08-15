import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { extractSearchQuery, expandSearchQuery } from '../../reminders/reminder-actions';
import { detectLivePair, fetchLiveQuote } from '../live-quotes';
import type { Tool, ToolExecutor } from './types';

const SEARCH_TIMEOUT_MS = 14_000;
const FETCH_RESULTS = 8;
const KEEP_RESULTS = 4;

type Hit = { title: string; url: string; snippet: string };

/**
 * Tool neutra `web_search` — buscas atuais via API real (Tavily / Brave).
 * Só deve ser registrada se houver chave configurada.
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Pesquisa fatos atuais na web. Você escolhe a query com inteligência: entenda o assunto no fio da conversa, reformule se os resultados forem fracos, busque de novo com outra query. query = o que precisa saber (ex.: "cotação dólar comercial hoje"), NUNCA transcrição de áudio, vocativo nem "pesquise". Não use para catálogo, lembrete ou opinião.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Pergunta ou assunto da busca, já pensado — sem "paulo" nem transcrição.',
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
  if (searchProvider === 'none' || webProvider === 'none') {
    return { provider: null, apiKey: null };
  }
  if (tavilyKey) return { provider: 'tavily', apiKey: tavilyKey };
  if (braveKey) return { provider: 'brave', apiKey: braveKey };
  return { provider: null, apiKey: null };
}

export function isWebSearchToolAvailable(): boolean {
  return resolveSearchConfig().provider != null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isJunkUrl(url: string): boolean {
  const h = hostOf(url);
  return (
    /translate\.google|google\.com\/search|google\.com\/url\?|facebook\.com\/l\.php/i.test(url) ||
    /(pinterest|pinimg|quora|answers\.yahoo|wikihow|ehow|coupons?|promo-code|clickbait)/i.test(h) ||
    /(melhorcambio\.com)$/i.test(h)
  );
}

const QUALITY_HOST = [
  'g1.globo.com',
  'folha.uol.com.br',
  'uol.com.br',
  'estadao.com.br',
  'infomoney.com.br',
  'valor.globo.com',
  'exame.com',
  'investing.com',
  'br.investing.com',
  'reuters.com',
  'bbc.com',
  'bbc.co.uk',
  'bloomberg.com',
  'cnbc.com',
  'nytimes.com',
  'wikipedia.org',
  'gov.br',
  'bcb.gov.br',
  'ibge.gov.br',
  'b3.com.br',
  'tradingview.com',
  'google.com',
  'who.int',
  'nature.com',
  'scielo.br',
];

function qualityScore(hit: Hit): number {
  const host = hostOf(hit.url);
  let n = 0;
  if (QUALITY_HOST.some((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(host))) n += 40;
  if (/\.gov\.br$|\.edu\.br$|\.org$/.test(host)) n += 25;
  if (isJunkUrl(hit.url)) n -= 80;
  const snip = hit.snippet || '';
  if (snip.length > 80) n += 8;
  if (/\b20(2[4-9]|3\d)\b|\bhoje\b|\bR\$\s*\d/i.test(`${hit.title} ${snip}`)) n += 12;
  if (/https?:\/\//i.test(hit.url)) n += 4;
  return n;
}

function rankHits(hits: Hit[]): Hit[] {
  return hits
    .filter((h) => (h.url || h.snippet) && !isJunkUrl(h.url))
    .sort((a, b) => qualityScore(b) - qualityScore(a))
    .slice(0, KEEP_RESULTS);
}

function compactSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function formatHits(hits: Hit[], query: string, answer?: string): string {
  const list = rankHits(hits);
  if (!list.length && !answer) {
    return `Nenhum resultado encontrado para: ${query}\nChame web_search de novo com uma consulta mais precisa.`;
  }
  const lines: string[] = [];
  if (answer?.trim()) lines.push(`Resumo da busca: ${answer.trim()}`);
  for (const h of list) {
    lines.push([h.title, compactSnippet(h.snippet), h.url].filter(Boolean).join('\n'));
  }
  lines.push(
    'Julgue estes hits: se forem fracos, desatualizados ou fora do pedido, chame web_search de novo com query melhor. Responda com a sua leitura + 1 URL real — não cole a lista.',
  );
  return lines.join('\n\n');
}

function urlsFromHits(hits: Hit[]): string[] {
  return [...new Set(rankHits(hits).map((h) => h.url).filter(Boolean))].slice(0, 5);
}

function looksLikeModelQuery(q: string): boolean {
  const n = q.toLowerCase();
  if (/\b(paulo|secretari|\[áudio\]|\[audio\]|pesquise|transcrev)\b/i.test(n)) return false;
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && q.length >= 12;
}

function cleanSearchQuery(raw: string): string {
  const trimmed = raw.trim().slice(0, 400);
  if (!trimmed) return '';
  if (looksLikeModelQuery(trimmed)) return trimmed;
  const cleaned = extractSearchQuery(trimmed);
  const base = cleaned.length >= 3 ? cleaned : trimmed;
  return expandSearchQuery(base).slice(0, 400);
}

export type WebSearchHits = { text: string; urls: string[]; query: string };

async function tavilySearch(
  query: string,
  apiKey: string,
  depth: 'basic' | 'advanced',
): Promise<{ hits: Hit[]; answer?: string }> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: depth,
      max_results: FETCH_RESULTS,
      include_answer: true,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${detail.slice(0, 160)}`);
  }
  const json = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits = (json.results ?? [])
    .map((r) => ({
      title: (r.title ?? '').trim() || '(sem título)',
      url: (r.url ?? '').trim() || '',
      snippet: (r.content ?? '').trim(),
    }))
    .filter((h) => h.url || h.snippet);
  return { hits, answer: json.answer };
}

async function collectHits(
  query: string,
  apiKey: string,
  provider: 'tavily' | 'brave',
): Promise<WebSearchHits> {
  if (provider === 'tavily') {
    let pack: { hits: Hit[]; answer?: string };
    try {
      pack = await tavilySearch(query, apiKey, 'advanced');
    } catch (err) {
      logger.warn('Tavily advanced falhou, tentando basic', err);
      pack = await tavilySearch(query, apiKey, 'basic');
    }
    const ranked = rankHits(pack.hits);
    return {
      query,
      text: formatHits(pack.hits, query, pack.answer),
      urls: urlsFromHits(ranked),
    };
  }
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(FETCH_RESULTS));
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
      snippet: (r.description ?? '').trim(),
    }))
    .filter((h) => h.url || h.snippet);
  return { query, text: formatHits(hits, query), urls: urlsFromHits(hits) };
}

export async function searchWebDetailed(rawQuery: string): Promise<WebSearchHits> {
  const query = cleanSearchQuery(rawQuery);
  if (!query) return { query: '', text: 'Nenhum resultado encontrado para: (consulta vazia)', urls: [] };
  const cfg = resolveSearchConfig();
  if (!cfg.provider || !cfg.apiKey) {
    return { query, text: `Nenhum resultado encontrado para: ${query}`, urls: [] };
  }
  logger.info(`tool web_search: query="${query.slice(0, 120)}" provider=${cfg.provider}`);
  const hits = await collectHits(query, cfg.apiKey, cfg.provider);
  const pair = detectLivePair(rawQuery) || detectLivePair(query);
  if (!pair) return hits;
  const live = await fetchLiveQuote(pair);
  if (!live) return hits;
  return {
    ...hits,
    text: `COTAÇÃO AO VIVO (fato de mercado agora — prefira este número a snippet velho):\n${live}\n\n${hits.text}`,
  };
}

export const executeWebSearch: ToolExecutor = async (input) => {
  const raw =
    input && typeof input === 'object' && 'query' in input
      ? String((input as { query: unknown }).query ?? '').trim()
      : '';
  try {
    const hits = await searchWebDetailed(raw);
    return hits.text;
  } catch (err) {
    logger.warn('tool web_search falhou', err);
    return `Nenhum resultado encontrado para: ${raw || '(consulta vazia)'}`;
  }
};
