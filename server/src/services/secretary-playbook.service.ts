import { getSecretaryPlaybook } from '../db/queries/settings';
import { phoneMatchesHint } from '../utils/phone-hint';

/**
 * Caderno de treino da secretária: o dono escreve no app, a IA interpreta e executa.
 * Cada pedido termina com ponto. "Exceto X" vira pedido separado.
 * Emoji é aplicado na saída (não só no prompt), com exceção por número/nome.
 */

const EMOJI_WORD = /emo+[ijg]+/i;

const FORBID_EMOJI = new RegExp(
  String.raw`n[aã]o\s+use\s+${EMOJI_WORD.source}|sem\s+${EMOJI_WORD.source}|proibid[oa]s?\s+${EMOJI_WORD.source}|nada\s+de\s+${EMOJI_WORD.source}|zero\s+${EMOJI_WORD.source}|nunca\s+(?:use|usar)\s+${EMOJI_WORD.source}`,
  'i',
);

const ALLOW_EMOJI = new RegExp(
  String.raw`(?:pode(?:m)?|liberad|permit|vale|usar|use|usando|mandar|responder\s+com|com|qualquer).{0,40}${EMOJI_WORD.source}|${EMOJI_WORD.source}.{0,24}(?:liberad|permit|ok|vale|pode|livre)`,
  'i',
);

const WANT_SHORT =
  /\bfala\s+curto\b|\brespostas?\s+curtas?\b|\bcurto\b|\bsem\s+text[aã]o\b|\b1\s*a\s*3\s+frases\b/i;

const GLOBAL_SCOPE =
  /\b(?:nenhum\s+contato|ningu[eé]m|qualquer\s+(?:pessoa|contato|um)|todos(?:\s+os\s+contatos)?|todo\s+mundo|pra\s+todo|para\s+todos)\b/i;

const EXCEPTION_SPLIT =
  /(?<=[.!?])\s+|\n+|,\s*(?=\bex+c?eto\b)|\s*(?=\b(?:ex+c?eto|excepto|menos\s+(?:a|o|minha|meu)|tirando)\b)/i;

const EXCEPTION_PREFIX = /^(?:ex+c?eto|excepto|menos|tirando)\s+/i;

const NAME_STOP = new Set(
  (
    'nao não use usar emoji emogi emoiji para pra por com o a os as um uma uns umas de do da dos das e ou em no na nos nas ' +
    'que se ao aos responder resposta contato contatos pessoa pessoas nenhum ninguem ninguém qualquer todos todo toda todas ' +
    'mundo ela ele voce você voces vocês pode podem texto textao textão curto fala falar mandar manda avisa avisar quando ' +
    'chamar chama minha meu minhas meus este esta esse essa isto isso numero número'
  ).split(/\s+/),
);

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}]/gu;

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function clausePhones(clause: string): string[] {
  return (clause.match(/\d{8,13}/g) ?? []).map((d) => d.replace(/\D/g, '')).filter((d) => d.length >= 8);
}

function phoneIn(clause: string, toPhone: string): boolean {
  return clausePhones(clause).some((p) => phoneMatchesHint(toPhone, p) || phoneMatchesHint(p, toPhone));
}

function relationshipMatch(clause: string, contactName?: string | null): boolean {
  if (!contactName) return false;
  const c = fold(clause);
  const n = fold(contactName);
  if (/(esposa|mulher|wife|namorada)/.test(c) && /(esposa|mulher|wife|namorada|alian)/.test(n)) return true;
  if (/(marido|husband|namorado)/.test(c) && /(marido|husband|namorado)/.test(n)) return true;
  return false;
}

function clauseNameTokens(clause: string): string[] {
  return fold(clause)
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !NAME_STOP.has(w) && !EMOJI_WORD.test(w));
}

function nameMatches(clause: string, contactName?: string | null): boolean {
  if (relationshipMatch(clause, contactName)) return true;
  if (!contactName) return false;
  const n = fold(contactName).replace(/[^\p{L}\s]/gu, ' ');
  const tokens = clauseNameTokens(clause);
  return tokens.some((t) => n.includes(t));
}

const EMOJI_SEQ_RE = new RegExp(`(?:${EMOJI_RE.source})+`, 'gu');

