import { logger } from '../config/logger';
import { env } from '../config/env';

/**
 * Busca na web para o modo Agente do dono.
 * Provedor: Tavily (rápido). Sem chave → retorna null e o chat segue sem search.
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function hasWebSearchConfigured(): boolean {
  return env.WEB_SEARCH_PROVIDER === 'tavily' && Boolean(env.WEB_SEARCH_API_KEY);
}

/** Heurística leve: vale a pena buscar antes de responder? */
export function messageLikelyNeedsSearch(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 8) return false;
  return (
    /\b(pesquisa|pesquisar|busca|buscar|procure|procura|google|na internet|na web)\b/.test(t) ||
    /\b(cota[cç][aã]o|d[oó]lar|euro|bitcoin|not[ií]cias?|hoje em dia|atualizado)\b/.test(t) ||
    /\b(qual (é|e) (o|a)|quanto (custa|est[aá]|vale)|hor[aá]rio de funcionamento)\b/.test(t) ||
    /\b(pre[cç]o (do|da|de)|taxa selic|ipca|clima em)\b/.test(t)
  );
}

export async function webSearch(query: string, maxResults = 3): Promise<WebSearchHit[] | null> {
  if (!hasWebSearchConfigured()) return null;
  const q = query.trim().slice(0, 400);
  if (!q) return null;

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.WEB_SEARCH_API_KEY,
        query: q,
        search_depth: 'basic',
        max_results: Math.min(Math.max(maxResults, 1), 5),
        include_answer: false,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn(`Web search HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const json = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits = (json.results ?? [])
      .map((r) => ({
        title: (r.title ?? '').trim(),
        url: (r.url ?? '').trim(),
        snippet: (r.content ?? '').trim().slice(0, 280),
      }))
      .filter((h) => h.title || h.snippet);
    return hits.length ? hits : null;
  } catch (err) {
    logger.warn('Falha na busca web', err);
    return null;
  }
}

export function formatSearchContext(hits: WebSearchHit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}\n   Fonte: ${h.url}`,
  );
  return ['Resultados da busca (use só o que for útil; cite a fonte em 1 linha se fizer sentido):', ...lines].join(
    '\n',
  );
}
