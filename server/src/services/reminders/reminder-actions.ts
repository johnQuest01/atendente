import { DEFAULT_TZ, fromWallClock, toWallClock } from './time';

const SEARCH_RE =
  /\b(pesquis|busca|buscar|procure|procura|google|na internet|na web|cotac|preco do|preco da|quanto esta|quanto custa|quanto foi)/;

const FUTURE_WHEN_RE =
  /\b(quando for|quando der|as \d{1,2}|amanha|depois das|daqui a|daqui um|me avisa as|me avise as|da tarde|da noite|da manha)|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s+e\s+\d{1,2}\b/;

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}:\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tira vocativo, enrolação do áudio e horário — sobra o pedido. */
function stripSpeechFiller(folded: string): string {
  return folded
    .replace(/^\[audio\]\s*/i, '')
    .replace(/^\s*(?:audio\s+)+/g, '')
    .replace(/^\s*(?:paulo|secretari[oa]|mayra|assistente)\b/g, '')
    .replace(/\b(por favor|pfv|pf|ok|ta bom|ta|beleza|obrigado|valeu)\b/g, ' ')
    .replace(/\bfaca(?:r)?(?: uma)?(?: pesquisa| busca)?(?: pra| para)?(?: mim)?(?: uma)?(?: de| sobre)?\b/g, ' ')
    .replace(/\bfaz(?:er)?(?: uma)?(?: pesquisa| busca)?(?: pra| para)?(?: mim)?(?: uma)?(?: de| sobre)?\b/g, ' ')
    .replace(/\b(?:pra|para)\s+mim\b/g, ' ')
    .replace(/\buma de\b/g, ' ')
    .replace(/\bquando for\b/g, ' ')
    .replace(/\bquando der\b/g, ' ')
    .replace(/\bme lembra(?: de)?\b/g, ' ')
    .replace(/\bme avisa(?: de)?\b/g, ' ')
    .replace(/\bme chama\b/g, ' ')
    .replace(/\banota(?:r|i)?\b/g, ' ')
    .replace(/\bpesquis\w*(?:\s+(?:pra|para)\s+mim)?(?:\s+(?:na\s+internet|na\s+web))?(?:\s+(?:sobre|de))?\b/g, ' ')
    .replace(/\bbusc\w*(?:\s+(?:pra|para)\s+mim)?(?:\s+(?:na\s+internet|na\s+web))?(?:\s+(?:sobre|de))?\b/g, ' ')
    .replace(/\b\d{1,2}\s+e\s+\d{1,2}\s+(?:da|de)\s+(tarde|noite|manha)\b/g, ' ')
    .replace(/\bas \d{1,2}(?::\d{2})?h?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}h(?:\d{2})?\b/g, ' ')
    .replace(/\b(?:da|de)\s+(tarde|noite|manha)\b/g, ' ')
    .replace(/\b(hoje|amanha)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function taskLooksLikeSearch(task: string): boolean {
  return SEARCH_RE.test(fold(task));
}

export function userAskedTranscript(text: string): boolean {
  const n = fold(text);
  return /\b(transcrev\w*|passa(?:r)?\s+(?:pra|para|pro)\s+texto|escreve\s+o\s+audio|o\s+que\s+eu\s+(?:falei|disse)|ditado)/.test(
    n,
  );
}

/** Texto falado sem o comando "transcreva este áudio". */
export function extractDictationText(text: string): string {
  const raw = text.replace(/^\[áudio\]\s*/i, '').replace(/^\[audio\]\s*/i, '').trim();
  const stripped = raw
    .replace(/^(paulo|secret[aá]ri[oa]|mayra|assistente)[,.\s:]*/i, '')
    .replace(/\btranscrev\w*\s+(este|esse|o|este aqui|isso)?\s*(áudio|audio)?[,:\s]*/i, '')
    .replace(/\bpassa(?:r)?\s+(pra|para|pro)\s+texto[,:\s]*/i, '')
    .replace(/\bescreve\s+o\s+(áudio|audio)[,:\s]*/i, '')
    .replace(/\bditado[,:\s]*/i, '')
    .replace(/^[,.\s]+/, '')
    .trim();
  return (stripped.length >= 2 ? stripped : raw).slice(0, 4000);
}

export function userAskedSearchLink(text: string): boolean {
  const n = fold(text);
  return /\b(link|url|fonte)\b/.test(n);
}

export function userAskedSearchNow(text: string): boolean {
  if (userAskedTranscript(text)) return false;
  const n = fold(text);
  const withoutLinkAsk = n
    .replace(/\blink(?: da pesquisa| da busca| da fonte)?\b/g, ' ')
    .replace(/\bda pesquisa\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (userAskedSearchLink(text) && !SEARCH_RE.test(withoutLinkAsk) && !/\b(dolar|bitcoin|euro|preco|cotac|quanto esta)\b/.test(withoutLinkAsk)) {
    return false;
  }
  return SEARCH_RE.test(n) && !FUTURE_WHEN_RE.test(n);
}

export function userAskedScheduledSearch(text: string): boolean {
  if (userAskedTranscript(text)) return false;
  const n = fold(text);
  return SEARCH_RE.test(n) && FUTURE_WHEN_RE.test(n);
}

/** Pedido para anotar algo num horário — não precisa da IA para gravar. */
export function userAskedTimedNotebook(text: string): boolean {
  if (userAskedScheduledSearch(text)) return true;
  const n = fold(text);
  if (!FUTURE_WHEN_RE.test(n) && !parseClockFromText(text)) return false;
  if (
    /\b(o que|quais|mostra|me mostra|lista|tem algum|tem o que)\b/.test(n) &&
    !/\b(lembr|anota|agenda|marca|avisa|quando for|quando der)\b/.test(n)
  ) {
    return false;
  }
  return /\b(lembr|anota|agenda|marca|avisa|me chama|quando for|quando der|nao me deixa esquecer|compromisso|lembrete)/.test(
    n,
  );
}

export function extractNotebookTask(text: string): string {
  const folded = stripSpeechFiller(fold(text));
  if (folded.length >= 4) return folded.slice(0, 400);
  const raw = text.replace(/^\[áudio\]\s*/i, '').replace(/^\[audio\]\s*/i, '').trim();
  return raw.slice(0, 400);
}

export function expandSearchQuery(query: string): string {
  const n = fold(query);
  const year = new Date().getFullYear();
  const words = n.split(/\s+/).filter(Boolean);
  // Query já pensada pelo modelo (assunto específico) passa. Só amplia pedido curto de preço.
  const short = words.length <= 7;
  if (!short) return query;
  const extra =
    /\b(historico|previsao|noticia|impacto|recorde|porque|por que|como|quando surgiu)\b/.test(n);
  if (extra) {
    if (!/\b20\d{2}\b/.test(n) && /\b(noticia|hoje|agora)\b/.test(n)) {
      return `${query} ${year}`.slice(0, 400);
    }
    return query;
  }
  if (/\bdolar\b/.test(n) && !/\b(bitcoin|euro|mini|indice|turismo)\b/.test(n)) {
    return 'cotação dólar comercial hoje USD BRL';
  }
  if (/\beuro\b/.test(n) && !/\bmini\b/.test(n)) {
    return 'cotação euro comercial hoje EUR BRL';
  }
  if (/\b(bitcoin|btc)\b/.test(n)) {
    return 'preço bitcoin hoje em reais BTC BRL';
  }
  if (/\bmini indice\b/.test(n) || /\bwin\b/.test(n)) {
    return 'mini índice B3 WIN cotação hoje';
  }
  if (/\bmini dolar\b/.test(n) || /\bwdo\b/.test(n)) {
    return 'mini dólar B3 WDO cotação hoje';
  }
  if (
    /\b(cotac|preco|noticia|hoje|agora|quanto esta|quanto custa|quanto foi)\b/.test(n) &&
    !/\b20\d{2}\b/.test(n)
  ) {
    return `${query} hoje ${year}`.slice(0, 400);
  }
  return query;
}

export function extractSearchQuery(text: string): string {
  const n = fold(text)
    .replace(/^\s*(?:audio\s+)+/g, '')
    .replace(/^\s*(?:paulo|secretari[oa]|mayra|assistente)\b/g, '')
    .replace(/\b(por favor|pfv|pf|ok|ta bom|beleza|obrigado|valeu)\b/g, ' ')
    .replace(
      /\bpesquis\w*(?:\s+(?:pra|para)\s+mim)?(?:\s+(?:na\s+internet|na\s+web))?(?:\s+(?:sobre|de|o|a))?\b/g,
      ' ',
    )
    .replace(
      /\bbusc\w*(?:\s+(?:pra|para)\s+mim)?(?:\s+(?:na\s+internet|na\s+web))?(?:\s+(?:sobre|de|o|a))?\b/g,
      ' ',
    )
    .replace(/\b(google|na internet|na web)\b/g, ' ')
    .replace(/\bquando for\b/g, ' ')
    .replace(/\bquando der\b/g, ' ')
    .replace(/\bme lembra(?: de)?\b/g, ' ')
    .replace(/\bme avisa(?: de)?\b/g, ' ')
    .replace(/\bfaca(?:r)?(?: uma)?\b/g, ' ')
    .replace(/\b\d{1,2}\s+e\s+\d{1,2}\s+(?:da|de)\s+(tarde|noite|manha)\b/g, ' ')
    .replace(/\bas \d{1,2}(?::\d{2})?h?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}h(?:\d{2})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:do|da|de|o|a)\s+/g, '');
  return (n || fold(text).replace(/^\s*(?:audio\s+)+/, '').trim()).slice(0, 400);
}