function extractUnicodeEmojis(text: string): string[] {
  EMOJI_SEQ_RE.lastIndex = 0;
  const found = text.match(EMOJI_SEQ_RE) ?? [];
  return [...new Set(found.filter((s) => /[^\uFE0F\u200D]/.test(s)))];
}

function orderAllowsEmoji(clause: string): boolean {
  if (orderForbidsEmoji(clause)) return false;
  if (ALLOW_EMOJI.test(clause)) return true;
  const pasted = extractUnicodeEmojis(clause);
  if (
    pasted.length &&
    /\b(use|usar|usa|manda|mandar|com|pode|coloque|coloca|envie|envia|responda|responder)\b/i.test(clause)
  ) {
    return true;
  }
  return orderAsksEmojiByName(clause);
}

/** "emoji de coração / foguete / …" — a IA conhece todos; não há lista fechada. */
function orderAsksEmojiByName(clause: string): boolean {
  if (orderForbidsEmoji(clause)) return false;
  if (/\bqualquer\b/i.test(clause)) return false;
  return /emo+[ijg]+s?\s+de\s+[\p{L}]{2,}/iu.test(clause);
}

function orderWantsOnlyThoseEmojis(clause: string): boolean {
  return /\b(s[oó]|soh|apenas|somente)\b/i.test(clause);
}

export function messageAsksForEmoji(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const t = fold(raw);
  if (EMOJI_WORD.test(t) || /\bfigurinha\b/.test(t)) return true;
  if (extractUnicodeEmojis(raw).length && /\b(manda|mande|envie|envia|usa|use|quero|mostra)\b/.test(t)) {
    return true;
  }
  return false;
}

export function requestedEmojisForRecipient(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): { emojis: string[]; only: boolean; namedAsk: boolean } {
  const allow = splitPlaybookOrders(playbook).filter(
    (c) => orderAllowsEmoji(c) && !orderForbidsEmoji(c) && clauseAppliesTo(c, toPhone, contactName),
  );
  const emojis: string[] = [];
  let only = false;
  let namedAsk = false;
  for (const c of allow) {
    if (orderAsksEmojiByName(c) && !extractUnicodeEmojis(c).length) namedAsk = true;
    const chunk = extractUnicodeEmojis(c);
    if (!chunk.length) continue;
    if (orderWantsOnlyThoseEmojis(c)) {
      only = true;
      emojis.length = 0;
      emojis.push(...chunk);
    } else {
      for (const e of chunk) {
        if (!emojis.includes(e)) emojis.push(e);
      }
    }
  }
  return { emojis, only, namedAsk };
}

function orderForbidsEmoji(clause: string): boolean {
  return FORBID_EMOJI.test(clause);
}

function isTargeted(clause: string): boolean {
  return (
    clausePhones(clause).length > 0 ||
    clauseNameTokens(clause).length > 0 ||
    /(esposa|mulher|wife|namorada|marido|husband|namorado)/i.test(clause)
  );
}

function clauseAppliesTo(clause: string, toPhone: string, contactName?: string | null): boolean {
  const phones = clausePhones(clause);
  const named = nameMatches(clause, contactName);
  const allow = orderAllowsEmoji(clause) && !orderForbidsEmoji(clause);
  if (allow) {
    if (phones.length) return phoneIn(clause, toPhone) || named;
    if (isTargeted(clause)) return named;
    return true;
  }
  if (GLOBAL_SCOPE.test(clause)) return true;
  if (phones.length) return phoneIn(clause, toPhone) || named;
  if (isTargeted(clause) && !named && !phoneIn(clause, toPhone)) return false;
  if (named) return true;
  return true;
}

function ordersForRecipient(playbook: string, toPhone: string, contactName?: string | null): string[] {
  return splitPlaybookOrders(playbook).filter((c) => clauseAppliesTo(c, toPhone, contactName));
}

/** Cada pedido = frase com ponto, linha nova, ou trecho depois de "exceto". */
export function splitPlaybookOrders(playbook: string): string[] {
  return playbook
    .replace(/\r\n/g, '\n')
    .split(EXCEPTION_SPLIT)
    .map((c) => c.replace(EXCEPTION_PREFIX, '').trim())
    .filter((c) => c.replace(/[.!?]+$/g, '').trim().length >= 3);
}

