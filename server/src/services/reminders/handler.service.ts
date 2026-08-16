import { logger } from '../../config/logger';
import {
  cancelAllPendingReminders,
  cancelReminderById,
  completeReminderById,
  createRemindersBulk,
  createReminder,
  getReminderById,
  getTodayReminders,
  isReminderOwner,
  getReminderOwner,
  listReminders,
  listRemindersAboutContact,
  listPendingRemindersMatchingTokens,
  updateOwnerReminder,
  findSimilarPendingReminder,
  type CreateReminderInput,
  type ListRemindersFilter,
} from '../../db/queries/reminders';
import { getOwnerLastList, rememberOwnerLastList } from './owner-last-list';
import { inferFireAction, userAskedScheduledSearch, userAskedSearchLink, userAskedSearchNow, userAskedTimedNotebook, userAskedTranscript, extractDictationText, parseClockFromText, extractSearchQuery, extractNotebookTask } from './reminder-actions';
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
import { describeLead, describeRecurrence, expandReminderUpdates, foldReminderTask, inferDueAtFromText, loadOwnerAgenda, parseReminders, reminderDisplayText, type ParsedReminder } from './parse.service';
import { DEFAULT_TZ, formatForOwner, fromWallClock, toWallClock } from './time';
import {
  freeChatOwner,
  getOwnerModeFlags,
  persistOwnerAssistantReply,
  persistOwnerUserMessage,
  sanitizeOwnerAssistantReply,
} from '../owner-chat.service';
import { recordOwnerEvent } from '../owner-memory.service';
import { extractPhoneHint } from '../../utils/phone-hint';
import { listOwnerChatHistory, ownerChatHasProviderId } from '../../db/queries/owner_chat_messages';
import {
  buildHelpAiMessage,
  displayName,
  hasClearSendVerb,
  isHelpAiCommand,
  looksLikeConfirmOutbound,
  looksLikeSendToContact,
  parseListChoice,
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
import { applySecretaryPlaybookToText } from '../secretary-playbook.service';
import { isOnDuty, offDutyMessage } from './owner-schedule';

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
  'Transcreva o áudio em português do Brasil, fiel ao que a pessoa falou. ' +
  'Pode ser recado, pergunta, compromisso (hoje, amanhã, às 15h), ou pedido para transcrever. ' +
  'Não resuma; escreva as palavras ditas.';

/** Um lembrete já interpretado, aguardando confirmação. */
interface PendingItem {
  task: string;
  category: Reminder['category'];
  recurrence: string | null;
  nextFireAt: Date;
  leadMinutes: number | null;
  /** Frase de confirmação (com o tom da persona) para item único. */
  confirmationText: string;
  /** Se preenchido, o SIM faz UPDATE neste id em vez de INSERT. */
  existingId?: string;
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
  /** "Cancelar todos" aguardando SIM. */
  pendingCancelAll?: boolean;
  /**
   * A IA pediu "responde sim que eu salvo" sem chamar a tool.
   * O SIM seguinte grava o texto original no caderno de verdade.
   */
  pendingAgentSave?: { source: string };
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
  if (Object.prototype.hasOwnProperty.call(patch, 'lastList')) {
    rememberOwnerLastList(tenantId, phone, patch.lastList);
  }
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
  if (isFarewellTurn(text)) return true;
  if (owner.pendingRelay || owner.pendingWatch || owner.pendingMute) {
    if (/^\d{1,2}$/.test(n) || parseListChoice(text) != null || isAffirmative(text) || isNegative(text)) {
      return true;
    }
    if (extractPhoneHint(text)) return true;
  }
  if (owner.pending && (isAffirmative(text) || isNegative(text))) return true;
  if (owner.pendingAgentSave && (isAffirmative(text) || isNegative(text))) return true;
  if (n === 'ajuda' || n === 'menu' || n === '?') return true;
  if (isHelpAiCommand(text)) return true;
  if (/^(concluir|conclui|feito|ok|cancelar|cancela|remover|apagar)\s+\d{1,2}$/.test(n)) {
    return true;
  }
  if (detectCancelAll(n)) return true;
  if (detectCancelListed(n)) return true;
  if (userAskedSearchLink(n) || userAskedSearchLink(text)) return true;
  if (userAskedSearchNow(n) || userAskedSearchNow(text)) return true;
  if (userAskedTranscript(n) || userAskedTranscript(text)) return true;
  if (userAskedTimedNotebook(n) || userAskedTimedNotebook(text) || userAskedScheduledSearch(text)) {
    return true;
  }
  if (detectCancelByTask(n)) return true;
  if (owner.pendingCancelAll && (isAffirmative(text) || isNegative(text))) return true;
  if (detectQuery(n) && cmd.split(/\s+/).length <= 16) return true;
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
  text = await applySecretaryPlaybookToText({
    tenantId,
    connectionId,
    toPhone: phone,
    text,
  });
  text = sanitizeOwnerAssistantReply(text);
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
  const words = n.split(/\s+/).filter(Boolean);
  // Áudio curto: "Sim, pode." → "sim pode"
  if (words.length <= 3 && /^(sim|ok|isso)\b/.test(n)) return true;
  // "Sim, Paulo, tá certinho, meu querido…" — confirmação falada, não pedido novo.
  if (/^sim\b/.test(n) && words.length <= 16 && !/\b(nao|cancela|cancelar)\b/.test(n)) return true;
  return false;
}

function isNegative(text: string): boolean {
  const n = normalizeCommand(text);
  if (!n) return false;
  if (detectCancelAll(n)) return false;
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
  'Pra fechar: *CONCLUIR 2* · Pra tirar: *CANCELAR 2* · *CANCELAR TODOS*',
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
/**
 * Janela curta pedida na pergunta: "daqui a alguns minutos", "daqui a 10 min",
 * "na próxima hora", "o que vai tocar agora". Retorna os MINUTOS da janela.
 * Sem isto, "tem algo daqui a pouco?" devolvia o caderno inteiro.
 */
function shortWindowMinutes(normalized: string): number | null {
  const exatoMin = normalized.match(/\bdaqui\s+a\s+(\d{1,3})\s*(?:min|minuto|minutos)\b/);
  if (exatoMin) return Math.min(600, Number(exatoMin[1]) + 5);
  const exatoHora = normalized.match(/\bdaqui\s+a\s+(\d{1,2})\s*(?:h|hora|horas)\b/);
  if (exatoHora) return Math.min(720, Number(exatoHora[1]) * 60 + 10);
  if (/\bdaqui\s+a\s+(?:alguns?|uns|poucos?)\s+minutos?\b/.test(normalized)) return 60;
  if (/\bdaqui\s+a\s+pouco\b/.test(normalized)) return 60;
  if (/\b(?:nos\s+)?proximos\s+minutos\b/.test(normalized)) return 60;
  if (/\bna\s+proxima\s+meia\s+hora\b/.test(normalized)) return 30;
  if (/\b(?:na\s+)?proxima\s+hora\b|\bdaqui\s+a\s+(?:uma|1)\s+hora\b/.test(normalized)) return 60;
  if (/\b(?:ja\s+vai\s+tocar|vai\s+tocar\s+agora|esta\s+chegando|ta\s+chegando)\b/.test(normalized)) {
    return 60;
  }
  if (/\bagora\b/.test(normalized)) return 60;
  return null;
}

/** Título da consulta, inclusive das janelas curtas dinâmicas ("agora:60"). */
function queryTitle(keyword: string): string {
  const short = keyword.match(/^agora:(\d{1,4})$/);
  if (short) {
    const mins = Number(short[1]);
    if (mins < 60) return `PRÓXIMOS ${mins} MIN`;
    if (mins <= 65) return 'PRÓXIMA HORA';
    return `PRÓXIMAS ${Math.round(mins / 60)}H`;
  }
  return QUERY_TITLE[keyword] ?? keyword.toUpperCase();
}

function rangeFor(keyword: string, tz: string): ListRemindersFilter | null {
  const now = new Date();
  const short = keyword.match(/^agora:(\d{1,4})$/);
  if (short) {
    // Só o que ainda vai tocar dentro da janela (1 min de tolerância pra trás).
    return {
      from: new Date(now.getTime() - 60_000),
      until: new Date(now.getTime() + Number(short[1]) * 60_000),
    };
  }
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

/**
 * Despedida / cumprimento de encerramento. "até amanhã" NÃO é consulta da
 * agenda de amanhã — senão a keyword "amanhã" dispara a lista de HOJE.
 */
const FAREWELL_CHUNK =
  /\b(boa\s+noite|boa\s+tarde|bom\s+dia|boa\s+madrugada|ate\s+(amanha|logo|mais|ja|breve|depois)|tchau+|fui|flw|falou|abs|abraco|beijo|bj+|tenha\s+uma\s+boa\s+noite)\b/g;

function isFarewellTurn(text: string): boolean {
  const n = normalizeCommand(text);
  if (!n) return false;
  FAREWELL_CHUNK.lastIndex = 0;
  if (!FAREWELL_CHUNK.test(n)) return false;
  FAREWELL_CHUNK.lastIndex = 0;
  const leftover = n
    .replace(FAREWELL_CHUNK, ' ')
    .replace(/\b(oi|ola|opa|eai|e\s+ai|blz|beleza|valeu|obrigad[oa]|vlw|viu|entao|ah|ok|okay|sim)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return leftover.length === 0;
}

function farewellReply(text: string): string {
  const n = normalizeCommand(text);
  const night = /\bboa\s+noite\b/.test(n);
  const bye = /\bate\s+amanha\b/.test(n);
  if (night && bye) return 'Boa noite, até amanhã.';
  if (night) return 'Boa noite.';
  if (bye) return 'Até amanhã.';
  if (/\bbom\s+dia\b/.test(n)) return 'Bom dia.';
  if (/\bboa\s+tarde\b/.test(n)) return 'Boa tarde.';
  return 'Até mais.';
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
  /\b(o ?que|oque|quais|qual|quantos|quantas|tem algum|tem alguma|tem algo|tenho algum|tenho alguma|tenho algo|ha algum|ha alguma|ha algo|existe algum|existe alguma|existe|me (mostra|mostre|lista|liste|diga|fala|fale|passa)|como (esta|ta|fica))\b/;
const AGENDA_NOUNS = /\b(agenda|compromissos?|lembretes?|tarefas?|programacao|rolando|marcado)\b/;
const AGENDA_ASK_VERB = /\b(tem|ha|existe|quais|qual|quantos|quantas)\b/;
const AGENDA_CONTACT_STOP = new Set([
  'hoje',
  'amanha',
  'agora',
  'mim',
  'voce',
  'vc',
  'ele',
  'ela',
  'nos',
  'tarde',
  'noite',
  'manha',
  'semana',
  'mes',
  'contato',
  'cliente',
  'alguem',
  'todo',
  'todos',
  'tudo',
  'compromisso',
  'compromissos',
  'lembrete',
  'lembretes',
  'agenda',
  'tarefa',
  'tarefas',
  'meu',
  'minha',
  'meus',
  'minhas',
  'seu',
  'sua',
  'seus',
  'suas',
]);
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

/** Pedido de MUDAR horário/compromisso já anotado — não é cadastro novo nem consulta. */
const EDIT_TRIGGERS = new RegExp(
  [
    String.raw`\b(?:altera|muda|mudar|edita|editar|troca|trocar|adianta|reagenda|antecipa)\w*.{0,80}\b(?:horario|compromisso|lembrete|despert|alarme|acordar)`,
    String.raw`\b(?:horario|compromisso|lembrete|despert|alarme|acordar)\w*.{0,80}\b(?:altera|muda|mudar|edita|editar|troca|trocar|adianta|reagenda)`,
    String.raw`\b(?:coloca|passar|passe|ponha|bota|botar)\w*.{0,60}\b(?:madrugada|manha|despert)`,
    String.raw`\b(?:madrugada|manha).{0,50}\b(?:despert|horario|lembrar|lembre|compromisso)`,
  ].join('|'),
  'i',
);

/** Frases de busca/fato — não são consulta de agenda ("cotação do dólar hoje"). */
const WEB_OR_FACT_TASK =
  /\b(pesquis|busca|buscar|procure|procura|google|na internet|na web|cotac|dolar|dolar|euro|bitcoin|noticia|noticias|selic|ipca|clima|temperatura|preco do|preco da|quanto esta|quanto custa)\b/;

function looksLikeWebOrFactTask(normalized: string): boolean {
  return WEB_OR_FACT_TASK.test(normalized);
}

/** Pedido de ação — não é "me mostra a agenda". */
const AGENDA_ACTION =
  /\b(salva|salvar|anota|anotar|cancela|cancelar|apaga|apagar|remove|remover|exclui|excluir|manda|mandar|envia|enviar|edita|editar|altera|mudar|muda)\b/;
const SAVE_FOR_CONTACT =
  /\b(para|pra|pro|ao|a)\s+(o\s+|a\s+)?(meu\s+|minha\s+)?contato\b|\bcontato\s+(o\s+|a\s+)?\w+/;
const INCOMING_MEDIA_COMMITMENT =
  /\b(vou\s+te\s+mandar|te\s+mando|manda(r)?\s+(um\s+|uma\s+)?(audio|áudio|foto|imagem|video|vídeo))\b/;

function detectCancelAll(normalized: string): boolean {
  const n = normalizeCommand(normalized);
  if (!n) return false;
  if (/^(cancela|cancelar|apaga|apagar|remove|remover|exclui|excluir)\s+(todos|todas|tudo)$/.test(n)) {
    return true;
  }
  return (
    /\b(cancela|cancelar|apaga|apagar|remove|remover|exclui|excluir)\w*.{0,40}\b(todos|todas|tudo)\b/.test(n) &&
    /\b(compromissos?|lembretes?|agendamentos?|alarmes?|despert|agenda)\b/.test(n)
  );
}

/** Limpar o caderno de verdade e (opcional) criar de novo — qualquer pessoa neste WhatsApp. */
function detectResetCaderno(normalized: string): boolean {
  if (detectCancelAll(normalized)) return true;
  const n = normalizeCommand(normalized);
  if (
    /\b(limpa|limpar|zera|zerar|zero)\w*.{0,50}\b(caderno|lista|compromissos?|lembretes?|agendamentos?|tudo|agenda)\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /\b(comeca|comecar|criar|cria|refaz|refazer|grava|anota)\w*.{0,50}\b(de novo|denovo|novamente|limpo)\b/.test(n) &&
    /\b(compromissos?|lembretes?|caderno|lista|agenda|tarefas?)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

function resetHasNewTimes(normalized: string): boolean {
  return /\b(\d{1,2}\s*h|\d{1,2}:\d{2}|toda|todo|dia sim|12\s*(x|por|\/)\s*36)\b/.test(normalized);
}

function isAgendaComplaint(normalized: string): boolean {
  return (
    /\b(errado|errou|bagunc|nao (e|eh) isso|ta errado|esta errado|ja esta errado)\b/.test(normalized) &&
    /\b(compromissos?|lembretes?|agendamentos?|tarefas?|caderno|horario|ponto)\b/.test(normalized)
  );
}

/** "cancela o compromisso comprar camiseta às 23h" / "pode cancelar" / "cancele". */
const CANCEL_TASK_VERB =
  /\b(cancela|cancelar|cancele|apaga|apagar|apague|remove|remover|exclui|excluir|tira|tirar|risca|riscar|risque)\b/;
const CANCEL_TASK_VERB_ALL = new RegExp(CANCEL_TASK_VERB.source, 'g');
const LISTED_CANCEL_HINT = '__LISTED__';
const GENERIC_CANCEL_TOKENS = new Set([
  'estes',
  'essas',
  'esses',
  'este',
  'essa',
  'esse',
  'caderno',
  'lista',
  'repetir',
  'repetem',
  'risque',
  'tocar',
  'toquem',
  'mais',
]);

/** "cancele estes / risque do caderno / não repetir mais" — a lista da última consulta. */
function detectCancelListed(normalized: string): boolean {
  const n = normalizeCommand(normalized);
  if (!n || detectCancelAll(n)) return false;
  const stopRepeat =
    /\bnao\s+(quero\s+)?(mais\s+)?(que\s+)?(esses?|estas?|estes|essas|aqueles|aquelas)?\s*(compromissos?|lembretes?)?\s*(se\s+)?repet/.test(
      n,
    ) ||
    /\bpara\s+de\s+(repet|tocar)/.test(n) ||
    /\bnao\s+toquem?\s+mais/.test(n);
  if (!CANCEL_TASK_VERB.test(n) && !stopRepeat) return false;
  return (
    stopRepeat ||
    /\b(estes|essas|esses|aqueles|aquelas|esta lista|essa lista|da lista|do caderno|na lista)\b/.test(n) ||
    /\brisque\b/.test(n) ||
    /\brepet/.test(n)
  );
}

function looksLikeCancelConfirmAsk(text: string): boolean {
  const n = normalizeCommand(text);
  return (
    /\b(risco|riscar|risque|cancelo|cancelar|cancelei|apago|apagar)\b/.test(n) &&
    /\b(sim|confirma|confirmar|responda|responde)\b/.test(n)
  );
}

function detectCancelByTask(normalized: string): string | null {
  const n = normalizeCommand(normalized);
  if (!n || detectCancelAll(n) || detectCancelListed(n)) return null;
  if (/^(cancela|cancelar|apaga|apagar|remove|remover|exclui|excluir)\s+\d{1,2}$/.test(n)) {
    return null;
  }
  if (!CANCEL_TASK_VERB.test(n)) return null;
  const rest = n
    .replace(CANCEL_TASK_VERB_ALL, ' ')
    .replace(
      /\b(pode|quero|queria|preciso|favor|ok|ta|bom|sim|novo|copia|duplicada|duplicado|restante|restantes|mantenha|mantem|so|apenas|pra|para|me|que|e|este|esta|esse|essa|estes|essas|esses)\b/g,
      ' ',
    )
    .replace(/\b(o|a|os|as|de|da|do|das|dos)\b/g, ' ')
    .replace(/\b(compromisso|compromissos|lembrete|lembretes|alarme|alarmes|caderno|lista)\b/g, ' ')
    .replace(/\b\d{1,2}\s*h(?:oras?)?(?:\s+da\s+(manha|tarde|noite))?\b/g, ' ')
    .replace(/\b(hoje|amanha|as|noite|manha|tarde)\b/g, ' ')
    .replace(/\bcamiseta\b/g, 'camisa')
    .replace(/\s+/g, ' ')
    .trim();
  if (rest.length < 3) {
    if (/\b(compromissos?|lembretes?|caderno|lista|alarmes?)\b/.test(n)) return LISTED_CANCEL_HINT;
    return null;
  }
  return rest;
}

function wantsTranscript(normalized: string): boolean {
  return userAskedTranscript(normalized);
}

/** Não devolve a transcrição do áudio na resposta, a menos que peçam. */
function stripEchoedTranscript(reply: string, spoken: string): string {
  const src = spoken.replace(/^\[áudio\]\s*/i, '').replace(/^\[audio\]\s*/i, '').trim();
  if (src.length < 28) return reply;
  const lowReply = reply.toLowerCase();
  const lowSrc = src.toLowerCase();
  const idx = lowReply.indexOf(lowSrc);
  if (idx < 0) return reply;
  const cut = (reply.slice(0, idx) + reply.slice(idx + src.length)).replace(/\n{3,}/g, '\n\n').trim();
  return cut.length >= 8 ? cut : reply;
}

/**
 * Com o Agente ligado, frase longa/vários pedidos vão pra IA (ela grava o
 * caderno com tools e segue o resto). Comando curto (HOJE, CANCELAR TODOS)
 * continua na automação.
 */
function shouldDeferToAgent(text: string, normalized: string): boolean {
  if (
    wantsTranscript(normalized) ||
    INCOMING_MEDIA_COMMITMENT.test(normalized) ||
    SAVE_FOR_CONTACT.test(normalized)
  ) {
    return true;
  }
  if (
    /\b(e tambem|e também|alem disso|além disso|e pesquisa|e busca|e manda|e envia|e transcrev)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  const words = normalizeCommand(text).split(/\s+/).filter(Boolean).length;
  return words >= 10;
}

function detectQuery(normalized: string): string | null {
  if (isFarewellTurn(normalized)) return null;
  if (detectCancelAll(normalized)) return null;
  if (detectCancelListed(normalized)) return null;
  if (detectCancelByTask(normalized)) return null;

  // 1) Palavra solta, como sempre funcionou.
  const exact = QUERY_WORDS[normalized];
  if (exact) return exact;

  // "qual a cotação do dólar hoje" / "busca na internet..." → Agente, não agenda.
  if (looksLikeWebOrFactTask(normalized)) return null;

  // "salva este compromisso para o Wender?" / "vou te mandar um áudio" NÃO é lista.
  if (AGENDA_ACTION.test(normalized) || SAVE_FOR_CONTACT.test(normalized) || INCOMING_MEDIA_COMMITMENT.test(normalized)) {
    return null;
  }

  const asks = ASK_OPENERS.test(normalized);
  const mentionsAgenda = AGENDA_NOUNS.test(normalized);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  // Janela curta ("daqui a alguns minutos") ganha do escopo largo (hoje/semana):
  // o dono pediu o que está para tocar, não a agenda toda.
  const shortWin = shortWindowMinutes(normalized);
  const scope =
    shortWin != null
      ? `agora:${shortWin}`
      : (SCOPE_WORDS.find(([re]) => re.test(normalized))?.[1] ?? null);

  // "me lembra de pagar amanhã" é cadastro, mesmo citando um dia — a menos que
  // a frase seja explicitamente uma pergunta ("o que você tem pra me lembrar?").
  if (STRONG_CREATE.test(normalized) && !asks) return null;
  if (EDIT_TRIGGERS.test(normalized)) return null;

  // "tem algum compromisso para o Wender?" / "o Ender tem algo marcado?"
  const asksAgenda = asks || (mentionsAgenda && AGENDA_ASK_VERB.test(normalized));

  // Pergunta de agenda precisa pedir pra VER a lista — não basta ter a palavra
  // "compromisso" e um "?".
  const looksLikeQuery =
    (asksAgenda && mentionsAgenda) ||
    (asks && scope !== null && words <= 5 && mentionsAgenda) ||
    (mentionsAgenda && words <= 3) ||
    (asksAgenda && scope !== null && words <= 8 && /\b(temos|tem|rola|vai ter|tenho)\b/.test(normalized));
  if (!looksLikeQuery) return null;

  return scope ?? 'todos';
}

/** "para o Wender" / "da minha esposa" / "o Ender tem" — STT costuma escrever Ender. */
function extractAgendaContactHint(normalized: string): string | null {
  if (/\b(esposa|mulher|wife)\b/.test(normalized)) return 'esposa';
  if (/\b(marido|esposo|husband)\b/.test(normalized)) return 'marido';

  const skip = '(?:(?:o|a|os|as|um|uma|meu|minha|meus|minhas|seu|sua|seus|suas)\\s+)*';
  const patterns = [
    new RegExp(`\\b(?:para|pra|pro|pelo|pela)\\s+${skip}([a-z]{3,40})\\b`),
    new RegExp(`\\b(?:do|da|dos|das)\\s+${skip}([a-z]{3,40})\\b`),
    /\b(?:o|a)\s+([a-z]{3,40})\s+tem\b/,
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (!m?.[1]) continue;
    const name = m[1];
    if (AGENDA_CONTACT_STOP.has(name)) continue;
    return name;
  }
  return null;
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
    const upcoming = await listReminders(tenantId, phone, { statuses: ['pendente'], limit: 8 });
    if (upcoming.length) {
      await reply(
        tenantId,
        phone,
        `Nada anotado ${label}.\n\nPróximos no seu caderno:\n\n${formatReminderDetails(upcoming, tz)}`,
      );
      return;
    }
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
    await reply(tenantId, phone, `${i + 1}. ${reminderDisplayText(r)}\n${when}${repeat}${lead}`);
  }
  if (total > LIST_SEND_CAP) {
    await reply(tenantId, phone, `…e mais ${total - LIST_SEND_CAP}. Mande TODOS para a lista completa.`);
  }
}

/**
 * Caderno do dono, ou o recorte "para o contato X" (relay + caderno daquele
 * telefone). STT "Ender" casa com Wender via ILIKE.
 */
async function loadAgendaQueryReminders(input: {
  tenantId: string;
  phone: string;
  connectionId?: string | null;
  listed: boolean;
  normalized: string;
  filter: ListRemindersFilter;
}): Promise<{ reminders: Reminder[]; titleSuffix: string }> {
  const hint = extractAgendaContactHint(input.normalized);
  if (!hint || !input.listed) {
    const reminders = await listReminders(input.tenantId, input.phone, input.filter);
    return { reminders: dedupeReminders(reminders), titleSuffix: '' };
  }

  const matches = await resolveRelayContacts(
    input.tenantId,
    hint,
    input.connectionId,
    input.phone,
  );
  const picked = matches.length === 1 ? matches[0]! : null;
  const nameHints = [hint, ...matches.map((m) => m.name).filter((n): n is string => Boolean(n))];

  const reminders = await listRemindersAboutContact(input.tenantId, input.phone, {
    clientIds: matches.map((m) => m.id),
    contactPhones: matches.map((m) => m.phone),
    nameHints,
    filter: { ...input.filter, limit: input.filter.limit ?? 40 },
  });
  const label = picked ? displayName(picked) : hint;
  return { reminders: dedupeReminders(reminders), titleSuffix: label };
}

function dedupeReminders(rows: Reminder[]): Reminder[] {
  const seenId = new Set<string>();
  const seenKey = new Set<string>();
  const out: Reminder[] = [];
  for (const r of rows) {
    if (seenId.has(r.id)) continue;
    seenId.add(r.id);
    const when = new Date(r.next_fire_at).toISOString().slice(0, 16);
    const key = `${foldReminderTask(r.task)}|${when}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push(r);
  }
  return out;
}

function formatReminderDetails(reminders: Reminder[], tz: string): string {
  return reminders
    .map((r, i) => {
      const when = formatForOwner(new Date(r.next_fire_at), tz);
      const repeat = r.recurrence ? `\nRepete: ${describeRecurrence(r.recurrence)}` : '';
      const lead = r.lead_minutes ? `\nAviso: ${describeLead(r.lead_minutes)}` : '';
      return `${i + 1}. ${reminderDisplayText(r)}\n${when}${repeat}${lead}`;
    })
    .join('\n\n');
}

function isExactAgendaKeyword(normalized: string): boolean {
  return Boolean(QUERY_WORDS[normalized]);
}

function tokensForCancel(hint: string): string[] {
  return foldReminderTask(hint)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !['para', 'pra', 'com', 'uma', 'uns'].includes(t));
}

function matchRemindersForCancel(hint: string, reminders: Reminder[]): Reminder[] {
  const tokens = tokensForCancel(hint);
  if (!tokens.length) return [];
  const hits = reminders.filter((r) => {
    const task = foldReminderTask(r.task).replace(/\bcamiseta\b/g, 'camisa');
    return tokens.every((t) => task.includes(t));
  });
  return hits;
}

async function loadLastListReminders(tenantId: string, ids: string[] | undefined): Promise<Reminder[]> {
  if (!ids?.length) return [];
  const rows: Reminder[] = [];
  for (const id of ids) {
    const row = await getReminderById(tenantId, id);
    if (row && row.status === 'pendente') rows.push(row);
  }
  return rows;
}

async function handleTimedNotebook(input: {
  tenantId: string;
  phone: string;
  text: string;
  tz: string;
  connectionId?: string | null;
}): Promise<boolean> {
  if (!userAskedTimedNotebook(input.text)) return false;
  const now = new Date();
  const when =
    parseClockFromText(input.text, now, input.tz) ?? inferDueAtFromText(input.text, now, input.tz);
  if (!when) return false;
  const fireAction = inferFireAction(input.text);
  const query = fireAction === 'search' ? extractSearchQuery(input.text) : null;
  const task =
    fireAction === 'search'
      ? query
        ? `Pesquisar na internet: ${query}`
        : extractNotebookTask(input.text)
      : extractNotebookTask(input.text);
  const dup = await findSimilarPendingReminder(input.tenantId, input.phone, task, when);
  if (dup?.status === 'pendente') {
    rememberOwnerLastList(input.tenantId, input.phone, [dup.id]);
    await reply(
      input.tenantId,
      input.phone,
      fireAction === 'search'
        ? `Já estava no caderno. No horário eu pesquiso e te mando o resultado.\nTe chamo ${formatForOwner(new Date(dup.next_fire_at), dup.timezone || input.tz)}.`
        : `Já estava no caderno.\nTe chamo ${formatForOwner(new Date(dup.next_fire_at), dup.timezone || input.tz)}.`,
    );
    return true;
  }
  if (dup?.status === 'enviado') {
    await reply(
      input.tenantId,
      input.phone,
      fireAction === 'search'
        ? `Essa pesquisa acabou de sair (${formatForOwner(new Date(dup.next_fire_at), dup.timezone || input.tz)}). Se quiser de novo, manda outro horário.`
        : `Esse já tocou (${formatForOwner(new Date(dup.next_fire_at), dup.timezone || input.tz)}). Se quiser de novo, manda outro horário.`,
    );
    return true;
  }
  if (dup?.status === 'cancelado') {
    await reply(
      input.tenantId,
      input.phone,
      `Esse compromisso já tinha sido cancelado (${dup.task}). Não recriei.`,
    );
    return true;
  }
  const reminder = await createReminder(input.tenantId, {
    ownerPhone: input.phone,
    task,
    category: 'data_especifica',
    nextFireAt: when,
    timezone: input.tz,
    connectionId: input.connectionId,
    fireAction,
    searchQuery: query,
  });
  rememberOwnerLastList(input.tenantId, input.phone, [reminder.id]);
  logger.info(
    `Secretária: caderno gravado ${reminder.id} (${fireAction}) para ${when.toISOString()} (${input.phone})`,
  );
  const kind =
    fireAction === 'search'
      ? 'No horário eu pesquiso na internet e te mando o resultado.'
      : `Te chamo ${formatForOwner(when, input.tz)}.`;
  await reply(
    input.tenantId,
    input.phone,
    fireAction === 'search'
      ? `Pronto, anotei. ${kind}\nTe chamo ${formatForOwner(when, input.tz)}.`
      : `Pronto, anotei. ${kind}`,
  );
  return true;
}

function isDeicticCancelHint(hint: string): boolean {
  if (hint === LISTED_CANCEL_HINT) return true;
  const tokens = tokensForCancel(hint);
  return tokens.length === 0 || tokens.every((t) => GENERIC_CANCEL_TOKENS.has(t));
}

function matchRemindersNamedInText(text: string, reminders: Reminder[]): Reminder[] {
  const folded = foldReminderTask(text);
  if (!folded) return [];
  return reminders.filter((r) => {
    const t = foldReminderTask(r.task);
    return t.length >= 4 && folded.includes(t);
  });
}

async function cancelReminderRows(
  tenantId: string,
  phone: string,
  rows: Reminder[],
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (await cancelReminderById(tenantId, r.id)) n += 1;
  }
  setState(tenantId, phone, { lastList: undefined, pendingCancelAll: undefined });
  return n;
}

async function replyCancelledCount(tenantId: string, phone: string, n: number): Promise<void> {
  await reply(
    tenantId,
    phone,
    n === 0
      ? 'Não tinha nenhum desses pendente.'
      : n === 1
        ? 'Pronto, cancelei. Saiu da lista e não toca mais.'
        : `Pronto, cancelei os ${n}. Saíram da lista e não tocam mais.`,
  );
}

async function cancelListedOrRepeating(input: {
  tenantId: string;
  phone: string;
  lastList?: string[];
  sourceText: string;
}): Promise<boolean> {
  const ids = [...new Set([...(input.lastList ?? []), ...getOwnerLastList(input.tenantId, input.phone)])];
  const fromList = await loadLastListReminders(input.tenantId, ids);
  const own = await listReminders(input.tenantId, input.phone, { statuses: ['pendente'], limit: 80 });
  const named = matchRemindersNamedInText(input.sourceText, own);
  const repeating = own.filter((r) => Boolean(r.recurrence));
  const wantsRepeatStop = /\b(repet|nao toquem? mais|para de tocar)\b/.test(
    normalizeCommand(input.sourceText),
  );
  let targets: Reminder[];
  if (named.length) {
    targets = named;
  } else if (fromList.length) {
    targets = wantsRepeatStop ? fromList.filter((r) => Boolean(r.recurrence)) : fromList;
    if (!targets.length) targets = fromList;
  } else if (wantsRepeatStop && repeating.length) {
    targets = repeating;
  } else {
    targets = [];
  }
  if (!targets.length) {
    await reply(
      input.tenantId,
      input.phone,
      'Não achei esses na lista. Manda *HOJE* e depois *CANCELAR* com o número.',
    );
    return true;
  }
  const n = await cancelReminderRows(input.tenantId, input.phone, targets);
  await replyCancelledCount(input.tenantId, input.phone, n);
  return true;
}

async function cancelByTaskPhrase(input: {
  tenantId: string;
  phone: string;
  hint: string;
  lastList?: string[];
  listed: boolean;
  sourceText?: string;
}): Promise<boolean> {
  const fromList = await loadLastListReminders(input.tenantId, input.lastList);
  const own = await listReminders(input.tenantId, input.phone, { statuses: ['pendente'], limit: 80 });
  if (isDeicticCancelHint(input.hint)) {
    return cancelListedOrRepeating({
      tenantId: input.tenantId,
      phone: input.phone,
      lastList: input.lastList,
      sourceText: input.sourceText || input.hint,
    });
  }
  const tokens = tokensForCancel(input.hint);
  const matched = await listPendingRemindersMatchingTokens(input.tenantId, tokens, {
    ownerPhone: input.listed ? null : input.phone,
    limit: 30,
  });
  const pool = dedupeReminders([...fromList, ...own, ...matched]);
  const named = input.sourceText ? matchRemindersNamedInText(input.sourceText, pool) : [];
  const hits = matchRemindersForCancel(input.hint, pool);
  const targets = named.length > 1 ? named : hits;
  if (targets.length === 1) {
    const ok = await cancelReminderById(input.tenantId, targets[0]!.id);
    await reply(
      input.tenantId,
      input.phone,
      ok ? `Cancelei: ${targets[0]!.task}.` : 'Esse já não estava mais na lista.',
    );
    return true;
  }
  if (targets.length > 1 && named.length > 1) {
    const n = await cancelReminderRows(input.tenantId, input.phone, targets);
    await replyCancelledCount(input.tenantId, input.phone, n);
    return true;
  }
  if (hits.length > 1) {
    const lines = hits
      .map((r, i) => `${i + 1}. ${r.task}\n${formatForOwner(new Date(r.next_fire_at), r.timezone || DEFAULT_TZ)}`)
      .join('\n');
    setState(input.tenantId, input.phone, { lastList: hits.map((r) => r.id) });
    await reply(
      input.tenantId,
      input.phone,
      `Achei ${hits.length}:\n${lines}\n\nManda *CANCELAR* e o número (ex.: CANCELAR 1).`,
    );
    return true;
  }
  await reply(input.tenantId, input.phone, 'Não achei esse compromisso na lista. Manda *CANCELAR* e o número.');
  return true;
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
  if (EDIT_TRIGGERS.test(normalized)) return null;

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

/** Elogio/opinião ("gosto de lembretes", "adorei o caderno") — não é pedido. */
const OPINION_ABOUT_AGENDA =
  /\b(gosto|gostei|gostamos|adoro|adorei|amo|amei|curto|curti|prefiro|maravilhos|excelente|muito bom|otimo|parabens|obrigad|valeu)\b/i;

/** Comando explícito de cadastro — ganha da opinião ("gosto de acordar, me lembra às 6"). */
const EXPLICIT_CREATE_CMD =
  /\b(me lembr|lembra me|lembre me|lembra de|lembre de|anota|anote|marca|marque|agenda|agende|cria|criar|crie|coloca|colocar|bota|botar|adiciona|adicione)\b/i;

/** Tem hora/data na frase — sinal forte de compromisso de verdade. */
const HAS_TIME_HINT =
  /\b(\d{1,2}\s*(h|:)\s*\d{0,2}|hoje|amanha|amanhã|depois de amanha|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|semana|mes|mês|minuto|minutos|hora|horas|dia|dias|manha|manhã|tarde|noite|madrugada)\b/i;

/**
 * Fala é só opinião sobre a agenda, sem comando nem horário.
 * Sem isto, "gosto de lembretes" cai no cadastro (o stem `lembr` casa com
 * "lembretes") e o papo livre nunca chega na IA.
 */
function isOpinionNotRequest(normalized: string): boolean {
  if (!OPINION_ABOUT_AGENDA.test(normalized)) return false;
  if (EXPLICIT_CREATE_CMD.test(normalized)) return false;
  if (HAS_TIME_HINT.test(normalized)) return false;
  return true;
}

function wantsCadastro(text: string, normalized: string): boolean {
  if (isAgendaComplaint(normalized) || detectResetCaderno(normalized)) return false;
  if (isOpinionNotRequest(normalized)) return false;
  return (
    CREATE_TRIGGERS.test(text) ||
    STRONG_CREATE.test(normalized) ||
    EDIT_TRIGGERS.test(text) ||
    EDIT_TRIGGERS.test(normalized)
  );
}

function looksLikeReminderConfirmAsk(text: string): boolean {
  if (looksLikeCancelConfirmAsk(text)) return false;
  return /\b(fecha assim|responde\s+\*?sim|manda\s+\*?sim|confirma(?:r)?\s+que eu salvo)\b/i.test(
    text,
  );
}

/** Pedido só de compromisso (sem pesquisa/transcrição no mesmo turno). */
function isCadastroOnly(text: string, normalized: string): boolean {
  if (!wantsCadastro(text, normalized)) return false;
  if (wantsTranscript(normalized)) return false;
  if (SAVE_FOR_CONTACT.test(normalized) || INCOMING_MEDIA_COMMITMENT.test(normalized)) return false;
  if (
    /\b(e tambem|e também|alem disso|além disso|e pesquisa|e busca|e manda|e envia|e transcrev)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
}

async function recoverReminderCreateSource(
  tenantId: string,
  phone: string,
  connectionId?: string | null,
): Promise<string | null> {
  const hist = await listOwnerChatHistory(tenantId, phone, { connectionId, limit: 16 });
  const cutoff = Date.now() - STATE_TTL_MS;
  for (let i = hist.length - 1; i >= 1; i--) {
    const msg = hist[i]!;
    if (msg.role !== 'assistant') continue;
    if (!looksLikeReminderConfirmAsk(msg.content)) continue;
    if (new Date(msg.created_at).getTime() < cutoff) continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = hist[j]!;
      if (prev.role !== 'user') continue;
      const src = prev.content.replace(/^\[áudio\]\s*/i, '').trim();
      if (wantsCadastro(src, normalizeCommand(src))) return src;
      break;
    }
  }
  return null;
}

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
  if (isFarewellTurn(text)) return false;
  // Keywords tipo "Hoje"/"Amanhã" são gatilho CURTO de consulta. Sem este
  // filtro, "me lembra hoje às 15h de ligar" casa a keyword e lista a agenda
  // em vez de criar o lembrete (bug comum em áudio).
  if (STRONG_CREATE.test(normalized) || CREATE_TRIGGERS.test(text)) return false;
  if (looksLikeWebOrFactTask(normalized)) return false;
  if (normalized.split(/\s+/).filter(Boolean).length > 4) return false;

  const keywords = await getActiveKeywords(tenantId, connectionId);
  return keywords.some((k) => {
    if (k.content_type !== 'reminders_today') return false;
    const needle = normalizeCommand(k.keyword);
    if (!needle) return false;
    // "amanhã" sozinho lista amanhã; "até amanhã" é despedida — não casa.
    if (QUERY_WORDS[needle] || needle === 'amanha' || needle === 'hoje') {
      return normalized === needle || detectQuery(normalized) === QUERY_WORDS[needle];
    }
    return keywordMatches(text, k.keyword);
  });
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
  canonicalPhone?: string | null,
): Promise<boolean> {
  const phone = (canonicalPhone || inbound.phone).trim() || inbound.phone;
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
    const inThread = inbound.providerMessageId
      ? await ownerChatHasProviderId(tenantId, inbound.providerMessageId)
      : true;
    if (inThread) {
      logger.info(`Lembretes: webhook repetido ignorado (${inbound.providerMessageId}).`);
      return true;
    }
    logger.info(
      `Lembretes: id ${inbound.providerMessageId} já visto, mas o fio da secretária está vazio — segue.`,
    );
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
    inbound.type === 'audio'
      ? `[áudio] ${text}`
      : visionImages.length > 0
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
    logger.info(
      `Secretária: gravou no fio phone=${phone} id=${inbound.providerMessageId ?? 'sem-id'} (${persistText.slice(0, 80)})`,
    );
  }

  const ownerRow = await getReminderOwner(tenantId, phone, connectionId);
  if (
    ownerRow?.secretary_enabled &&
    ownerRow.schedule_enabled &&
    !isOnDuty(ownerRow.weekly_hours, new Date())
  ) {
    const msg = offDutyMessage(ownerRow.weekly_hours);
    logger.info(
      `Secretária fora do horário phone=${phone} connection=${connectionId ?? '-'} → ${msg}`,
    );
    await reply(tenantId, phone, msg);
    return true;
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

  if (userAskedTranscript(text) || userAskedTranscript(normalized)) {
    let spoken = inbound.type === 'audio' ? extractDictationText(text) : '';
    if (!spoken) {
      const hist = await listOwnerChatHistory(tenantId, phone, { connectionId, limit: 12 });
      const lastAudio = [...hist].reverse().find(
        (m) => m.role === 'user' && /^\[áudio\]/i.test(m.content || ''),
      );
      if (lastAudio?.content) spoken = extractDictationText(lastAudio.content);
    }
    if (spoken) {
      logger.info(`Secretária: transcrição pedida (${spoken.length} chars)`);
      await reply(tenantId, phone, spoken);
      return true;
    }
  }

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
      listedOwner: listed,
    });
    await reply(
      tenantId,
      phone,
      result.text ?? 'Recebi a foto, mas não consegui analisar agora. Manda de novo?',
      result.alreadyPersisted,
    );
    return true;
  }

  if (!opts?.skipCoalesce && isFarewellTurn(text)) {
    const ck = coalesceKey(tenantId, phone, connectionId);
    if (ownerCoalesce.has(ck)) await flushOwnerCoalesce(ck);
    await reply(tenantId, phone, farewellReply(text));
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
    // Confirmação de envio com contato ÚNICO (verbo fora da whitelist):
    // um "sim" claro autoriza; qualquer outra coisa NÃO envia.
    if (owner.pendingRelay.candidates.length === 1 && looksLikeConfirmOutbound(text)) {
      const only = owner.pendingRelay.candidates[0]!;
      const body = owner.pendingRelay.body;
      setState(tenantId, phone, { pendingRelay: undefined });
      try {
        const sent = await sendOwnerRelay({
          tenantId,
          connectionId,
          clientId: only.id,
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
        logger.warn('Secretária: falha no relay confirmado', err);
        await reply(tenantId, phone, 'Falhou o envio. Tenta de novo?');
      }
      return true;
    }

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
  if (owner.pendingCancelAll) {
    if (isAffirmative(text)) {
      const n = await cancelAllPendingReminders(tenantId, phone);
      setState(tenantId, phone, { pendingCancelAll: undefined, lastList: undefined });
      await reply(
        tenantId,
        phone,
        n === 0
          ? 'Não tinha nenhum pendente.'
          : n === 1
            ? 'Pronto, cancelei o compromisso. Não toca mais.'
            : `Pronto, cancelei os ${n}. Saíram da lista e não tocam mais.`,
      );
      return true;
    }
    if (isNegative(text)) {
      setState(tenantId, phone, { pendingCancelAll: undefined });
      await reply(tenantId, phone, 'Beleza, não cancelei nada.');
      return true;
    }
    setState(tenantId, phone, { pendingCancelAll: undefined });
  }

  if (owner.pending) {
    const { items, source } = owner.pending;

    if (isAffirmative(text)) {
      const saved = await commitPendingItems(tenantId, phone, items, tz);
      if (!saved.ok) {
        await reply(tenantId, phone, 'Não consegui gravar. Manda de novo o compromisso?');
        return true;
      }
      setState(tenantId, phone, { pending: undefined, pendingAgentSave: undefined });
      const onlyUpdates = saved.toUpdate > 0 && saved.toCreate === 0;
      await reply(
        tenantId,
        phone,
        onlyUpdates
          ? items.length === 1
            ? `Pronto, alterei. Te chamo ${formatForOwner(items[0].nextFireAt, tz)}.`
            : `Pronto, alterei os ${items.length}.`
          : items.length === 1
            ? `Pronto, anotei. Te chamo ${formatForOwner(items[0].nextFireAt, tz)}.`
            : `Pronto, anotei os ${items.length}.`,
      );
      return true;
    }

    if (isNegative(text)) {
      setState(tenantId, phone, { pending: undefined, pendingAgentSave: undefined });
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
          nextItems[idx] = {
            ...toPendingItem(reparsed[0]),
            existingId: items[idx].existingId,
          };
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

  // SIM depois da IA pedir "responde sim que eu salvo" sem gravar no caderno.
  // Se o pedido era para CANCELAR, o SIM cancela de verdade — não regrava.
  if (flags.secretary && isAffirmative(text) && !wantsCadastro(text, normalized)) {
    const hist = await listOwnerChatHistory(tenantId, phone, { connectionId, limit: 8 });
    const lastAsst = [...hist].reverse().find((m) => m.role === 'assistant');
    if (lastAsst && looksLikeCancelConfirmAsk(lastAsst.content)) {
      return cancelListedOrRepeating({
        tenantId,
        phone,
        lastList: owner.lastList,
        sourceText: lastAsst.content,
      });
    }
    const source =
      owner.pendingAgentSave?.source ??
      (await recoverReminderCreateSource(tenantId, phone, connectionId));
    if (source) {
      setState(tenantId, phone, { pendingAgentSave: undefined });
      return handleCreate(tenantId, phone, source, tz, source, { autoConfirm: true });
    }
  }
  if (owner.pendingAgentSave && isNegative(text)) {
    setState(tenantId, phone, { pendingAgentSave: undefined });
    await reply(tenantId, phone, 'Beleza, descartei.');
    return true;
  }

  // Frase longa / vários pedidos: a IA executa o caderno (tools) e o resto no
  // mesmo turno. Consulta/cancelamento de agenda (texto ou áudio) não vai pra IA.
  if (flags.secretary && detectCancelListed(normalized)) {
    return cancelListedOrRepeating({
      tenantId,
      phone,
      lastList: owner.lastList,
      sourceText: text,
    });
  }
  if (flags.secretary && userAskedTimedNotebook(text)) {
    const cadastro = wantsCadastro(text, normalized);
    if (!cadastro || userAskedScheduledSearch(text)) {
      const saved = await handleTimedNotebook({
        tenantId,
        phone,
        text,
        tz,
        connectionId,
      });
      if (saved) return true;
    }
  }
  const cancelHint = flags.secretary ? detectCancelByTask(normalized) : null;
  if (cancelHint) {
    return cancelByTaskPhrase({
      tenantId,
      phone,
      hint: cancelHint,
      lastList: owner.lastList,
      listed,
      sourceText: text,
    });
  }
  const agendaQueryKey = flags.secretary ? detectQuery(normalized) : null;
  const cadastroOnly = flags.secretary && isCadastroOnly(text, normalized);
  const earlyRelay = flags.secretary && listed ? parseRelayIntent(text) : null;
  const earlyReset = flags.secretary && detectResetCaderno(normalized);
  if (
    flags.agent &&
    !agendaQueryKey &&
    !cadastroOnly &&
    !earlyRelay &&
    !earlyReset &&
    (shouldDeferToAgent(text, normalized) || inbound.type === 'audio')
  ) {
    const forAgent = inbound.type === 'audio' ? `[áudio] ${text}` : text;
    const result = await freeChatOwner(tenantId, phone, forAgent, {
      connectionId,
      webSearchEnabled: flags.webSearch,
      listedOwner: listed,
    });
    if (result.text && looksLikeReminderConfirmAsk(result.text) && flags.secretary) {
      setState(tenantId, phone, {
        pendingAgentSave: { source: text.replace(/^\[áudio\]\s*/i, '').trim() },
      });
    }
    const agentText =
      inbound.type === 'audio' && result.text && !wantsTranscript(normalized)
        ? stripEchoedTranscript(result.text, text)
        : result.text;
    if (agentText || !flags.secretary || !detectQuery(normalized)) {
      await reply(
        tenantId,
        phone,
        agentText ?? 'Não rolou agora. Manda de novo em uma frase?',
        result.alreadyPersisted,
      );
      return true;
    }
  }

  // 2. Consulta — palavra solta ou pergunta em linguagem natural. Sem IA.
  // Só com Secretária ligada (agenda).
  if (flags.secretary) {
  if (detectResetCaderno(normalized) || detectCancelAll(normalized)) {
    const wiped = await cancelAllPendingReminders(tenantId, phone);
    setState(tenantId, phone, { pendingCancelAll: undefined, lastList: undefined });
    if (resetHasNewTimes(normalized) || inbound.type === 'audio' || shouldDeferToAgent(text, normalized)) {
      const forAgent = inbound.type === 'audio' ? `[áudio] ${text}` : text;
      const result = await freeChatOwner(tenantId, phone, forAgent, {
        connectionId,
        webSearchEnabled: flags.webSearch,
        listedOwner: listed,
      });
      await reply(
        tenantId,
        phone,
        result.text ??
          (wiped === 0
            ? 'Caderno já estava vazio. Manda os novos horários que eu gravo.'
            : 'Caderno limpo. Manda os novos horários que eu gravo.'),
        result.alreadyPersisted,
      );
      return true;
    }
    await reply(
      tenantId,
      phone,
      wiped === 0
        ? 'Caderno já estava vazio. Manda os novos que eu gravo.'
        : wiped === 1
          ? 'Pronto, limpei. Manda os novos que eu gravo.'
          : `Pronto, limpei os ${wiped}. Manda os novos que eu gravo.`,
    );
    return true;
  }

  const queryKey = detectQuery(normalized);
  if (queryKey) {
    const filter = rangeFor(queryKey, tz);
    if (filter) {
      const { reminders, titleSuffix } = await loadAgendaQueryReminders({
        tenantId,
        phone,
        connectionId,
        listed,
        normalized,
        filter,
      });
      setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
      if (isExactAgendaKeyword(normalized)) {
        const base = queryTitle(queryKey);
        await sendReminderList(tenantId, phone, reminders, base, tz);
      } else {
        if (reminders.length === 0) {
          const upcoming = await listReminders(tenantId, phone, {
            statuses: ['pendente'],
            limit: 8,
          });
          if (upcoming.length) {
            const periodLabel = titleSuffix || queryTitle(queryKey);
            await reply(
              tenantId,
              phone,
              `Nada em *${periodLabel}*.\n\nPróximos no seu caderno:\n\n${formatReminderDetails(upcoming, tz)}`,
            );
          } else {
            await reply(
              tenantId,
              phone,
              titleSuffix ? `Nada anotado para *${titleSuffix}*.` : 'Nada anotado.',
            );
          }
        } else {
          const head = titleSuffix ? `*${titleSuffix}*\n\n` : '';
          await reply(tenantId, phone, `${head}${formatReminderDetails(reminders, tz)}`);
        }
      }
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
    const queryKey = detectQuery(normalized) ?? 'hoje';
    const filter = rangeFor(queryKey, tz);
    const reminders = filter
      ? await listReminders(tenantId, phone, filter)
      : await getTodayReminders(tenantId, phone);
    setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
    await sendReminderList(
      tenantId,
      phone,
      reminders,
      queryTitle(queryKey),
      tz,
    );
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
      ? await completeReminderById(tenantId, id)
      : await cancelReminderById(tenantId, id);
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

  // "ajuda ia" — guia de envio (verbos diretos + travas). Vem antes do "ajuda".
  if (isHelpAiCommand(text)) {
    await reply(tenantId, phone, buildHelpAiMessage());
    return true;
  }

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
      // Trava (Fluxo C): sem verbo explícito da whitelist — ou com corpo em fala
      // indireta ("se ele está bem") — NÃO envia direto: pede UMA confirmação.
      if (!hasClearSendVerb(text) || relay.indirect) {
        const only = candidates[0]!;
        setState(tenantId, phone, {
          pendingRelay: {
            body: relay.body,
            contactQuery: relay.contactQuery,
            candidates: [only],
          },
        });
        await reply(
          tenantId,
          phone,
          `Confirma enviar pra *${displayName(only)}*?\n"${relay.body}"\n\nResponde *sim* pra eu mandar, ou *não* pra cancelar.`,
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
    !isAgendaComplaint(normalized) &&
    (CREATE_TRIGGERS.test(text) ||
      STRONG_CREATE.test(normalized) ||
      EDIT_TRIGGERS.test(text) ||
      EDIT_TRIGGERS.test(normalized));
  if (wantsReminder && flags.secretary && !looksLikeSendToContact(text)) {
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
      listedOwner: listed,
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
    existingId: p.existingId,
  };
}

async function commitPendingItems(
  tenantId: string,
  phone: string,
  items: PendingItem[],
  tz: string,
): Promise<{ ok: boolean; toUpdate: number; toCreate: number }> {
  const replyConnectionId = ownerReplyConnection.get(stateKey(tenantId, phone)) ?? null;
  const toUpdate = items.filter((p) => p.existingId);
  const toCreate = items.filter((p) => !p.existingId);
  for (const item of toUpdate) {
    const updated = await updateOwnerReminder(tenantId, phone, item.existingId!, {
      nextFireAt: item.nextFireAt,
      recurrence: item.recurrence,
      task: item.task,
      leadMinutes: item.leadMinutes,
    });
    if (!updated) {
      logger.warn(`Lembretes: update falhou para ${item.existingId} (${item.task})`);
    }
  }
  if (toCreate.length > 0) {
    const inputs: CreateReminderInput[] = [];
    for (const p of toCreate) {
      const dup = await findSimilarPendingReminder(tenantId, phone, p.task, p.nextFireAt);
      if (dup?.status === 'cancelado') {
        logger.info(`Lembretes: não recriei cancelado "${p.task}" (${dup.id})`);
        continue;
      }
      if (dup?.status === 'pendente') {
        logger.info(`Lembretes: já pendente "${p.task}" (${dup.id})`);
        continue;
      }
      const fireAction = inferFireAction(p.task);
      inputs.push({
        ownerPhone: phone,
        task: p.task,
        category: p.category,
        recurrence: p.recurrence,
        nextFireAt: p.nextFireAt,
        leadMinutes: p.leadMinutes,
        timezone: tz,
        connectionId: replyConnectionId,
        fireAction,
        searchQuery: fireAction === 'search' ? p.task : null,
      });
    }
    if (inputs.length > 0) {
      await createRemindersBulk(tenantId, inputs);
    }
  }
  for (const item of items) {
    void recordOwnerEvent({
      tenantId,
      ownerPhone: phone,
      kind: 'evento',
      summary: item.existingId
        ? `Compromisso alterado: ${item.task} (${formatForOwner(item.nextFireAt, tz)})`
        : `Compromisso anotado: ${item.task} (${formatForOwner(item.nextFireAt, tz)})`,
      connectionId: replyConnectionId,
      occurredAt: item.nextFireAt,
      source: 'reminder',
    });
  }
  return { ok: true, toUpdate: toUpdate.length, toCreate: toCreate.length };
}

/** UMA confirmação, numerada quando há vários (Parte 1: massa). */
function renderConfirmation(items: PendingItem[], tz: string): string {
  const updating = items.some((it) => it.existingId);
  if (items.length === 1) {
    const ask = updating
      ? 'Fecha a alteração? (*sim* ou me corrige)'
      : 'Fecha assim? (*sim* ou me corrige)';
    return `${items[0].confirmationText}\n\n${ask}`;
  }
  const lines = items.map((it, i) => {
    const when = formatForOwner(it.nextFireAt, tz);
    const repeat = it.recurrence ? ` · repete ${describeRecurrence(it.recurrence)}` : '';
    const lead = it.leadMinutes ? ` · aviso ${describeLead(it.leadMinutes)}` : '';
    return `${i + 1}. ${it.task}\n   ${when}${repeat}${lead}`;
  });
  const header = updating ? `Vou alterar ${items.length}:` : `Anotei ${items.length}:`;
  const footer = updating
    ? 'Manda *SIM* pra gravar as alterações, ou corrige pelo número (ex.: "2 na verdade às 16h").'
    : 'Manda *SIM* pra salvar todos, ou corrige pelo número (ex.: "2 na verdade às 16h").';
  return [header, '', ...lines, '', footer].join('\n');
}

async function handleCreate(
  tenantId: string,
  phone: string,
  message: string,
  tz: string,
  originalText: string,
  opts?: { autoConfirm?: boolean },
): Promise<boolean> {
  const looksLikeReminder = CREATE_TRIGGERS.test(message) || EDIT_TRIGGERS.test(message);
  const connectionId = ownerReplyConnection.get(stateKey(tenantId, phone)) ?? null;
  const looksLikeEdit = EDIT_TRIGGERS.test(message);
  let parsed = await parseReminders(tenantId, message, tz, {
    ownerPhone: phone,
    connectionId,
  });

  if (looksLikeEdit && parsed.length > 0) {
    const coerced = parsed.map((p) =>
      p.action === 'create' ? { ...p, action: 'update' as const } : p,
    );
    const agenda = await loadOwnerAgenda(tenantId, phone, tz);
    parsed = expandReminderUpdates(coerced, agenda, new Date(), tz);
  }

  if (parsed.length === 0) {
    await reply(
      tenantId,
      phone,
      looksLikeReminder
        ? EDIT_TRIGGERS.test(message)
          ? 'Não achei esse no caderno. Manda *HOJE* e o número do item pra eu alterar.'
          : 'Peguei a ideia, mas não ficou clara a data. Manda de novo dizendo quando?'
        : HELP_TEXT,
    );
    return true;
  }

  const acks = parsed.filter((p) => p.action === 'acknowledge');
  const updates = parsed.filter((p) => p.action === 'update');
  const creates = parsed.filter((p) => p.action === 'create');

  if (looksLikeEdit && creates.length === 0 && updates.length === 0 && acks.length > 0) {
    await reply(
      tenantId,
      phone,
      'Pra mudar o horário preciso do novo — tipo "muda o despertar pra 5h da manhã". Ou manda *HOJE* e o número do item.',
    );
    return true;
  }

  if (looksLikeEdit && creates.length === 0 && updates.length === 0 && acks.length > 0) {
    await reply(
      tenantId,
      phone,
      'Pra mudar o horário preciso do novo — tipo "muda o despertar pra 5h da manhã". Ou manda *HOJE* e o número do item.',
    );
    return true;
  }

  if (creates.length === 0 && updates.length === 0 && acks.length > 0) {
    await reply(tenantId, phone, acks.map((a) => a.confirmationText).join('\n\n'));
    return true;
  }

  const unmatched = updates.filter((u) => !u.existingId);
  const matchedUpdates = updates.filter((u) => u.existingId);
  if (creates.length === 0 && matchedUpdates.length === 0 && unmatched.length > 0) {
    await reply(
      tenantId,
      phone,
      'Não achei esse no caderno. Manda *HOJE* e o número do item pra eu alterar.',
    );
    return true;
  }

  const items = [...matchedUpdates, ...creates].map(toPendingItem);
  const auto =
    opts?.autoConfirm ||
    (creates.length === 1 && matchedUpdates.length === 0 && unmatched.length === 0 && !looksLikeEdit);
  if (auto) {
    const saved = await commitPendingItems(tenantId, phone, items, tz);
    if (!saved.ok) {
      await reply(tenantId, phone, 'Não consegui gravar. Manda de novo o compromisso?');
      return true;
    }
    setState(tenantId, phone, { pending: undefined, pendingAgentSave: undefined });
    const onlyUpdates = saved.toUpdate > 0 && saved.toCreate === 0;
    await reply(
      tenantId,
      phone,
      onlyUpdates
        ? items.length === 1
          ? `Pronto, alterei. Te chamo ${formatForOwner(items[0].nextFireAt, tz)}.`
          : `Pronto, alterei os ${items.length}.`
        : items.length === 1
          ? `Pronto, anotei. Te chamo ${formatForOwner(items[0].nextFireAt, tz)}.`
          : `Pronto, anotei os ${items.length}.`,
    );
    return true;
  }
  setState(tenantId, phone, { pending: { items, source: originalText }, pendingAgentSave: undefined });
  await reply(tenantId, phone, renderConfirmation(items, tz));
  return true;
}
