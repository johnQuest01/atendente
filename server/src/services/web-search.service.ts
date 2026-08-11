import { logger } from '../config/logger';
import { env } from '../config/env';

/**
 * Busca na web para o modo Agente do dono.
 * - tavily + WEB_SEARCH_API_KEY: melhor qualidade / limites maiores
 * - sem chave: Tavily keyless → fallback DuckDuckGo
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function hasWebSearchConfigured(): boolean {
  return true;
}

function activeProvider(): 'tavily' | 'tavily-keyless' | 'duckduckgo' {
  if (env.WEB_SEARCH_PROVIDER === 'tavily' && env.WEB_SEARCH_API_KEY) return 'tavily';
  if (env.WEB_SEARCH_PROVIDER === 'duckduckgo') return 'duckduckgo';
  return 'tavily-keyless';
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
  const q = query.trim().slice(0, 400);
  if (!q) return null;

  const provider = activeProvider();
  try {
    if (provider === 'tavily') return await searchTavily(q, maxResults, false);
    if (provider === 'tavily-keyless') {
      const keyed = await searchTavily(q, maxResults, true);
      if (keyed?.length) return keyed;
      return await searchDuckDuckGo(q, maxResults);
    }
    return await searchDuckDuckGo(q, maxResults);
  } catch (err) {
    logger.warn(`Falha na busca web (${provider})`, err);
    if (provider !== 'duckduckgo') {
      try {
        return await searchDuckDuckGo(q, maxResults);
      } catch (err2) {
        logger.warn('Falha no fallback DuckDuckGo', err2);
      }
    }
    return null;
  }
}

async function searchTavily(
  query: string,
  maxResults: number,
  keyless: boolean,
): Promise<WebSearchHit[] | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const body: Record<string, unknown> = {
    query,
    search_depth: 'basic',
    max_results: Math.min(Math.max(maxResults, 1), 5),
    include_answer: false,
  };
  if (keyless) {
    headers['X-Tavily-Access-Mode'] = 'keyless';
  } else {
    body.api_key = env.WEB_SEARCH_API_KEY;
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${detail.slice(0, 200)}`);
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
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchHit[] | null> {
  const hits: WebSearchHit[] = [];

  try {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'MayraAgent/1.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        Heading?: string;
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      if (json.AbstractText) {
        hits.push({
          title: json.Heading || query,
          url: json.AbstractURL || 'https://duckduckgo.com/',
          snippet: json.AbstractText.slice(0, 280),
        });
      }
      for (const topic of json.RelatedTopics ?? []) {
        if (hits.length >= maxResults) break;
        if (topic.Text && topic.FirstURL) {
          hits.push({
            title: topic.Text.split(' - ')[0]?.slice(0, 80) || 'Resultado',
            url: topic.FirstURL,
            snippet: topic.Text.slice(0, 280),
          });
        }
      }
    }
  } catch (err) {
    logger.warn('DuckDuckGo Instant Answer falhou', err);
  }

  if (hits.length < maxResults) {
    try {
      const lite = new URL('https://lite.duckduckgo.com/lite/');
      lite.searchParams.set('q', query);
      const res = await fetch(lite.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MayraAgent/1.0)',
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(6_000),
      });
      if (res.ok) {
        const html = await res.text();
        const linkRe =
          /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{3,120})<\/a>/gi;
        let m: RegExpExecArray | null;
        const seen = new Set(hits.map((h) => h.url));
        while ((m = linkRe.exec(html)) && hits.length < maxResults) {
          const url = m[1];
          const title = m[2].replace(/\s+/g, ' ').trim();
          if (!url || seen.has(url) || /duckduckgo\.com/i.test(url)) continue;
          seen.add(url);
          hits.push({ title, url, snippet: title });
        }
      }
    } catch (err) {
      logger.warn('DuckDuckGo lite falhou', err);
    }
  }

  return hits.length ? hits.slice(0, maxResults) : null;
}

export function formatSearchContext(hits: WebSearchHit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}\n   Fonte: ${h.url}`,
  );
  return [
    'Resultados da busca (use só o que for útil; cite a fonte em 1 linha se fizer sentido):',
    ...lines,
  ].join('\n');
}