/** Grava no banco com um pedido por linha, cada um com ponto final. */
export function normalizePlaybookOrders(raw: string): string {
  const orders = splitPlaybookOrders(raw);
  if (!orders.length) return '';
  return orders.map((o) => o.replace(/[.!?]+$/g, '').trim() + '.').join('\n');
}

export type EmojiPolicy = 'allow' | 'forbid' | 'neutral';

export function playbookEmojiPolicy(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): EmojiPolicy {
  const orders = splitPlaybookOrders(playbook);
  const allows = orders.some(
    (c) => orderAllowsEmoji(c) && !orderForbidsEmoji(c) && clauseAppliesTo(c, toPhone, contactName),
  );
  if (allows) return 'allow';
  const forbids = orders.some((c) => orderForbidsEmoji(c) && clauseAppliesTo(c, toPhone, contactName));
  if (forbids) return 'forbid';
  return 'neutral';
}

export function playbookForbidsEmoji(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): boolean {
  return playbookEmojiPolicy(playbook, toPhone, contactName) === 'forbid';
}

export function playbookAllowsEmoji(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): boolean {
  return playbookEmojiPolicy(playbook, toPhone, contactName) === 'allow';
}

export function playbookWantsShort(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): boolean {
  return ordersForRecipient(playbook, toPhone, contactName).some((c) => WANT_SHORT.test(c));
}

