import { logger } from '../../config/logger';
import {
  cancelReminder,
  completeReminder,
  createRemindersBulk,
  getTodayReminders,
  isReminderOwner,
  listReminders,
  type CreateReminderInput,
  type ListRemindersFilter,
} from '../../db/queries/reminders';
import { getActiveKeywords } from '../../db/queries/keywords';
import { isMemoryScanEnabled } from '../../db/queries/settings';
import { keywordMatches } from '../matcher.service';
import { scanForCommitments } from './scan.service';
import { env } from '../../config/env';
import { getTenantWhatsapp, getWhatsappByConnection } from '../whatsapp.service';
import { transcribeAudioFromBase64, transcribeAudioFromUrl } from '../transcription.service';
import type { NormalizedInbound } from '../whatsapp/types';
import type { Reminder } from '../../types';
import type { ChatImage } from '../ai/types';
import { extractVideoFrames } from '../ai/video-frames';
import { describeLead, describeRecurrence, parseReminders, type ParsedReminder } from './parse.service';
import { DEFAULT_TZ, formatForOwner, fromWallClock, toWallClock } from './time';
import {
  freeChatOwner,
  getOwnerModeFlags,
  persistOwnerAssistantReply,
  persistOwnerUserMessage,
} from '../owner-chat.service';
import { recordOwnerEvent } from '../owner-memory.service';
import { extractPhoneHint } from '../../utils/phone-hint';
import {
  displayName,
  parseRelayIntent,
  pickRelayCandidate,
  resolveRelayContacts,
  sendOwnerRelay,
  type RelayCandidate,
} from '../owner-relay.service';
import {
  cancelWatchForAnyone,
  cancelWatchForContact,
  createWatchForAnyone,
  createWatchForContact,
  formatWatchList,
  parseWatchIntent,
  resolveWatchContact,
} from '../contact-watch.service';
import {
  parseReplyMuteIntent,
  resolveMuteContact,
  setContactAutoReply,
} from '../contact-reply.service';
import { rememberContactChoice } from '../owner-contact-memory.service';

/**
 * Assistente pessoal do dono. O mesmo número que atende clientes aceita comandos
 * de lembrete de quem está na whitelist — e essas mensagens nunca entram no
 * fluxo comercial.
 *
 * A parte confiável (consultas, gestão, disparo) não depende de IA. A IA só
 * entra no cadastro em linguagem natural, e sempre com confirmação antes de
 * salvar: é lembrete de pagamento, errar sai caro.
 */

const OWNER_STT_PROMPT =
  'O dono do negócio está ditando um lembrete pessoal em português do Brasil. ' +
  'Pode conter datas e horários (hoje, amanhã, segunda, dia 20, às 15h), e termos como ' +
  'pagar, boleto, fornecedor, cliente, reunião, ligar, cobrar, vencimento, entrega.';

/** Um lembrete já interpretado, aguardando confirmação. */
interface PendingItem {
  task: string;
  category: Reminder['category'];
  recurrence: string | null;
  nextFireAt: Date;
  leadMinutes: number | null;
  /** Frase de confirmação (com o tom da persona) para item único. */
  confirmationText: string;
}

/** Estado curto por dono: confirmação pendente (em massa) e a última lista. */
interface OwnerState {
  at: number;
  pending?: {
    /** Um ou vários lembretes; "SIM" grava todos de uma vez. */
    items: PendingItem[];
    /** Texto original, para o dono poder corrigir sem repetir tudo. */
    source: string;
  };
  /** Escolha de contato quando há vários "Wender". */
  pendingRelay?: {
    body: string;
    contactQuery: string;
    candidates: RelayCandidate[];
  };
  /** Escolha de contato para aviso ("me avisa quando o X mandar"). */
  pendingWatch?: {
    action: 'create' | 'cancel';
    mode: 'once' | 'always';
    contactQuery: string;
    candidates: RelayCandidate[];
  };
  /** Escolha de contato para parar/voltar a responder. */
  pendingMute?: {
    enabled: boolean;
    contactQuery: string;
    candidates: RelayCandidate[];
  };
  lastList?: string[];
}

const STATE_TTL_MS = 15 * 60_000;
const state = new Map<string, OwnerState>();

/**
 * Mensagens do dono não entram em `messages_log`, então não passam pela
 * deduplicação por id que protege o fluxo comercial. Como os provedores
 * reenviam webhooks (a Meta insiste bastante), guardamos os ids recentes aqui
 * — senão um retry cria o lembrete duas vezes.
 */
const seenMessages = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60_000;

function alreadyHandled(messageId: string | null): boolean {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, at] of seenMessages) {
    if (now - at > SEEN_TTL_MS) seenMessages.delete(id);
  }
  if (seenMessages.has(messageId)) return true;
  seenMessages.set(messageId, now);
  return false;
}

