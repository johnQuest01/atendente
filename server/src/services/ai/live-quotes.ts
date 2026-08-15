import { logger } from '../../config/logger';

export type AwesomePair = { code: string; label: string };

/** Pares com cotação ao vivo (AwesomeAPI) — dado extra para a IA julgar, não resposta pronta. */
export function detectLivePair(query: string): AwesomePair | null {
  const n = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/\b(bitcoin|btc)\b/.test(n)) return { code: 'BTC-BRL', label: 'Bitcoin' };
  if (/\beuro\b/.test(n) && !/\bmini\b/.test(n)) return { code: 'EUR-BRL', label: 'Euro comercial' };
  if (/\blibra\b/.test(n)) return { code: 'GBP-BRL', label: 'Libra' };
  if (/\bdolar\b/.test(n) && !/\b(mini|turismo|indice)\b/.test(n)) {
    return { code: 'USD-BRL', label: 'Dólar comercial' };
  }
  return null;
}

export async function fetchLiveQuote(pair: AwesomePair): Promise<string | null> {
  try {
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pair.code}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<
      string,
      { bid?: string; ask?: string; pctChange?: string }
    >;
    const row = json[pair.code.replace('-', '')];
    const bid = Number(row?.bid);
    if (!Number.isFinite(bid) || bid <= 0) return null;
    const compra = bid.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ask = Number(row?.ask);
    const venda = Number.isFinite(ask)
      ? ask.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
    const pct = row?.pctChange ? ` (${Number(row.pctChange) >= 0 ? '+' : ''}${row.pctChange}%)` : '';
    return venda
      ? `${pair.label} agora: compra R$ ${compra} / venda R$ ${venda}${pct}`
      : `${pair.label} agora: R$ ${compra}${pct}`;
  } catch (err) {
    logger.warn(`AwesomeAPI ${pair.code} falhou`, err);
    return null;
  }
}

export async function fetchLiveQuoteForQuery(query: string): Promise<string | null> {
  const pair = detectLivePair(query);
  if (!pair) return null;
  return fetchLiveQuote(pair);
}

/** Primeira linha de cotação que a tool colocou no texto — para memória da última busca. */
export function extractLiveQuoteLine(text: string): string {
  const m = text.match(
    /(?:COTA[CÇ][AÃ]O AO VIVO|DADO AO VIVO)[^\n]*\n([^\n]+)/i,
  );
  return (m?.[1] ?? '').trim();
}
