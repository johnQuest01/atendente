import { getSecretaryPlaybook } from '../db/queries/settings';
import { phoneMatchesHint } from '../utils/phone-hint';

/**
 * Caderno de treino da secretária: o dono escreve no app, a IA interpreta e executa.
 * Cada pedido termina com ponto final. Regras de estilo também são aplicadas na saída.
 */

const FORBID_EMOJI =
  /n[aã]o\s+use\s+emo[jg]i|sem\s+emo[jg]i|proibid[oa]s?\s+emo[jg]i|nada\s+de\s+emo[jg]i|zero\s+emo[jg]i/i;
const WANT_SHORT = /\bfala\s+curto\b|\brespostas?\s+curtas?\b|\bcurto\b|\bsem\s+text[aã]o\b|\b1\s*a\s*3\s+frases\b/i;

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}]/gu;

/** Cada pedido = uma frase terminada em ponto (também aceita ! ? e linha nova). */
export function splitPlaybookOrders(playbook: string): string[] {
  return playbook
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.replace(/[.!?]+$/g, '').trim().length >= 3);
}

/** Grava no banco com um pedido por linha, cada um com ponto final. */
export function normalizePlaybookOrders(raw: string): string {
  const orders = splitPlaybookOrders(raw);
  if (!orders.length) return '';
  return orders.map((o) => o.replace(/[.!?]+$/g, '').trim() + '.').join('\n');
}

function clausePhones(clause: string): string[] {
  return (clause.match(/\d{8,13}/g) ?? []).map((d) => d.replace(/\D/g, '')).filter((d) => d.length >= 8);
}

function clauseAppliesTo(clause: string, toPhone: string): boolean {
  const phones = clausePhones(clause);
  if (!phones.length) return true;
  return phones.some((p) => phoneMatchesHint(toPhone, p) || phoneMatchesHint(p, toPhone));
}

function ordersForRecipient(playbook: string, toPhone: string): string[] {
  return splitPlaybookOrders(playbook).filter((c) => clauseAppliesTo(c, toPhone));
}

export function playbookForbidsEmoji(playbook: string, toPhone: string): boolean {
  return ordersForRecipient(playbook, toPhone).some((c) => FORBID_EMOJI.test(c));
}

export function playbookWantsShort(playbook: string, toPhone: string): boolean {
  return ordersForRecipient(playbook, toPhone).some((c) => WANT_SHORT.test(c));
}

export function stripEmojis(text: string): string {
  return text
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function applyPlaybookStyle(playbook: string, toPhone: string, text: string): string {
  let out = text;
  if (playbookForbidsEmoji(playbook, toPhone)) out = stripEmojis(out);
  return out;
}

export async function applySecretaryPlaybookToText(input: {
  tenantId: string;
  connectionId?: string | null;
  toPhone: string;
  text: string;
}): Promise<string> {
  const playbook = await getSecretaryPlaybook(input.tenantId, input.connectionId).catch(() => '');
  if (!playbook) return input.text;
  return applyPlaybookStyle(playbook, input.toPhone, input.text);
}

export function recipientPlaybookConstraints(playbook: string, toPhone: string): string {
  const applicable = ordersForRecipient(playbook, toPhone);
  if (!applicable.length) return '';
  const rules: string[] = [];
  if (applicable.some((c) => FORBID_EMOJI.test(c))) {
    rules.push(
      'PROIBIDO emoji, emoticon ou figurinha nesta resposta. Zero. Nem um. (vale mesmo se o destinatário for o dono.)',
    );
  }
  if (applicable.some((c) => WANT_SHORT.test(c))) {
    rules.push('Fale CURTO: 1 a 3 frases. Sem textão.');
  }
  return [
    `TREINO ATIVO PARA QUEM VAI RECEBER AGORA (${toPhone}) — execute TODOS estes pedidos:`,
    ...applicable.map((c, i) => `${i + 1}. ${c.replace(/[.!?]+$/g, '')}.`),
    ...rules.map((r) => `- ${r}`),
    'Isto GANHA da persona e do tom.',
  ].join('\n');
}

export function formatSecretaryPlaybook(raw: string, toPhone?: string): string {
  const text = raw.trim();
  if (!text) return '';
  const orders = splitPlaybookOrders(text);
  const listed = orders.map((o, i) => `${i + 1}. ${o.replace(/[.!?]+$/g, '')}.`).join('\n');
  const live = toPhone ? recipientPlaybookConstraints(text, toPhone) : '';
  return [
    'TREINO DO DONO (ordens permanentes DESTE WhatsApp — PRIORIDADE MÁXIMA):',
    'Cada item abaixo é um PEDIDO separado (termina com ponto). Execute TODOS os que se aplicarem nesta resposta.',
    'Interprete o sentido (emogi=emoji, contro=contato) e EXECUTE na hora.',
    'Se discordar da persona ou do tom, o TREINO GANHA.',
    'Se o pedido citar NOME ou NÚMERO, vale para esse destinatário — mesmo que seja o dono.',
    'Comandos do dono (lembrar, avisar, parar de responder) continuam; o treino não impede comando.',
    '',
    listed || text,
    live,
  ]
    .filter(Boolean)
    .join('\n');
}