function stateKey(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

function getState(tenantId: string, phone: string): OwnerState {
  const key = stateKey(tenantId, phone);
  const current = state.get(key);
  if (current && Date.now() - current.at < STATE_TTL_MS) return current;
  const fresh: OwnerState = { at: Date.now() };
  state.set(key, fresh);
  return fresh;
}

function setState(tenantId: string, phone: string, patch: Partial<OwnerState>): void {
  const key = stateKey(tenantId, phone);
  const current = getState(tenantId, phone);
  state.set(key, { ...current, ...patch, at: Date.now() });
}

/** Conexão WhatsApp ativa durante o tratamento da mensagem do dono. */
const ownerReplyConnection = new Map<string, string>();

const OWNER_COALESCE_MS = 3_200;

interface OwnerCoalesce {
  parts: string[];
  timer: NodeJS.Timeout;
  tenantId: string;
  phone: string;
  tz: string;
  connectionId?: string | null;
}

const ownerCoalesce = new Map<string, OwnerCoalesce>();

function coalesceKey(tenantId: string, phone: string, connectionId?: string | null): string {
  return `${tenantId}:${phone}:${connectionId ?? ''}`;
}

/** SIM/NÃO, agenda curta, ajuda — não espera o próximo balão. */
function isHardImmediateOwnerTurn(text: string, owner: OwnerState): boolean {
  const n = normalize(text);
  const cmd = normalizeCommand(text);
  if (owner.pendingRelay || owner.pendingWatch || owner.pendingMute) {
    if (/^\d{1,2}$/.test(n) || isAffirmative(text) || isNegative(text)) return true;
    if (extractPhoneHint(text)) return true;
  }
  if (owner.pending && (isAffirmative(text) || isNegative(text))) return true;
  if (n === 'ajuda' || n === 'menu' || n === '?') return true;
  if (/^(concluir|conclui|feito|ok|cancelar|cancela|remover|apagar)\s+\d{1,2}$/.test(n)) {
    return true;
  }
  if (detectQuery(n) && cmd.split(/\s+/).length <= 8) return true;
  return false;
}

function isLikelyBrokenOwnerTurn(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (parseWatchIntent(t) && words >= 6) return false;
  if (parseReplyMuteIntent(t) && words >= 5) return false;
  if (parseRelayIntent(t)) return false;
  if (words <= 10) return true;
  if (
    /^(me\s+)?(avisa|avise|lembra|anota|quando|se|me\s+chama)\b/i.test(t) &&
    !parseWatchIntent(t)
  ) {
    return true;
  }
  if (/^(te|o|a|pra|para|de|do|da|quando|assim que)\b/i.test(t) && words <= 14) return true;
  return false;
}

function scheduleOwnerCoalesce(input: {
  tenantId: string;
  phone: string;
  connectionId?: string | null;
  text: string;
  tz: string;
}): void {
  const k = coalesceKey(input.tenantId, input.phone, input.connectionId);
  const existing = ownerCoalesce.get(k);
  if (existing) {
    existing.parts.push(input.text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushOwnerCoalesce(k), OWNER_COALESCE_MS);
    return;
  }
  const row: OwnerCoalesce = {
    parts: [input.text],
    tenantId: input.tenantId,
    phone: input.phone,
    tz: input.tz,
    connectionId: input.connectionId,
    timer: setTimeout(() => void flushOwnerCoalesce(k), OWNER_COALESCE_MS),
  };
  ownerCoalesce.set(k, row);
}

async function flushOwnerCoalesce(k: string): Promise<void> {
  const row = ownerCoalesce.get(k);
  if (!row) return;
  ownerCoalesce.delete(k);
  const joined = row.parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return;
  const key = stateKey(row.tenantId, row.phone);
  if (row.connectionId) ownerReplyConnection.set(key, row.connectionId);
  try {
    await handleOwnerMessageInner(
      row.tenantId,
      {
        type: 'text',
        text: joined,
        phone: row.phone,
      } as NormalizedInbound,
      row.phone,
      row.tz,
      row.connectionId,
      { skipPersist: true, skipCoalesce: true, forcedText: joined },
    );
  } catch (err) {
    logger.warn('Secretária: falha ao juntar mensagens quebradas', err);
  } finally {
    ownerReplyConnection.delete(key);
  }
}

async function reply(tenantId: string, phone: string, text: string, skipPersist = false): Promise<void> {
  const connectionId = ownerReplyConnection.get(stateKey(tenantId, phone));
  const wa = connectionId
    ? await getWhatsappByConnection(tenantId, connectionId)
    : await getTenantWhatsapp(tenantId);
  if (!skipPersist) {
    await persistOwnerAssistantReply(tenantId, phone, text, connectionId);
  }
  await wa.sendText(phone, text).catch((err) => logger.warn('Lembretes: falha ao responder o dono', err));
}

async function transcribeOwnerAudio(inbound: NormalizedInbound): Promise<string | null> {
  if (inbound.mediaBase64) {
    const t = await transcribeAudioFromBase64(inbound.mediaBase64, OWNER_STT_PROMPT);
    if (t) return t;
  }
  if (inbound.mediaUrl) return transcribeAudioFromUrl(inbound.mediaUrl, OWNER_STT_PROMPT);
  return null;
}

/** Prepara imagem/vídeo do dono para a IA com visão. */
async function buildOwnerVisionImages(inbound: NormalizedInbound): Promise<ChatImage[]> {
  if (inbound.type === 'image') {
    if (inbound.mediaUrl) {
      return [{ url: inbound.mediaUrl, mime: inbound.mediaMime ?? undefined }];
    }
    if (inbound.mediaBase64) {
      return [{ base64: inbound.mediaBase64, mime: inbound.mediaMime ?? 'image/jpeg' }];
    }
    return [];
  }
  if (inbound.type === 'video') {
    const source = inbound.mediaUrl;
    if (!source) return [];
    const frames = await extractVideoFrames(source).catch(() => []);
    return frames.map((f) => ({ base64: f.base64, mime: f.mime }));
  }
  return [];
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Remove pontuação do Whisper ("Sim.", "Ok!") para casar com comandos curtos. */
function normalizeCommand(text: string): string {
  return normalize(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AFFIRMATIVE = new Set(['sim', 's', 'ok', 'okay', 'isso', 'confirmar', 'confirma', 'pode', 'certo', 'blz', 'beleza', 'positivo', '1', '👍']);
const NEGATIVE = new Set(['nao', 'n', 'cancela', 'cancelar', 'esquece', 'deixa', 'nada', '0']);
const AFFIRMATIVE_PHRASES = new Set([
  'sim pode',
  'sim confirma',
  'sim confirmo',
  'pode sim',
  'pode salvar',
  'ok pode',
  'isso mesmo',
  'isso ai',
  'fechado',
]);
const NEGATIVE_PHRASES = new Set(['nao pode', 'nao quero', 'deixa pra la', 'melhor nao']);

function isAffirmative(text: string): boolean {
  const n = normalizeCommand(text);
  if (!n) return false;
  if (AFFIRMATIVE.has(n) || AFFIRMATIVE_PHRASES.has(n)) return true;
  // Áudio curto: "Sim, pode." → "sim pode"
  return n.split(/\s+/).length <= 3 && /^(sim|ok|isso)\b/.test(n);
}

function isNegative(text: string): boolean {
  const n = normalizeCommand(text);
  if (!n) return false;
  if (NEGATIVE.has(n) || NEGATIVE_PHRASES.has(n)) return true;
  return n.split(/\s+/).length <= 3 && /^(nao|cancela|cancelar|esquece)\b/.test(n);
}

const HELP_TEXT = [
  'Pode mandar o que quiser anotar (texto ou áudio), tipo:',
  '_"me lembra amanhã às 9h de pagar o fornecedor"_',
  '_"toda sexta cobrar os inadimplentes"_',
  '_"reunião quinta às 15h, me avisa 1 hora antes"_',
  '_"daqui a 10 minutos ligar pro cliente"_',
  '',
  'Pra ver o que tem: _"o que temos pra hoje?"_ · _"compromissos da semana"_',
  'Ou: *HOJE* · *AMANHÃ* · *SEMANA* · *MÊS* · *ROTINA* · *IMPORTANTES* · *TODOS*',
  'Pra fechar: *CONCLUIR 2* · Pra tirar: *CANCELAR 2*',
  '',
  'Com o *Agente* ligado: pergunta livre, texto, pesquisa — eu respondo rápido no zap.',
  'Pra mandar msg a contato: _"mande um boa noite para o Wender agora"_',
  'Pra te avisar quando alguém falar: _"me avisa quando o Wender mandar mensagem"_ ou _"quando o Wender chamar"_',
  'Pra te avisar de todo mundo: _"me avisa quando qualquer pessoa mandar mensagem"_',
  'Pode mandar vários lembretes de uma vez — eu confirmo antes de salvar.',
].join('\n');

const HELP_AGENT_ONLY = [
  'Modo *Agente* ligado — manda pergunta, texto ou "pesquisa X".',
  'Pra te avisar quando alguém falar: _"quando o Wender chamar"_ ou _"me avisa quando a Maria mandar mensagem"_.',
  'De todo mundo: _"me avisa quando qualquer pessoa mandar mensagem"_.',
  'Pra anotar compromisso, ligue a *Secretária* no painel (Lembretes).',
].join('\n');

const HELP_BOTH_OFF = [
  'Secretária e Agente estão desligados neste WhatsApp.',
  'Ligue as alavancas em *Lembretes → Secretária e Agente*.',
].join('\n');

/** Intervalos de consulta, calculados no fuso do dono. */
function rangeFor(keyword: string, tz: string): ListRemindersFilter | null {
  const now = new Date();
  const wc = toWallClock(now, tz);
  const startOfToday = fromWallClock({ ...wc, hour: 0, minute: 0 }, tz);
  const endOfToday = fromWallClock({ ...wc, day: wc.day + 1, hour: 0, minute: 0 }, tz);

  switch (keyword) {
    case 'hoje':
      return { from: startOfToday, until: endOfToday };
    case 'amanha':
      return {
        from: endOfToday,
        until: fromWallClock({ ...wc, day: wc.day + 2, hour: 0, minute: 0 }, tz),
      };
    case 'semana':
      return {
        from: startOfToday,
        until: fromWallClock({ ...wc, day: wc.day + 7, hour: 0, minute: 0 }, tz),
      };
    case 'mes':
      return {
        from: startOfToday,
        until: fromWallClock({ ...wc, day: wc.day + 30, hour: 0, minute: 0 }, tz),
      };
    case 'rotina':
      return { category: 'rotina' };
    case 'importantes':
      return { category: 'importante' };
    case 'todos':
      return {};
    default:
      return null;
  }
}

const QUERY_WORDS: Record<string, string> = {
  hoje: 'hoje',
  amanha: 'amanha',
  semana: 'semana',
  mes: 'mes',
  rotina: 'rotina',
  importantes: 'importantes',
  importante: 'importantes',
  todos: 'todos',
  tudo: 'todos',
  lista: 'todos',
  agenda: 'todos',
  compromissos: 'todos',
  lembretes: 'todos',
};

/**
 * Reconhece PERGUNTA sobre a agenda em linguagem natural — "o que temos para
 * hoje?", "quais meus compromissos da semana", "me mostra a agenda".
 *
 * Sem isto, só a palavra solta ("HOJE") funcionava, e o jeito como uma pessoa
 * realmente fala caía no cadastro: a IA tentava criar um lembrete chamado
 * "o que temos para hoje".
 */
const ASK_OPENERS =
  /\b(o ?que|oque|quais|qual|quantos|quantas|tem algo|tenho algo|tenho alguma|ha algo|me (mostra|mostre|lista|liste|diga|fala|fale|passa)|como (esta|ta|fica))\b/;
const AGENDA_NOUNS = /\b(agenda|compromissos?|lembretes?|tarefas?|programacao|rolando|marcado)\b/;
const SCOPE_WORDS: Array<[RegExp, string]> = [
  [/\bhoje\b/, 'hoje'],
  [/\b(amanha|amanhã)\b/, 'amanha'],
  [/\bsemana\b/, 'semana'],
  [/\b(mes|mês)\b/, 'mes'],
  [/\brotinas?\b/, 'rotina'],
  [/\bimportantes?\b/, 'importantes'],
  [/\b(tudo|todos|todas)\b/, 'todos'],
];

/**
 * Verbos que só aparecem em CADASTRO. "agenda" ficou de fora de propósito: é
 * verbo em "agenda uma reunião" e substantivo em "minha agenda de hoje".
 */
const STRONG_CREATE = /\b(lembr|anota|marca|avisa|nao me deixa esquecer)/;

/** Frases de busca/fato — não são consulta de agenda ("cotação do dólar hoje"). */
const WEB_OR_FACT_TASK =
  /\b(pesquis|busca|buscar|procure|procura|google|na internet|na web|cotac|dolar|dolar|euro|bitcoin|noticia|noticias|selic|ipca|clima|temperatura|preco do|preco da|quanto esta|quanto custa)\b/;

function looksLikeWebOrFactTask(normalized: string): boolean {
  return WEB_OR_FACT_TASK.test(normalized);
}

function detectQuery(normalized: string): string | null {
  // 1) Palavra solta, como sempre funcionou.
  const exact = QUERY_WORDS[normalized];
  if (exact) return exact;

  // "qual a cotação do dólar hoje" / "busca na internet..." → Agente, não agenda.
  if (looksLikeWebOrFactTask(normalized)) return null;

  const asks = ASK_OPENERS.test(normalized);
  const isQuestion = normalized.trim().endsWith('?');
  const mentionsAgenda = AGENDA_NOUNS.test(normalized);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const scope = SCOPE_WORDS.find(([re]) => re.test(normalized))?.[1] ?? null;

  // "me lembra de pagar amanhã" é cadastro, mesmo citando um dia — a menos que
  // a frase seja explicitamente uma pergunta ("o que você tem pra me lembrar?").
  if (STRONG_CREATE.test(normalized) && !asks) return null;

  // Pergunta de agenda precisa citar agenda/compromisso, OU ser bem curta só com
  // o escopo ("o que temos hoje?"). "qual ... hoje" sem substantivo de agenda
  // não conta — evita roubar perguntas factuais do Agente.
  const looksLikeQuery =
    (asks && mentionsAgenda) ||
    (asks && scope !== null && words <= 5 && mentionsAgenda) ||
    (isQuestion && mentionsAgenda) ||
    (mentionsAgenda && words <= 3) ||
    // "o que temos para hoje?" / "o que tem hoje?" — sem a palavra compromisso
    (asks && scope !== null && words <= 6 && /\b(temos|tem|rola|vai ter|tenho)\b/.test(normalized));
  if (!looksLikeQuery) return null;

  return scope ?? 'todos';
}

const QUERY_TITLE: Record<string, string> = {
  hoje: 'HOJE',
  amanha: 'AMANHÃ',
  semana: 'ESTA SEMANA',
  mes: 'ESTE MÊS',
  rotina: 'ROTINAS',
  importantes: 'IMPORTANTES',
  todos: 'TODOS OS LEMBRETES',
};

/** Teto de mensagens individuais, para uma consulta grande não inundar o chat. */
const LIST_SEND_CAP = 15;

/**
 * Envia os compromissos UM POR MENSAGEM (o dono pediu separado), após um
 * cabeçalho curto. A numeração segue a `lastList`, então CONCLUIR/CANCELAR N
 * continuam funcionando. Acima do teto, resume o excedente.
 */
async function sendReminderList(
  tenantId: string,
  phone: string,
  reminders: Reminder[],
  title: string,
  tz: string,
): Promise<void> {
  if (reminders.length === 0) {
    const label = /\d/.test(title) ? `em ${title}` : title.toLowerCase();
    await reply(tenantId, phone, `Nada anotado ${label}.`);
    return;
  }
  const total = reminders.length;
  await reply(tenantId, phone, `*${title}* — ${total}:`);
  const shown = reminders.slice(0, LIST_SEND_CAP);
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const when = formatForOwner(new Date(r.next_fire_at), tz);
    const repeat = r.recurrence ? `\nRepete: ${describeRecurrence(r.recurrence)}` : '';
    const lead = r.lead_minutes ? `\nAviso: ${describeLead(r.lead_minutes)}` : '';
    await reply(tenantId, phone, `${i + 1}. ${r.task}\n${when}${repeat}${lead}`);
  }
  if (total > LIST_SEND_CAP) {
    await reply(tenantId, phone, `…e mais ${total - LIST_SEND_CAP}. Mande TODOS para a lista completa.`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Consulta por DATA específica: "dia 20", "20/12", "20/12/2026". Retorna o
 * intervalo daquele dia no fuso do dono, ou null se a frase tiver mais conteúdo
 * que a data (aí é cadastro, não consulta — ex.: "20/12 pagar fornecedor").
 */
function detectDateQuery(normalized: string, tz: string): { filter: ListRemindersFilter; title: string } | null {
  if (STRONG_CREATE.test(normalized)) return null;

  const slash = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const diaN = normalized.match(/\bdia\s+(\d{1,2})\b/);
  if (!slash && !diaN) return null;

  // Se, tirando a data e as palavras de ligação, sobrar texto, é um CADASTRO.
  const rest = normalized
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\bdia\s+\d{1,2}\b/g, ' ')
    .replace(/\b(no|na|em|o|a|que|tem|para|pra|dos?|das?|de|e|meus?|minha|compromissos?|lembretes?|agenda|tarefas?)\b/g, ' ')
    .replace(/[?!.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (rest.length > 0) return null;

  const wc = toWallClock(new Date(), tz);
  let day: number;
  let month: number;
  let year: number;
  if (slash) {
    day = Number(slash[1]);
    month = Number(slash[2]);
    const y = slash[3];
    year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : wc.year;
  } else {
    day = Number(diaN![1]);
    month = wc.month;
    year = wc.year;
    // "dia 20" já passou neste mês → assume o próximo mês.
    if (day < wc.day) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const from = fromWallClock({ year, month, day, hour: 0, minute: 0 }, tz);
  const until = fromWallClock({ year, month, day: day + 1, hour: 0, minute: 0 }, tz);
  return { filter: { from, until }, title: `${pad2(day)}/${pad2(month)}` };
}

const CREATE_TRIGGERS = /\b(lembr|anota|agenda|marca|avisa|nao me deixa esquecer|não me deixa esquecer)/i;

/**
 * A empresa cadastrou uma keyword de disparo (content_type='reminders_today') e
 * a mensagem do dono casa com ela? Zero IA — só leitura das keywords + match
 * normalizado. As de outros tipos são ignoradas aqui (são do fluxo de vendas).
 */
async function matchesReminderKeyword(
  tenantId: string,
  text: string,
  connectionId?: string | null,
): Promise<boolean> {
  const normalized = normalizeCommand(text);
  // Keywords tipo "Hoje"/"Amanhã" são gatilho CURTO de consulta. Sem este
  // filtro, "me lembra hoje às 15h de ligar" casa a keyword e lista a agenda
  // em vez de criar o lembrete (bug comum em áudio).
  if (STRONG_CREATE.test(normalized) || CREATE_TRIGGERS.test(text)) return false;
  if (looksLikeWebOrFactTask(normalized)) return false;
  if (normalized.split(/\s+/).filter(Boolean).length > 4) return false;

  const keywords = await getActiveKeywords(tenantId, connectionId);
  return keywords.some(
    (k) => k.content_type === 'reminders_today' && keywordMatches(text, k.keyword),
  );
}

/**
 * Trata a mensagem de um número da whitelist.
 * Retorna true quando assumiu a mensagem (o webhook então PARA e não cria
 * cliente/conversa nem aciona a IA de vendas).
 */
export async function handleOwnerMessage(
  tenantId: string,
  inbound: NormalizedInbound,
  connectionId?: string | null,
): Promise<boolean> {
  const phone = inbound.phone;
  const tz = DEFAULT_TZ;
  const key = stateKey(tenantId, phone);
  if (connectionId) ownerReplyConnection.set(key, connectionId);

  try {
    return await handleOwnerMessageInner(tenantId, inbound, phone, tz, connectionId);
  } finally {
    ownerReplyConnection.delete(key);
  }
}

async function handleOwnerMessageInner(
  tenantId: string,
  inbound: NormalizedInbound,
  phone: string,
  tz: string,
  connectionId?: string | null,
  opts?: { skipPersist?: boolean; skipCoalesce?: boolean; forcedText?: string },
): Promise<boolean> {
  if (!opts?.forcedText && alreadyHandled(inbound.providerMessageId)) {
    logger.info(`Lembretes: webhook repetido ignorado (${inbound.providerMessageId}).`);
    return true;
  }

  // Passo 0: texto, áudio (STT) ou imagem/vídeo (visão).
  let text: string | null = opts?.forcedText ?? null;
  let visionImages: ChatImage[] = [];

  if (!text) {
  if (inbound.type === 'text') {
    text = inbound.text;
  } else if (inbound.type === 'audio') {
    text = (inbound.text && inbound.text.trim()) || (await transcribeOwnerAudio(inbound));
    if (!text) {
      await reply(
        tenantId,
        phone,
        env.hasStt
          ? 'Recebi seu áudio, mas não consegui entender. Me manda por texto?'
          : 'Recebi seu áudio, mas a transcrição está desligada aqui. Me manda por texto?',
      );
      return true;
    }
    logger.info(`Lembretes: áudio do dono transcrito (${text.length} chars): "${text.slice(0, 120)}"`);
  } else if (inbound.type === 'image' || inbound.type === 'video') {
    visionImages = await buildOwnerVisionImages(inbound);
    const caption = (inbound.caption || inbound.text || '').trim();
    text =
      caption ||
      (inbound.type === 'video'
        ? 'O que você vê neste vídeo?'
        : 'O que você vê nesta imagem?');
    if (!visionImages.length) {
      await reply(
        tenantId,
        phone,
        'Recebi a mídia, mas não consegui abrir pra ver. Manda de novo ou descreve por texto?',
      );
      return true;
    }
    logger.info(
      `Secretária: ${inbound.type} do dono (${visionImages.length} quadro(s)) caption="${caption.slice(0, 80)}"`,
    );
  }
  }

  if (!text || !text.trim()) return true;

  const persistText =
    visionImages.length > 0
      ? `[${inbound.type === 'video' ? 'vídeo' : 'imagem'}] ${text}`
      : text;

  if (!opts?.skipPersist) {
    await persistOwnerUserMessage({
      tenantId,
      phone,
      content: persistText,
      connectionId,
      providerMessageId: inbound.providerMessageId,
    });
  }

  const normalized = normalize(text);
  const owner = getState(tenantId, phone);
  const stored = await getOwnerModeFlags(tenantId, connectionId);
  const listed = await isReminderOwner(tenantId, phone, connectionId);
  // Acesso livre: qualquer pessoa neste WhatsApp usa secretária + chat + busca.
  // Sem a alavanca, valem só os flags da conexão para quem está na whitelist.
  const flags = stored.openAccess
    ? { secretary: true, agent: true, webSearch: true, openAccess: true }
    : stored;

  // Foto/vídeo: a secretária/agente ENXERGA via visão (não cai no fluxo só-texto).
  if (visionImages.length > 0) {
    if (!flags.secretary && !flags.agent) {
      await reply(tenantId, phone, HELP_BOTH_OFF);
      return true;
    }
    const result = await freeChatOwner(tenantId, phone, text, {
      connectionId,
      webSearchEnabled: flags.webSearch,
      images: visionImages,
    });
    await reply(
      tenantId,
      phone,
      result.text ?? 'Recebi a foto, mas não consegui analisar agora. Manda de novo?',
      result.alreadyPersisted,
    );
    return true;
  }

  if (!opts?.skipCoalesce && !isHardImmediateOwnerTurn(text, owner)) {
    const ck = coalesceKey(tenantId, phone, connectionId);
    if (ownerCoalesce.has(ck) || isLikelyBrokenOwnerTurn(text)) {
      scheduleOwnerCoalesce({ tenantId, phone, connectionId, text, tz });
      return true;
    }
  }

  // 0.5. Escolha de contato pendente ("1", "2"…) depois de vários matches.
  // Relay só para número cadastrado — acesso livre não manda msg a contatos da empresa.
  if (owner.pendingRelay && listed) {
    const cand = pickRelayCandidate(owner.pendingRelay.candidates, text);
    if (cand) {
      const body = owner.pendingRelay.body;
      const contactQuery = owner.pendingRelay.contactQuery;
      setState(tenantId, phone, { pendingRelay: undefined });
      void rememberContactChoice({
        tenantId,
        ownerPhone: phone,
        query: contactQuery,
        clientId: cand.id,
        name: cand.name,
        phone: cand.phone,
        connectionId,
      });
      try {
        const sent = await sendOwnerRelay({
          tenantId,
          connectionId,
          clientId: cand.id,
          body,
        });
        if (sent.ok) {
          void recordOwnerEvent({
            tenantId,
            ownerPhone: phone,
            kind: 'acao',
            summary: `Enviei mensagem para ${sent.name}: "${body.slice(0, 160)}"`,
            connectionId,
            source: 'relay',
          });
        }
        await reply(
          tenantId,
          phone,
          sent.ok
            ? `Pronto — mandei pra *${sent.name}*: "${body}"`
            : `Não consegui enviar: ${sent.error}`,
        );
      } catch (err) {
        logger.warn('Secretária: falha no relay', err);
        await reply(tenantId, phone, 'Falhou o envio. Tenta de novo?');
      }
      return true;
    }
    if (/^\d{1,2}$/.test(normalized) || extractPhoneHint(text)) {
      await reply(tenantId, phone, 'Não achei esse na lista. Manda o número da lista ou o final do telefone.');
      return true;
    }
    if (isNegative(text)) {
      setState(tenantId, phone, { pendingRelay: undefined });
      await reply(tenantId, phone, 'Beleza, cancelei o envio.');
      return true;
    }
  }

  if (owner.pendingWatch && listed) {
    const cand = pickRelayCandidate(owner.pendingWatch.candidates, text);
    if (cand) {
      const pending = owner.pendingWatch;
      setState(tenantId, phone, { pendingWatch: undefined });
      void rememberContactChoice({
        tenantId,
        ownerPhone: phone,
        query: pending.contactQuery,
        clientId: cand.id,
        name: cand.name,
        phone: cand.phone,
        connectionId,
      });
      if (pending.action === 'cancel') {
        const done = await cancelWatchForContact({
          tenantId,
          ownerPhone: phone,
          clientId: cand.id,
          connectionId,
        });
        await reply(
          tenantId,
          phone,
          done.ok
            ? `OK — parei de te avisar quando *${done.name}* mandar mensagem.`
            : `Não tinha aviso ativo para *${done.name}*.`,
        );
        return true;
      }
      const created = await createWatchForContact({
        tenantId,
        ownerPhone: phone,
        clientId: cand.id,
        mode: pending.mode,
        connectionId,
      });
      await reply(
        tenantId,
        phone,
        created.mode === 'always'
          ? `OK — te aviso sempre que *${created.name}* mandar mensagem.`
          : `OK — te aviso quando *${created.name}* mandar a próxima mensagem.`,
      );
      return true;
    }
    if (/^\d{1,2}$/.test(normalized) || extractPhoneHint(text)) {
      await reply(
        tenantId,
        phone,
        'Não achei esse na lista. Manda o número da lista (1, 2…) ou o final do telefone.',
      );
      return true;
    }
    if (isNegative(text)) {
      setState(tenantId, phone, { pendingWatch: undefined });
      await reply(tenantId, phone, 'Beleza, cancelei o aviso.');
      return true;
    }
  }

  if (owner.pendingMute && listed) {
    const cand = pickRelayCandidate(owner.pendingMute.candidates, text);
    if (cand) {
      const enabled = owner.pendingMute.enabled;
      const contactQuery = owner.pendingMute.contactQuery;
      setState(tenantId, phone, { pendingMute: undefined });
      void rememberContactChoice({
        tenantId,
        ownerPhone: phone,
        query: contactQuery,
        clientId: cand.id,
        name: cand.name,
        phone: cand.phone,
        connectionId,
      });
      const done = await setContactAutoReply({
        tenantId,
        clientId: cand.id,
        enabled,
        ownerPhone: phone,
        connectionId,
      });
      await reply(
        tenantId,
        phone,
        enabled
          ? `OK — voltei a responder *${done.name}*.`
          : `OK — parei de responder *${done.name}*. Continuo te avisando se ela mandar mensagem. Manda _"volta a responder ${done.name}"_ pra eu falar de novo.`,
      );
      return true;
    }
    if (/^\d{1,2}$/.test(normalized) || extractPhoneHint(text)) {
      await reply(tenantId, phone, 'Não achei esse na lista. Manda o número da lista.');
      return true;
    }
    if (isNegative(text)) {
      setState(tenantId, phone, { pendingMute: undefined });
      await reply(tenantId, phone, 'Beleza, cancelei.');
      return true;
    }
  }

  // 1. Confirmação pendente tem prioridade sobre tudo.
  if (owner.pending) {
    const { items, source } = owner.pending;

    if (isAffirmative(text)) {
      const replyConnectionId = ownerReplyConnection.get(stateKey(tenantId, phone)) ?? null;
      const inputs: CreateReminderInput[] = items.map((p) => ({
        ownerPhone: phone,
        task: p.task,
        category: p.category,
        recurrence: p.recurrence,
        nextFireAt: p.nextFireAt,
        leadMinutes: p.leadMinutes,
        timezone: tz,
        connectionId: replyConnectionId,
      }));
      // Tudo-ou-nada: ou grava todos, ou nenhum (transação).
      await createRemindersBulk(tenantId, inputs);
      setState(tenantId, phone, { pending: undefined });
      for (const item of items) {
        void recordOwnerEvent({
          tenantId,
          ownerPhone: phone,
          kind: 'evento',
          summary: `Compromisso anotado: ${item.task} (${formatForOwner(item.nextFireAt, tz)})`,
          connectionId: replyConnectionId,
          occurredAt: item.nextFireAt,
          source: 'reminder',
        });
      }
      await reply(
        tenantId,
        phone,
        items.length === 1
          ? `Pronto, anotei. Te chamo ${formatForOwner(items[0].nextFireAt, tz)}.`
          : `Pronto, anotei os ${items.length}.`,
      );
      return true;
    }

    if (isNegative(text)) {
      setState(tenantId, phone, { pending: undefined });
      await reply(tenantId, phone, 'Beleza, descartei.');
      return true;
    }

    // Correção citando um NÚMERO ("2 na verdade às 16h"): reprocessa só aquele
    // item e mantém os demais. Só quando há vários pendentes.
    const numbered = normalized.match(/^(\d{1,2})\b/);
    if (numbered && items.length > 1) {
      const idx = Number(numbered[1]) - 1;
      if (idx >= 0 && idx < items.length) {
        const correction = text.replace(/^\s*\d{1,2}[).:\-]?\s*/, '').trim() || text;
        const reparsed = await parseReminders(tenantId, `${items[idx].task}\nCorreção: ${correction}`, tz, {
          ownerPhone: phone,
        });
        if (reparsed.length > 0) {
          const nextItems = items.slice();
          nextItems[idx] = toPendingItem(reparsed[0]);
          setState(tenantId, phone, { pending: { items: nextItems, source } });
          await reply(tenantId, phone, renderConfirmation(nextItems, tz));
        } else {
          await reply(tenantId, phone, 'Não consegui reprocessar esse item. Pode repetir dizendo a data?');
        }
        return true;
      }
    }

    // Qualquer outra coisa é uma CORREÇÃO geral: reprocessa somando o texto
    // original, para o dono poder dizer só "na verdade às 15h" (caso de 1 item).
    setState(tenantId, phone, { pending: undefined });
    const corrected = `${source}\nCorreção: ${text}`;
    return handleCreate(tenantId, phone, corrected, tz, text);
  }

  // 2. Consulta — palavra solta ou pergunta em linguagem natural. Sem IA.
  // Só com Secretária ligada (agenda).
  if (flags.secretary) {
  const queryKey = detectQuery(normalized);
  if (queryKey) {
    const filter = rangeFor(queryKey, tz);
    if (filter) {
      const reminders = await listReminders(tenantId, phone, filter);
      setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
      await sendReminderList(tenantId, phone, reminders, QUERY_TITLE[queryKey] ?? queryKey.toUpperCase(), tz);
      return true;
    }
  }

  // 2.1. Consulta por DATA específica ("dia 20", "20/12"). Sem IA.
  const dateQuery = detectDateQuery(normalized, tz);
  if (dateQuery) {
    const reminders = await listReminders(tenantId, phone, dateQuery.filter);
    setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
    await sendReminderList(tenantId, phone, reminders, dateQuery.title, tz);
    return true;
  }

  // 2.5. Disparo por palavra-chave CADASTRADA (content_type='reminders_today').
  // Zero IA: casa a frase que o dono cadastrou no painel e responde a lista de
  // hoje. Vive aqui de propósito — só roda para a whitelist —, com re-checagem
  // defensiva para o cliente jamais receber lembrete (isolamento máximo).
  if (await matchesReminderKeyword(tenantId, text, connectionId)) {
    if (listed) {
    const todays = await getTodayReminders(tenantId, phone);
    setState(tenantId, phone, { lastList: todays.map((r) => r.id) });
    await sendReminderList(tenantId, phone, todays, QUERY_TITLE.hoje, tz);
    return true;
    }
  }

  // 3. Gestão por índice da última lista.
  const manage = normalized.match(/^(concluir|conclui|feito|ok|cancelar|cancela|remover|apagar)\s+(\d{1,2})$/);
  if (manage) {
    const index = Number(manage[2]) - 1;
    const id = owner.lastList?.[index];
    if (!id) {
      await reply(tenantId, phone, 'Não achei esse número. Manda *HOJE* ou *TODOS* pra eu listar de novo.');
      return true;
    }
    const isDone = /^(concluir|conclui|feito|ok)$/.test(manage[1]);
    const ok = isDone
      ? await completeReminder(tenantId, phone, id)
      : await cancelReminder(tenantId, phone, id);
    await reply(
      tenantId,
      phone,
      ok
        ? isDone
          ? 'Marquei como concluído.'
          : 'Cancelado.'
        : 'Esse lembrete já não estava mais na lista.',
    );
    return true;
  }

  // 3.5. Varredura opcional de conversas (Parte 3): "VARRER 7 DIAS" /
  // "RECUPERAR COMPROMISSOS". OFF por padrão; sob demanda; propõe e só grava
  // com a confirmação em massa. Custa token só aqui.
  if (/^varrer\b/.test(normalized) || /recuperar\s+compromiss/.test(normalized)) {
    if (listed) {
    if (!(await isMemoryScanEnabled(tenantId, connectionId))) {
      await reply(
        tenantId,
        phone,
        'A varredura de conversas está desligada. Ligue em Lembretes → Recuperar compromissos nesta conexão e tente de novo.',
      );
      return true;
    }
    const daysMatch = normalized.match(/(\d{1,3})\s*dias?/);
    const days = daysMatch ? Number(daysMatch[1]) : 7;
    await reply(tenantId, phone, `Varrendo as conversas dos últimos ${days} dias... já te mostro o que encontrei.`);
    const candidates = await scanForCommitments(tenantId, { days });
    if (candidates.length === 0) {
      await reply(tenantId, phone, 'Não achei compromissos soltos nesse período.');
      return true;
    }
    const items = candidates.map(toPendingItem);
    setState(tenantId, phone, { pending: { items, source: `varredura ${days} dias` } });
    await reply(
      tenantId,
      phone,
      `Encontrei possíveis compromissos nas conversas:\n\n${renderConfirmation(items, tz)}`,
    );
    return true;
    }
  }
  } // flags.secretary

  if (normalized === 'ajuda' || normalized === 'menu' || normalized === '?') {
    await reply(
      tenantId,
      phone,
      flags.secretary ? HELP_TEXT : flags.agent ? HELP_AGENT_ONLY : HELP_BOTH_OFF,
    );
    return true;
  }

  // 3.7. Aviso quando um contato mandar mensagem.
  // "me avisa quando o Wender mandar mensagem" / "para de me avisar do Wender"
  if (listed) {
    const watch = parseWatchIntent(text);
    if (watch) {
      if (watch.action === 'list') {
        await reply(tenantId, phone, await formatWatchList(tenantId, phone, connectionId));
        return true;
      }
      if (watch.scope === 'all') {
        if (watch.action === 'cancel') {
          const ok = await cancelWatchForAnyone({
            tenantId,
            ownerPhone: phone,
            connectionId,
          });
          await reply(
            tenantId,
            phone,
            ok
              ? 'OK — parei de te avisar de qualquer pessoa. Avisos de um contato específico continuam, se tiver.'
              : 'Não tinha aviso de qualquer pessoa ativo.',
          );
          return true;
        }
        await createWatchForAnyone({ tenantId, ownerPhone: phone, connectionId });
        await reply(
          tenantId,
          phone,
          'OK — te aviso cada vez que alguém mandar mensagem neste WhatsApp, não importa quantas pessoas. Manda _"para de me avisar de todo mundo"_ pra parar.',
        );
        return true;
      }
      const resolved = await resolveWatchContact(
        tenantId,
        watch.contactQuery,
        connectionId,
        phone,
      );
      if (!resolved.ok) {
        if (resolved.candidates?.length) {
          setState(tenantId, phone, {
            pendingWatch: {
              action: watch.action,
              mode: watch.action === 'create' ? watch.mode : 'once',
              contactQuery: watch.contactQuery,
              candidates: resolved.candidates,
            },
          });
        }
        await reply(tenantId, phone, resolved.text);
        return true;
      }
      if (watch.action === 'cancel') {
        const done = await cancelWatchForContact({
          tenantId,
          ownerPhone: phone,
          clientId: resolved.id,
          connectionId,
        });
        await reply(
          tenantId,
          phone,
          done.ok
            ? `OK — parei de te avisar quando *${done.name}* mandar mensagem.`
            : `Não tinha aviso ativo para *${done.name}*.`,
        );
        return true;
      }
      const created = await createWatchForContact({
        tenantId,
        ownerPhone: phone,
        clientId: resolved.id,
        mode: watch.mode,
        connectionId,
      });
      await reply(
        tenantId,
        phone,
        created.mode === 'always'
          ? `OK — te aviso sempre que *${created.name}* mandar mensagem neste WhatsApp.`
          : `OK — te aviso quando *${created.name}* mandar a próxima mensagem. Depois o aviso sai sozinho.`,
      );
      return true;
    }
  }

  // 3.7b. Parar/voltar a responder um contato (aviso continua).
  if (listed) {
    const mute = parseReplyMuteIntent(text);
    if (mute) {
      const resolved = await resolveMuteContact(tenantId, mute.contactQuery, phone, connectionId);
      if (!resolved.ok) {
        if (resolved.candidates?.length) {
          setState(tenantId, phone, {
            pendingMute: {
              enabled: mute.action === 'unmute',
              contactQuery: mute.contactQuery,
              candidates: resolved.candidates,
            },
          });
        }
        await reply(tenantId, phone, resolved.text);
        return true;
      }
      const done = await setContactAutoReply({
        tenantId,
        clientId: resolved.id,
        enabled: mute.action === 'unmute',
        ownerPhone: phone,
        connectionId,
      });
      await reply(
        tenantId,
        phone,
        done.enabled
          ? `OK — voltei a responder *${done.name}*.`
          : `OK — parei de responder *${done.name}*. Continuo te avisando se mandar mensagem. Manda _"volta a responder ${done.name}"_ pra eu falar de novo.`,
      );
      return true;
    }
  }

  // 3.8. Mandar mensagem a contato da lista (secretária).
  // Ex.: "mande um boa noite para o wender agora"
  // Só número cadastrado — acesso livre não envia msg a contatos da empresa.
  if (flags.secretary && listed) {
    const relay = parseRelayIntent(text);
    if (relay) {
      const candidates = await resolveRelayContacts(
        tenantId,
        relay.contactQuery,
        connectionId,
        phone,
      );
      if (candidates.length === 0) {
        await reply(
          tenantId,
          phone,
          `Não achei *${relay.contactQuery}* nos contatos deste WhatsApp. ` +
            'O nome precisa estar na agenda (quem já conversou ou foi importado).',
        );
        return true;
      }
      if (candidates.length > 1) {
        setState(tenantId, phone, {
          pendingRelay: {
            body: relay.body,
            contactQuery: relay.contactQuery,
            candidates,
          },
        });
        const lines = candidates.map(
          (c, i) => `${i + 1}. ${displayName(c)} · ${c.phone}`,
        );
        await reply(
          tenantId,
          phone,
          `Achei mais de um:\n${lines.join('\n')}\n\nManda o *número* pra eu enviar, ou *não* pra cancelar.`,
        );
        return true;
      }
      try {
        const sent = await sendOwnerRelay({
          tenantId,
          connectionId,
          clientId: candidates[0].id,
          body: relay.body,
        });
        if (sent.ok) {
          void recordOwnerEvent({
            tenantId,
            ownerPhone: phone,
            kind: 'acao',
            summary: `Enviei mensagem para ${sent.name}: "${relay.body.slice(0, 160)}"`,
            connectionId,
            source: 'relay',
          });
        }
        await reply(
          tenantId,
          phone,
          sent.ok
            ? `Pronto — mandei pra *${sent.name}*: "${relay.body}"`
            : `Não consegui enviar: ${sent.error}`,
        );
      } catch (err) {
        logger.warn('Secretária: falha no relay', err);
        await reply(tenantId, phone, 'Falhou o envio. Tenta de novo?');
      }
      return true;
    }
  }

  // 4. Secretária: cadastro em linguagem natural (gatilho forte).
  const wantsReminder =
    CREATE_TRIGGERS.test(text) || STRONG_CREATE.test(normalized);
  if (wantsReminder && flags.secretary) {
    return handleCreate(tenantId, phone, text, tz, text);
  }
  if (wantsReminder && !flags.secretary) {
    await reply(
      tenantId,
      phone,
      'Pra anotar compromisso, ligue a *Secretária* em Lembretes → Secretária e Agente.',
    );
    return true;
  }

  // 5. Agente: chat livre. Cada msg entra na fila e é respondida na ordem.
  if (flags.agent) {
    const result = await freeChatOwner(tenantId, phone, text, {
      connectionId,
      webSearchEnabled: flags.webSearch,
    });
    await reply(
      tenantId,
      phone,
      result.text ?? 'Não rolou agora. Manda de novo em uma frase?',
      result.alreadyPersisted,
    );
    return true;
  }

  // 6. Só secretária (sem agente): tenta criar; senão menu.
  if (flags.secretary) {
    return handleCreate(tenantId, phone, text, tz, text);
  }

  await reply(tenantId, phone, HELP_BOTH_OFF);
  return true;
}

function toPendingItem(p: ParsedReminder): PendingItem {
  return {
    task: p.task,
    category: p.category,
    recurrence: p.recurrence,
    nextFireAt: p.nextFireAt,
    leadMinutes: p.leadMinutes,
    confirmationText: p.confirmationText,
  };
}

/** UMA confirmação, numerada quando há vários (Parte 1: massa). */
function renderConfirmation(items: PendingItem[], tz: string): string {
  if (items.length === 1) {
    return `${items[0].confirmationText}\n\nFecha assim? (*sim* ou me corrige)`;
  }
  const lines = items.map((it, i) => {
    const when = formatForOwner(it.nextFireAt, tz);
    const repeat = it.recurrence ? ` · repete ${describeRecurrence(it.recurrence)}` : '';
    const lead = it.leadMinutes ? ` · aviso ${describeLead(it.leadMinutes)}` : '';
    return `${i + 1}. ${it.task}\n   ${when}${repeat}${lead}`;
  });
  return [
    `Anotei ${items.length}:`,
    '',
    ...lines,
    '',
    'Manda *SIM* pra salvar todos, ou corrige pelo número (ex.: "2 na verdade às 16h").',
  ].join('\n');
}

async function handleCreate(
  tenantId: string,
  phone: string,
  message: string,
  tz: string,
  originalText: string,
): Promise<boolean> {
  const looksLikeReminder = CREATE_TRIGGERS.test(message);
  const parsed = await parseReminders(tenantId, message, tz, { ownerPhone: phone });

  if (parsed.length === 0) {
    // Sem gatilho claro E sem interpretação: provavelmente não era um lembrete.
    // Mesmo assim respondemos o menu — o dono nunca deve cair no fluxo de vendas.
    await reply(
      tenantId,
      phone,
      looksLikeReminder
        ? 'Peguei a ideia, mas não ficou clara a data. Manda de novo dizendo quando?'
        : HELP_TEXT,
    );
    return true;
  }

  // Frase aberta sobre algo JÁ no caderno — confirma sem duplicar no banco.
  const acks = parsed.filter((p) => p.action === 'acknowledge');
  const creates = parsed.filter((p) => p.action !== 'acknowledge');
  if (creates.length === 0 && acks.length > 0) {
    await reply(tenantId, phone, acks.map((a) => a.confirmationText).join('\n\n'));
    return true;
  }

  const items = creates.map(toPendingItem);
  setState(tenantId, phone, { pending: { items, source: originalText } });
  await reply(tenantId, phone, renderConfirmation(items, tz));
  return true;
}