export function stripEmojis(text: string): string {
  return text
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textHasEmoji(text: string): boolean {
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}

/** Se o treino colou um emoji, garante que ele saia. Não inventa um par fixo. */
export function ensureEmojis(
  text: string,
  requested: string[] = [],
  only = false,
): string {
  const out = text.trim();
  if (!out) return text;
  const want = requested.filter(Boolean);
  if (only && want.length) {
    const stripped = stripEmojis(out);
    return `${stripped} ${want.join('')}`.trim();
  }
  if (want.length) {
    const missing = want.filter((e) => !out.includes(e));
    if (!missing.length) return text;
    return `${out} ${missing.join('')}`.trim();
  }
  return text;
}

export function applyPlaybookStyle(
  playbook: string,
  toPhone: string,
  text: string,
  contactName?: string | null,
  lastUserMessage?: string | null,
): string {
  if (lastUserMessage && messageAsksForEmoji(lastUserMessage)) return text;
  const policy = playbookEmojiPolicy(playbook, toPhone, contactName);
  if (policy === 'forbid') return stripEmojis(text);
  if (policy === 'allow') {
    const { emojis, only } = requestedEmojisForRecipient(playbook, toPhone, contactName);
    return ensureEmojis(text, emojis, only);
  }
  return text;
}

export async function applySecretaryPlaybookToText(input: {
  tenantId: string;
  connectionId?: string | null;
  toPhone: string;
  text: string;
  contactName?: string | null;
  lastUserMessage?: string | null;
}): Promise<string> {
  const playbook = await getSecretaryPlaybook(input.tenantId, input.connectionId).catch(() => '');
  if (!playbook) return input.text;
  return applyPlaybookStyle(
    playbook,
    input.toPhone,
    input.text,
    input.contactName,
    input.lastUserMessage,
  );
}

export function recipientPlaybookConstraints(
  playbook: string,
  toPhone: string,
  contactName?: string | null,
): string {
  const policy = playbookEmojiPolicy(playbook, toPhone, contactName);
  let applicable = ordersForRecipient(playbook, toPhone, contactName);
  if (policy === 'allow') {
    applicable = applicable.filter((c) => !orderForbidsEmoji(c));
  }
  const rules: string[] = [];
  if (policy === 'forbid') {
    rules.push(
      'PROIBIDO emoji, emoticon ou figurinha NESTA resposta. Zero. Nem um. (vale mesmo se for o dono.)',
    );
  } else if (policy === 'allow') {
    const { emojis, only, namedAsk } = requestedEmojisForRecipient(playbook, toPhone, contactName);
    if (emojis.length) {
      rules.push(
        only
          ? `EMOJI PEDIDO: use SOMENTE ${emojis.join(' ')} nesta resposta. Nenhum outro.`
          : `EMOJI PEDIDO: use ${emojis.join(' ')} nesta resposta.`,
      );
    } else if (namedAsk) {
      rules.push(
        'O treino pediu um emoji PELO NOME. Você conhece TODOS. Mande exatamente o emoji pedido (coração=❤️, foguete=🚀, gato=🐱, o que for). Se pediram só o emoji, mande só ele.',
      );
    } else {
      rules.push(
        'EXCEÇÃO ATIVA: esta pessoa PODE receber qualquer emoji. Você conhece todos. Use o que couber (ou o que o treino pediu pelo nome). O "não use emoji" NÃO vale para ela.',
      );
    }
  }
  if (playbookWantsShort(playbook, toPhone, contactName)) {
    rules.push('Fale CURTO: 1 a 3 frases. Sem textão.');
  }
  if (!applicable.length && !rules.length) return '';
  const who = contactName ? `${contactName} (${toPhone})` : toPhone;
  return [
    `TREINO ATIVO AGORA para ${who} — execute:`,
    ...applicable.map((c, i) => `${i + 1}. ${c.replace(/[.!?]+$/g, '')}.`),
    ...rules.map((r) => `- ${r}`),
    'Isto GANHA da persona e do tom. Não ignore.',
  ].join('\n');
}

export function formatSecretaryPlaybook(
  raw: string,
  toPhone?: string,
  contactName?: string | null,
  lastUserMessage?: string | null,
): string {
  const text = raw.trim();
  if (!text) return '';
  const orders = splitPlaybookOrders(text);
  const listed = orders.map((o, i) => `${i + 1}. ${o.replace(/[.!?]+$/g, '')}.`).join('\n');
  const policy = toPhone ? playbookEmojiPolicy(text, toPhone, contactName) : 'neutral';
  const who = contactName ? `${contactName} (${toPhone})` : toPhone;
  const askedNow = Boolean(lastUserMessage && messageAsksForEmoji(lastUserMessage));
  const asked = toPhone
    ? requestedEmojisForRecipient(text, toPhone, contactName)
    : { emojis: [] as string[], only: false, namedAsk: false };
  const banner = askedNow
    ? `*** PEDIDO DE EMOJI NESTA MENSAGEM. Você conhece TODOS. Mande exatamente o que pediram pelo nome ou colado. Se pediram só o emoji, responda SÓ com ele. O treino "sem emoji" NÃO cancela este comando. ***`
    : policy === 'allow'
      ? asked.emojis.length
        ? `*** AGORA VOCÊ FALA COM ${who}. USE ${asked.emojis.join(' ')}${asked.only ? ' SOMENTE' : ''} NESTA RESPOSTA. ***`
        : asked.namedAsk
          ? `*** AGORA VOCÊ FALA COM ${who}. O treino pediu emoji PELO NOME — mande exatamente esse (você conhece todos). ***`
          : `*** AGORA VOCÊ FALA COM ${who}. Emoji LIBERADO. Você conhece todos. O "não use emoji" NÃO vale para esta pessoa. ***`
      : policy === 'forbid'
        ? `*** AGORA VOCÊ FALA COM ${who}. PROIBIDO EMOJI. Zero. ***`
        : '';
  const live = toPhone ? recipientPlaybookConstraints(text, toPhone, contactName) : '';
  return [
    banner,
    live,
    'TREINO DO DONO — PRIORIDADE MÁXIMA DESTE WHATSAPP. Vale NA HORA. Obedeça.',
    'Você conhece TODOS os emojis. Pedido pelo nome (coração, foguete, gato…) ou colado = o emoji certo. Sem lista fechada.',
    'Cada item é um PEDIDO separado. "Exceto / exeto" separa a exceção do resto.',
    'Interprete o sentido (emogi/emoiji=emoji, contro=contato, exeto=exceto) e EXECUTE.',
    'Se discordar da persona ou do tom, o TREINO GANHA.',
    'Pedido com NOME ou NÚMERO vale para essa pessoa — mesmo que seja o dono.',
    'Se disser "nenhum contato" / "qualquer pessoa", vale para TODOS, salvo o "exceto".',
    'Comando do dono nesta fala (lembrar, avisar, mandar emoji, parar de responder) GANHA do treino.',
    '',
    listed || text,
  ]
    .filter(Boolean)
    .join('\n');
}