export function parseClockFromText(text: string, now = new Date(), tz = DEFAULT_TZ): Date | null {
  const n = fold(text);
  let hour: number | null = null;
  let minute = 0;

  const spokenShift = n.match(
    /\b(\d{1,2})\s+e\s+(\d{1,2})\s+(?:da|de)\s+(tarde|noite|manha)\b/,
  );
  const hourShift = n.match(/\b(\d{1,2})\s+(?:da|de)\s+(tarde|noite|manha)\b/);
  const hMm = n.match(/\b(\d{1,2})h(\d{2})\b/);
  const colon = n.match(/\b(\d{1,2}):(\d{2})\b/);
  const hourOnly = n.match(/\b(\d{1,2})\s*h(?:oras?)?\b/);

  const applyShift = (h: number, period: string): number => {
    if (period === 'tarde' && h > 0 && h < 12) return h + 12;
    if (period === 'noite') {
      if (h === 12) return 0;
      if (h > 0 && h < 12) return h + 12;
    }
    if (period === 'manha' && h === 12) return 0;
    return h;
  };

  if (spokenShift) {
    hour = applyShift(Number(spokenShift[1]), spokenShift[3]!);
    minute = Number(spokenShift[2]);
  } else if (hourShift) {
    hour = applyShift(Number(hourShift[1]), hourShift[2]!);
    minute = 0;
  } else if (hMm) {
    hour = Number(hMm[1]);
    minute = Number(hMm[2]);
  } else if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else if (hourOnly) {
    hour = Number(hourOnly[1]);
    minute = 0;
  }

  if (hour === null || hour > 23 || minute > 59) return null;
  const wc = toWallClock(now, tz);
  const at = fromWallClock(
    { year: wc.year, month: wc.month, day: wc.day, hour, minute },
    tz,
  );
  if (at.getTime() > now.getTime()) return at;
  return fromWallClock(
    { year: wc.year, month: wc.month, day: wc.day + 1, hour, minute },
    tz,
  );
}

export type ReminderFireAction = 'notify' | 'search';

export function inferFireAction(task: string, sourceText?: string | null): ReminderFireAction {
  if (taskLooksLikeSearch(task) || (sourceText && taskLooksLikeSearch(sourceText))) return 'search';
  return 'notify';
}
