import { getSecretaryPlaybook } from '../db/queries/settings';
import { phoneMatchesHint } from '../utils/phone-hint';

/**
 * Caderno de treino da secretária: o dono escreve no app, a IA interpreta e executa.
 * Regras de ESTILO (sem emoji, curto) são aplicadas de verdade na saída, não só no prompt.
 */

const FORBID_EMOJI =
  /n[aã]o\s+use\s+emo[jg]i|sem\s+emo[jg]i|proibid[oa]s?\s+emo[jg]i|nada\s+de\s+emo[jg]i|zero\s+emo[jg]i/i;
const WANT_SHORT = /\bfala\s+curto\b|\brespostas?\s+curtas?\b|\bcurto\b|\bsem\s+text[aã]o\b|\b1\s*a\s*3\s+frases\b/i;

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}]/gu;

function clauses(playbook: string): string[] {
  return playbook
    .split(/[\n;]+|(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 4);
}

function clausePhones(clause: string): string[] {
  return (clause.match(/\d{8,13}/g) ?? []).map((d) => d.replace(/\D/g, '')).filter((d) => d.length >= 8);
}

function clauseAppliesTo(clause: string, toPhone: string): boolean {
  const phones = clausePhones(clause);
  if (!phones.length) return true;
  return phones.some((p) => phoneMatchesHint(toPhone, p) || phoneMatchesHint(p, toPhone));
}

export function playbookForbidsEmoji(playbook: string, toPhone: string): boolean {
  const raw = playbook.trim();
  if (!raw) return false;
  for (const c of clauses(raw)) {
    if (!clauseAppliesTo(c, toPhone)) continue;
    if (FORBID_EMOJI.test(c)) return true;
  }
  const allPhones = clausePhones(raw);
  const named = allPhones.length > 0 && allPhones.some((p) => phoneMatchesHint(toPhone, p));
  if (named && FORBID_EMOJI.test(raw)) return true;
  return false;
}

export function playbookWantsShort(playbook: string, toPhone: string): boolean {
  const raw = playbook.trim();
  if (!raw) return false;
  for (const c of clauses(raw)) {
    if (!clauseAppliesTo(c, toPhone)) continue;
    if (WANT_SHORT.test(c)) return true;
  }
  const allPhones = clausePhones(raw);
  const named = allPhones.length > 0 && allPhones.some((p) => phoneMatchesHint(toPhone, p));
  if (named && WANT_SHORT.test(raw)) return true;
  return false;
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
  const raw = playbook.trim();
  if (!raw) return '';
  const rules: string[] = [];
  if (playbookForbidsEmoji(raw, toPhone)) {
    rules.push(
      'PROIBIDO emoji, emoticon ou figurinha nesta resposta. Zero. Nem um. (vale mesmo se o destinatário for o dono.)',
    );
  }
  if (playbookWantsShort(raw, toPhone)) {
    rules.push('Fale CURTO: 1 a 3 frases. Sem textão.');
  }
  if (!rules.length) return '';
  return [
    `TREINO ATIVO PARA QUEM VAI RECEBER AGORA (${toPhone}):`,
    ...rules.map((r) => `- ${r}`),
    'Isto GANHA da persona e do tom. Execute.',
  ].join('\n');
}

export function formatSecretaryPlaybook(raw: string, toPhone?: string): string {
  const text = raw.trim();
  if (!text) return '';
  const live = toPhone ? recipientPlaybookConstraints(text, toPhone) : '';
  return [
    'TREINO DO DONO (ordens permanentes DESTE WhatsApp — PRIORIDADE MÁXIMA):',
    'Interprete o sentido (inclusive erro de digitação: emogi=emoji, contro=contato) e EXECUTE.',
    'Se discordar da persona, do tom ou do fluxo padrão, o TREINO GANHA.',
    'Se o treino citar um NOME ou NÚMERO, vale para esse destinatário — mesmo que seja o dono.',
    'Comandos do dono (lembrar, avisar, parar de responder) continuam valendo; o treino não impede comando.',
    'Estilo (sem emoji, curto, tom) SEMPRE se aplica a quem o treino indicar.',
    '',
    text,
    live,
  ]
    .filter(Boolean)
    .join('\n');
}
