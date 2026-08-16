import { logger } from '../config/logger';
import { complete, hasVisionProvider } from './ai/orchestrator';
import {
  buildOwnerMemoryPromptBlock,
  scheduleOwnerMemoryExtract,
  recordOwnerEvent,
} from './owner-memory.service';
import { buildContactAliasPromptBlock } from './owner-contact-memory.service';
import {
  buildOwnerToolRegistry,
  isWebSearchToolAvailable,
  registryAsRequestFields,
} from './ai/tools';
import { searchWebDetailed } from './ai/tools/web-search';
import { extractLiveQuoteLine } from './ai/live-quotes';
import { formatLastSearchLink, searchAndAnswer } from './ai/search-summarize';
import type { ChatImage, ChatMessage } from './ai/types';
import { getReminderPersona, getSecretaryPlaybook } from '../db/queries/settings';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { getClientById } from '../db/queries/clients';
import {
  findOrCreateOpenConversation,
  getRecentMessagesForAI,
} from '../db/queries/conversations';
import {
  appendOwnerChatMessage,
  countOwnerChatMessages,
  listOwnerChatHistory,
} from '../db/queries/owner_chat_messages';
import { listReminders, listRemindersAboutContact, cancelReminderById, createReminder, findSimilarPendingReminder } from '../db/queries/reminders';
import { getOwnerLastList, rememberOwnerLastList } from './reminders/owner-last-list';
import { getOwnerLastSearch, rememberOwnerLastSearch } from './reminders/owner-last-search';
import {
  extractDictationText,
  extractNotebookTask,
  extractSearchQuery,
  inferFireAction,
  parseClockFromText,
  userAskedScheduledSearch,
  userAskedSearchLink,
  userAskedSearchNow,
  userAskedTimedNotebook,
  userAskedTranscript,
} from './reminders/reminder-actions';
import { inferDueAtFromText, loadOwnerAgenda, reminderDisplayText, formatCadernoItem } from './reminders/parse.service';
import { formatForOwner, DEFAULT_TZ, fromWallClock, toWallClock } from './reminders/time';
import { applySecretaryPlaybookToText, formatSecretaryPlaybook } from './secretary-playbook.service';
import {
  assistantClaimedContactSend,
  buildHelpAiMessage,
  displayName,
  hasClearSendVerb,
  isHelpAiCommand,
  looksLikeConfirmOutbound,
  looksLikeDenyOutbound,
  parseRelayIntent,
  resolveRelayContacts,
  sendOwnerRelay,
} from './owner-relay.service';
import {
  clearPendingPlan,
  getPendingPlan,
  pendingPlanKey,
  rememberPendingPlan,
  type PlannedSend,
} from './owner-pending';

/**
 * Modo Agente do dono: chat livre no WhatsApp.
 * Histórico no Postgres (tempo real) + caderno de eventos + fila por turno.
 */

/** Modo rápido: poucas tokens, resposta curta no WhatsApp. */
const FAST_MAX_TOKENS = 280;
const TOOLS_MAX_TOKENS = 2200;
const VISION_MAX_TOKENS = 500;
const FAST_TEMPERATURE = 0.2;
const HISTORY_LIMIT = 2000;

const CONTACT_QUERY_STOP = new Set([
  'hoje',
  'amanha',
  'ontem',
  'agora',
  'depois',
  'compromisso',
  'compromissos',
  'lembrete',
  'lembretes',
  'mensagem',
  'mensagens',
  'conversa',
  'historico',
  'secretario',
  'secretaria',
  'contato',
  'contatos',
  'cliente',
  'horario',
  'horarios',
  'porque',
  'voce',
  'voce',
  'algo',
  'isso',
  'aquilo',
]);

function contactQueriesFromOwnerText(text: string): string[] {
  const t = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const out: string[] = [];
  if (/\b(esposa|mulher|wife)\b/.test(t) || /💍/.test(text)) out.push('esposa');
  if (/\b(wender|ender)\b/.test(t)) out.push('wender');
  if (/\b(marido|esposo|husband)\b/.test(t)) out.push('marido');

  const prep = t.matchAll(
    /\b(?:para|pra|pro|pelo|pela|do|da|dos|das|com)\s+(?:o|a|os|as|um|uma|meu|minha)?\s*([a-z]{3,40})(?:\s+([a-z]{3,40}))?/g,
  );
  for (const m of prep) {
    const a = m[1] ?? '';
    const b = m[2] ?? '';
    if (a && !CONTACT_QUERY_STOP.has(a)) {
      out.push(b && !CONTACT_QUERY_STOP.has(b) ? `${a} ${b}` : a);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

async function lastInboundSnap(
  tenantId: string,
  clientId: string,
  phone: string,
  lid: string | null | undefined,
  connectionId?: string | null,
): Promise<{ at: number; text: string } | null> {
  const conversation = await findOrCreateOpenConversation(tenantId, clientId, connectionId ?? null);
  const phones = [...new Set([phone, lid].filter((p): p is string => Boolean(p?.trim())))];
  const [crm, ...threads] = await Promise.all([
    getRecentMessagesForAI(tenantId, conversation.id, 40, 0).catch(() => []),
    ...phones.map((p) =>
      listOwnerChatHistory(tenantId, p, { connectionId, limit: 40, offset: 0 }).catch(() => []),
    ),
  ]);
  let best: { at: number; text: string } | null = null;
  for (const m of crm) {
    if (m.direction !== 'inbound') continue;
    const text = (m.content || m.transcription || m.audio_transcription || '').trim();
    const at = Date.parse(m.sent_at) || 0;
    if (text && (!best || at >= best.at)) best = { at, text };
  }
  for (const row of threads.flat()) {
    if (row.role !== 'user') continue;
    const text = row.content.trim();
    const at = Date.parse(row.created_at) || 0;
    if (text && (!best || at >= best.at)) best = { at, text };
  }
  return best;
}

/** Verdades do CRM/caderno neste turno — a IA não pode reciclar "só Oi". */
async function buildLiveContactFactsBlock(
  tenantId: string,
  ownerPhone: string,
  connectionId: string | null | undefined,
  ownerLookback: string,
): Promise<string> {
  const queries = contactQueriesFromOwnerText(ownerLookback);
  if (!queries.length) return '';

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const q of queries) {
    const matches = await resolveRelayContacts(tenantId, q, connectionId, ownerPhone).catch(() => []);
    for (const c of matches.slice(0, 2)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const client = await getClientById(tenantId, c.id);
      const name = displayName(c);
      const snap = await lastInboundSnap(
        tenantId,
        c.id,
        c.phone,
        client?.whatsapp_lid,
        connectionId,
      );
      const lastLine = snap
        ? `última mensagem ${formatForOwner(new Date(snap.at), DEFAULT_TZ)}: "${snap.text.slice(0, 400).replace(/\s+/g, ' ')}"`
        : 'nenhuma mensagem inbound no banco';
      const [ownBook, about] = await Promise.all([
        listReminders(tenantId, c.phone, { statuses: ['pendente'], limit: 8 }).catch(() => []),
        listRemindersAboutContact(tenantId, ownerPhone, {
          clientId: c.id,
          contactPhone: c.phone,
          nameHints: [name],
          filter: { statuses: ['pendente'], limit: 8 },
        }).catch(() => []),
      ]);
      const book = [...ownBook, ...about].filter(
        (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
      );
      const bookLine = book.length
        ? book
            .slice(0, 6)
            .map((r) => formatCadernoItem(r, r.timezone || DEFAULT_TZ))
            .join('; ')
        : '(nenhum pendente)';
      lines.push(`- ${name} (${c.phone}): ${lastLine}`);
      lines.push(`  caderno: ${bookLine}`);
    }
  }
  if (!lines.length) return '';
  return [
    'FATOS DO BANCO NESTE TURNO (leiam AGORA — valem mais que memória e mais que o que você disse antes):',
    ...lines,
    'Proibido dizer que só chegou "Oi" ou que o compromisso não foi agendado se os fatos acima mostram texto/caderno. Se já está no caderno, confirme o que está gravado. Não peça o dono para repetir o texto da mensagem.',
  ].join('\n');
}

/** Caderno DESTA pessoa hoje (todos os status) — para "você me lembrou?", "anotou?". */
async function buildLiveOwnNotebookBlock(
  tenantId: string,
  phone: string,
): Promise<string> {
  const tz = DEFAULT_TZ;
  const wc = toWallClock(new Date(), tz);
  const startOfToday = fromWallClock({ ...wc, hour: 0, minute: 0 }, tz);
  const endOfToday = fromWallClock({ ...wc, day: wc.day + 1, hour: 0, minute: 0 }, tz);
  const rows = await listReminders(tenantId, phone, {
    from: startOfToday,
    until: endOfToday,
    statuses: ['pendente', 'enviado', 'cancelado', 'concluido'],
    limit: 24,
  }).catch(() => []);
  const lines = rows.length
    ? rows.map((r, i) => `${i + 1}. ${formatCadernoItem(r, r.timezone || tz)}`)
    : ['(nenhum item hoje — pendente, enviado, cancelado ou concluído)'];
  return [
    'CADERNO DESTA PESSOA HOJE (fato do banco, todos os status):',
    ...lines,
    'status=enviado + "tocou …" = o aviso SAIU no WhatsApp. Sem linha no caderno = NÃO estava gravado (dizer "Salvo" no chat não conta). Se perguntarem por que não lembrou, cite estes fatos e busque no histórico (buscar_no_historico) as falas do horário.',
  ].join('\n');
}

const OWNER_VISION_HINT =
  '\n\nATENÇÃO — O DONO ENVIOU IMAGEM/VÍDEO. Analise o que aparece na mídia e responda com base nisso. ' +
  'Descreva o que vê com clareza; se ele pediu opinião ou ação, use o que enxergou. Não diga que não consegue ver fotos.';

export interface FreeChatOptions {
  connectionId?: string | null;
  /** Busca web ligada nesta conexão. */
  webSearchEnabled?: boolean;
  /** Imagens/quadros para visão (anexados ao último turno user). */
  images?: ChatImage[];
  /** Fala atual do dono (pra emoji pedido nesta mensagem, etc.). */
  lastUserMessage?: string | null;
  /** Número na whitelist de lembretes. Sem isto, sem tools de contato. */
  listedOwner?: boolean;
}

export type FreeChatResult = {
  status: 'reply';
  text: string | null;
  /** Já gravado no histórico pela fila (não persistir de novo no handler). */
  alreadyPersisted?: boolean;
};

interface QueueJob {
  opts: FreeChatOptions;
  resolve: (r: FreeChatResult) => void;
}

interface OwnerQueue {
  jobs: QueueJob[];
  running: boolean;
}

const queues = new Map<string, OwnerQueue>();

function batchKey(tenantId: string, phone: string, connectionId?: string | null): string {
  return `${tenantId}:${phone}:${connectionId ?? ''}`;
}

function assistantClaimedSave(text: string): boolean {
  return /\b(anotei|salvei|agendei|marquei|cadastrei|te chamo)\b/i.test(text);
}

function assistantClaimedCancel(text: string): boolean {
  return /\b(risquei|riscado|riscados|cancelei|apaguei|sa[ií]ram da lista|n[aã]o tocam mais)\b/i.test(
    text,
  );
}

/**
 * A IA às vezes encena o próximo turno ("user[áudio] Ótimo…") na mesma bolha.
 * Corta a partir desse vazamento — o dono só deve ver a resposta deste pedido.
 */
export function sanitizeOwnerAssistantReply(text: string): string {
  const raw = text.trim();
  if (!raw) return raw;
  const cut = raw.search(
    /\n+\s*(?:user\s*\[|user\s*:|PESSOA\s*:|Dono\s*:|Human\s*:|assistant\s*:|VOCÊ\s*:)/i,
  );
  if (cut >= 20) {
    logger.info(`Secretária: cortei continuação inventada (${raw.length - cut} chars)`);
    return raw.slice(0, cut).trim();
  }
  return raw;
}

/** Pedido de MUDAR item existente ("remarque", "adia", "altera") — nunca cria novo. */
const EDIT_REQUEST =
  /\b(remarc|realoc|reagend|adia|adie|antecip|altera|altere|alterar|muda|mude|mudar|troca|troque|trocar|edita|edite|editar)\w*/i;

/** Fala sem tarefa de verdade: vocativo, pergunta sobre a agenda, confirmação solta. */
function taskLooksEmpty(task: string): boolean {
  const t = task.trim().replace(/[.!?]+$/g, '');
  if (t.length < 8) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  if (/^(paulo|secretari[oa]|ok|certo|beleza|isso|sim|nao|não)\b/i.test(t) && words.length <= 6) {
    return true;
  }
  // "qual é o compromisso mesmo", "temos compromisso para" — pergunta, não tarefa.
  if (/\b(qual|quais|que horas|quando|tem algum|temos|voce tem|você tem)\b/i.test(t)) return true;
  return false;
}

/** "tenta de novo", "busca outro link", "procura de novo" — repetir a ÚLTIMA busca. */
function looksLikeRetrySearch(text: string): boolean {
  const n = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (/\b(tenta|tente|tentar|busca|busque|procura|procure|pesquisa|pesquise)\b.{0,24}\b(de novo|denovo|novamente|outra vez)\b/.test(n)) {
    return true;
  }
  if (/\b(outro|outros)\s+(link|links|resultado|resultados|site)\b/.test(n)) return true;
  if (/^(tenta|tente)\s+(de novo|denovo|novamente|outra vez)/.test(n.trim())) return true;
  return false;
}

/** URL sem pontuação final grudada. */
function normalizeUrl(u: string): string {
  return u.replace(/[),.;:]+$/g, '').trim();
}

/**
 * Remove link que o modelo INVENTOU: só sobrevive URL que veio de verdade nos
 * resultados da busca. Sem isto, ele citava um vídeo e colava a URL de outro.
 */
function stripUnverifiedUrls(text: string, allowed: Set<string>): string {
  if (!allowed.size) return text;
  const found = text.match(/https?:\/\/[^\s<>()"']+/gi) ?? [];
  let out = text;
  let removed = 0;
  for (const raw of found) {
    if (allowed.has(normalizeUrl(raw))) continue;
    out = out.replace(raw, '').replace(/[ \t]{2,}/g, ' ');
    removed += 1;
  }
  if (!removed) return text;
  out = out
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/[:\-–]\s*$/g, '').trimEnd())
    .filter((l, i, arr) => l.trim() || (i > 0 && arr[i - 1]!.trim()))
    .join('\n')
    .trim();
  const first = [...allowed][0];
  if (first && !/https?:\/\//i.test(out)) out = `${out}\n\nLink verificado: ${first}`;
  logger.info(`Secretária: removi ${removed} link(s) não verificado(s) da resposta.`);
  return out;
}

function searchReplyLooksWeak(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/translate\.google|google\.com\/search\?/i.test(t)) return true;
  if (/n[aã]o (consigo|posso) pesquis|sem chave neste servidor/i.test(t)) return true;
  if (/\b(audio paulo|paulo pesquise|\[áudio\])/i.test(t)) return true;
  const urls = t.match(/https?:\/\/\S+/gi) ?? [];
  if (urls.length >= 4 && t.length > 900) return true;
  return false;
}

function buildLastSearchBlock(tenantId: string, phone: string): string {
  const last = getOwnerLastSearch(tenantId, phone);
  if (!last) return '';
  return [
    'ÚLTIMA BUSCA DESTA CONVERSA (fato desta sessão, ~30 min):',
    `assunto: ${last.query}`,
    last.answer ? `o que já foi respondido: ${last.answer}` : '',
    last.urls.length ? `fontes: ${last.urls.join(' | ')}` : '',
    'Se pedirem o link, "aquela pesquisa" ou continuação do mesmo assunto, use isto. Assunto novo = web_search de novo. Não invente URL.',
  ]
    .filter(Boolean)
    .join('\n');
}

function userAskedCancelNotebook(text: string): boolean {
  const n = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return (
    /\b(cancela|cancelar|cancele|apaga|apagar|apague|risca|riscar|risque)\b/.test(n) ||
    /\bnao\s+(quero\s+)?(mais\s+)?(que\s+)?(se\s+)?repet/.test(n)
  );
}

function buildFastSystem(
  persona: string | null | undefined,
  agendaLines: string[],
  memoryBlock: string,
  webSearchOn: boolean,
  toolSearchAvailable: boolean,
  contactToolsOn: boolean,
  playbookBlock: string,
  listedOwner: boolean,
): string {
  const parts = [
    listedOwner
      ? 'Você fala com o DONO no WhatsApp — como um assistente humano rápido (estilo Claude), não como robô.'
      : 'Você fala com alguém usando este WhatsApp (acesso livre) — como um assistente humano rápido, não como robô. Esta pessoa NÃO é o dono da agenda de contatos.',
    'Respostas CURTAS (WhatsApp): no máximo ~6 linhas no papo comum. EXCEÇÃO: se pedirem a agenda/compromissos, mostre o texto COMPLETO de cada item (todos os bullets, kg, cores) — nunca corte o final da lista.',
    'Nunca diga que é IA/bot. Não invente compromissos: agenda real está abaixo.',
    'Emojis: você conhece TODOS. Se pedirem "emoji de coração", mande ❤️. De foguete, 🚀. De gato, 🐱. Qualquer nome ou o próprio emoji colado. Se pedirem só o emoji, responda SÓ com ele — sem frase.',
    listedOwner
      ? 'Leitura completa: FATOS DO BANCO NESTE TURNO (se houver) > tools deste turno > caderno abaixo > memória interpretada > o que você disse antes. Memória e falas antigas suas sobre "só Oi" ou "não agendei" estão ERRADAS se os fatos mostrarem o contrário.'
      : 'Use só o histórico DESTA pessoa e o caderno DESTA pessoa. NUNCA liste, busque, envie, cite nem descreva contatos do WhatsApp do dono. Se pedirem para checar a PRÓPRIA conversa com você, use buscar_no_historico (sem contato) e cite as falas. Se pedirem a agenda de contatos do negócio, recuse em 1 linha.',
    'Interprete o sentido do que a pessoa diz — não dependa de palavras-chave; entenda contexto e continuidade. Raciocine com o que já sabe; não peça de novo o que já está na memória.',
    playbookBlock,
    'No WhatsApp a pessoa costuma quebrar o mesmo pedido em vários balões seguidos. Vários user seguidos sem a sua resposta no meio são UM pedido só — junte o sentido e execute uma vez. Não peça para repetir o que já está nesses balões.',
    'Responda SÓ este turno e PARE. NUNCA escreva "user[", "user:", "PESSOA:", "Dono:" nem invente a próxima fala. NUNCA continue o diálogo sozinho (não simule outro áudio/elogio depois de anotar).',
    'Se nesta mensagem (já juntada) houver VÁRIOS pedidos distintos (ex.: "me lembra amanhã às 9h e pesquisa o dólar"), faça TODOS; confirme cada um em 1 linha.',
    'Nunca ignore um pedido desta fala. Nunca misture com um pedido antigo já respondido.',
    'Se pedirem para anotar/lembrar algo com data, USE anotar_compromisso NESTE turno (grava no caderno e dispara sozinho no horário). quando=YYYY-MM-DDTHH:mm no ANO ATUAL (hoje está no caderno/agora — NUNCA 2025 se o ano é 2026). "um dia sim, um dia não" / "12x36" / "12 por 36" / "a cada 2 dias" = recorrencia every:2d. Plantão noturno 19h–7h = DOIS itens (entrada 19:00 e saída 07:00), each every:2d — NÃO invente segunda a sexta. NUNCA peça "responde sim" / "fecha assim" para gravar — a tool já grava. Só diga "Salvo" / "anotei" se a tool devolveu id=. Sem id=, o caderno NÃO gravou: chame a tool de novo, não finja. Depois de gravar, MOSTRE o que a tool devolveu (Criado / Alterado / Cancelado, horário, repetição e o SEU CADERNO desta pessoa). Nunca invente item que a tool não listou. Nunca misture com o caderno de outro número — listar_compromissos sem contato = só quem está falando. No mesmo turno pode fazer OUTRA tarefa — nunca deixe um pedido de lado.',
    'Se pedirem para PESQUISAR / buscar cotação / preço EM UM HORÁRIO ("quando for 14:49", "às 15h pesquisa o dólar"): anotar_compromisso acao=pesquisar consulta="..." quando=YYYY-MM-DDTHH:mm NESTE turno. NÃO use web_search agora. No horário o sistema PESQUISA DE VERDADE e manda o resultado. Sem id= da tool, NÃO está agendado.',
    'Fato atual agora (cotação, notícia, pesquisa): web_search neste turno — você interpreta o pedido. Sem resultado da tool, NÃO invente preço, cotação nem notícia.',
    'Se pedirem LIMPAR / ZERAR / APAGAR TUDO / CRIAR DE NOVO os compromissos: cancelar_compromissos todos=true NESTE turno (sem pedir sim) — o caderno some de verdade. Se já disseram os novos horários na mesma fala, anotar_compromisso cada um em seguida. Se disserem que está ERRADO: buscar_no_historico + ler_historico_comigo, ignore o caderno podre, cancele todos e recrie do que a PESSOA pediu (última correção ganha).',
    'Se pedirem para cancelar ESTES / a lista que você acabou de mostrar / risque do caderno / não repetir mais: cancelar_compromissos estes=true NESTE turno (sem pedir sim). Para um item: caderno_n. Sem a linha "OK — cancelei" da tool, o compromisso CONTINUA no banco e VAI disparar de novo — nunca diga que riscou sem essa linha.',
    'Se pedirem para MUDAR horário: use alterar_compromisso. Para cancelar um item: cancelar_compromissos caderno_n. Execute o cancelamento — NÃO recite a lista no lugar de cancelar. NÃO peça "responde sim" para cancelar.',
    'Se disser que VAI mandar áudio/foto de um compromisso, peça o arquivo e NÃO recite a lista da agenda.',
    'Áudio chega como "[áudio]" + transcrição já pronta. Se pedirem para TRANSCREVER: responda com esse texto (pode tirar "paulo transcreva este áudio"). NUNCA diga que não consegue transcrever, que só chega texto, ou que não tem o áudio. NUNCA pesquise no lugar de transcrever. Se NÃO pedirem para transcrever, não copie a transcrição na resposta. Pedido com horário + pesquisa NÃO é elogio: anote/execute, sem "que bom que deu certo".',
    'O caderno abaixo é o que ESTÁ pendente para disparo. O bloco CADERNO DESTA PESSOA HOJE traz também os que JÁ TOCARAM (enviado) e os cancelados. Confirmação de alarme: "Pronto, anotei. Te chamo hoje às 20:41" — use hoje/amanhã, não o dia da semana quando for hoje.',
    'O histórico desta conversa está no banco ao vivo. Abaixo vão as mensagens carregadas agora. Se pedirem para checar o que combinaram, se você lembrou/anotou/disparou, por que não avisou, ou achar uma fala: USE buscar_no_historico com o horário/nome/trecho — depois cite as falas. Não chute. Fio maior: ler_historico_comigo (offset) até cobrir TUDO.',
    listedOwner
      ? 'Se pedir para salvar um compromisso PARA um contato (ex.: Wender no WhatsApp), use agendar_mensagem_contato quando tiver horário e texto. Se ainda vai mandar o áudio, peça o áudio. Nunca recitar a lista de compromissos no lugar disso.'
      : '',
    contactToolsOn
      ? [
          'Você TEM acesso às conversas e aos contatos do WhatsApp business via tools:',
          'buscar_contato, ler_conversa_contato, listar_produtos, enviar_mensagem_contato, orientar_atendimento_contato, agendar_mensagem_contato, avisar_quando_contato_falar, responder_contato, ler_historico_comigo, buscar_no_historico, listar_compromissos.',
          'NUNCA diga que não tem acesso às conversas — você LÊ com ler_conversa_contato (limite+offset até o FIM do fio) e busca_no_historico (termo). FALA com enviar_mensagem_contato.',
          'Quando pedirem a última mensagem / o que o contato falou / se ela mandou algo / se já agendou / se você atendeu ou criou compromisso para alguém / a LISTA de lembretes dele: FATOS DO BANCO + ler_conversa_contato + buscar_no_historico (contato=nome) + listar_compromissos. A fonte da verdade do que LEMBRAR é o que a PESSOA pediu na conversa (última correção), não um caderno bagunçado. Se o caderno contradiz a conversa: cancelar_compromissos no caderno DESSA pessoa não existe — anotar_compromisso é só o caderno de quem está falando. Para o contato: leia o fio (ler_conversa_contato, que inclui o papo dele com você) e ENVIE a lista que ELE pediu (horários da conversa). Cite o texto. Só use anotar_compromisso no caderno do DONO se o dono pediu um compromisso PRA SI.',
          'Áudio e foto/vídeo do contato aparecem transcritos ou descritos em ler_conversa_contato. Trate esse texto como o que a pessoa FALOU ou MOSTROU — responda com a mesma precisão de quando o dono te manda áudio ou foto.',
          'Quando o dono quiser ser AVISADO que alguém falou com este WhatsApp, use avisar_quando_contato_falar — em QUALQUER formulação, não só a frase pronta. Exemplos que são o MESMO pedido: "me avisa quando o Wender mandar mensagem", "quando o Wender chamar", "se a Maria falar me avisa", "me chama quando o João mandar zap", "avisa se o Pedro aparecer". Extraia o NOME e chame a tool (todos=false). Se citar o FINAL do número ("Jurandir final 3934", "o do 3934"), passe nome COM os dígitos ("Jurandir 3934") e NÃO pergunte qual contato — escolha o telefone que TERMINA com esses dígitos. Se disser "sempre que o X…", modo always; senão always também, salvo se pedir só a próxima. todos=true SOMENTE se pedir de qualquer pessoa / alguém / todo mundo SEM citar um nome. NUNCA use todos=true se houver um contato específico. Para parar um nome: acao=cancelar + nome. Para parar o geral: acao=cancelar + todos=true. Lista: acao=listar.',
          'Quando o dono pedir PARA DE RESPONDER / não fala mais com / não atende X: use responder_contato acao=parar + nome. Isso NÃO cancela o aviso (avisar_quando_contato_falar). Voltar a responder: acao=voltar. NUNCA trate "para de responder a esposa" como cancelar aviso.',
          'Quando o dono pedir "converse com X", "fala com o Wender", "atende ele", "responde o cliente":',
          '1) buscar_contato (se precisar) 2) ler_conversa_contato 3) se o contato pediu busca/fato atual, use web_search AGORA',
          '4) montar resposta útil (com o resultado da busca, se houver) 5) enviar_mensagem_contato',
          '6) orientar_atendimento_contato com o objetivo do dono para a IA do negócio CONTINUAR nas próximas msgs do contato.',
          'Se o contato pediu pesquisa na internet: NÃO ignore — pesquise com web_search e mande o resultado pra ele.',
          'Fluxo venda: listar_produtos → ler_conversa se já houver fio → texto humano → enviar + orientar.',
          'Fluxo rotina: agendar_mensagem_contato com quando=YYYY-MM-DDTHH:mm e recorrencia se pedir. Compromisso da PRÓPRIA pessoa: anotar_compromisso.',
          'Se o nome JÁ ESTIVER em CONTATOS QUE O DONO JÁ ESCOLHEU, use esse client_id e NÃO pergunte qual é. Só mostre lista se o nome NÃO estiver na memória e não houver final de telefone. Se 1 contato claro OU o dono já deu o final do número, aja na hora.',
          'Confirme ao dono em 1–2 linhas o que leu. ENVIO: chamar a tool enviar_mensagem_contato é OBRIGATÓRIO e é o ÚNICO jeito de a mensagem existir — sem a tool, NADA sai. O sistema só decide QUANDO ela sai (na hora ou após o "sim" do dono); ele NÃO adivinha nem escreve por você. Nunca escreva "mandei"/"enviado"/"mensagem entregue" por conta própria.',
          'Pedido tipo "diga um boa noite", "se apresente", "manda pra ele", "pergunte pro NOME se...", "manda pro NOME perguntando...", "avise para o NOME", "fale para o NOME que...", "tente de novo" = chame enviar_mensagem_contato UMA vez por contato. O NOME é o contato; o resto é o recado — e VOCÊ escreve o recado como mensagem natural em 2ª pessoa, pronta pro contato ler. Ex.: dono diz "pergunte pro João se ele está bem da ressaca" → mensagem="Oi João! Tudo bem? Como você está da ressaca de ontem? 😄". NUNCA copie a fala do dono em 3ª pessoa ("se ele está bem"). NÃO anote compromisso.',
          'Se o dono não disser O QUE mandar (ex.: só "manda pro João"), PERGUNTE o que ele quer enviar — não invente recado e não diga que mandou.',
          'A tool responde "PLANEJADO — …": significa que ENTROU NA FILA e o sistema envia (pedindo confirmação ao dono se for o caso). NÃO chame a tool de novo pelo mesmo envio e NÃO diga que já mandou — quem avisa o dono do resultado é o sistema.',
          'Este WhatsApp é Z-API (aparelho comum). NÃO é a API Cloud da Meta. NÃO existe janela de 24 horas. NUNCA diga que a Meta bloqueou, que a janela fechou ou que o primeiro envio não pode sair. Se o dono disser que não apareceu no celular, chame a tool de novo — não invente trava.',
          'Contato só na AGENDA (ainda sem conversa no WhatsApp) é normal: buscar_contato pega o NÚMERO e enviar_mensagem_contato manda para esse número — o WhatsApp abre a conversa. Não recuse por "não tem chat".',
          'Se a tool devolver shadow ban / restrição temporária: NÃO tente de novo neste turno. Diga que o WhatsApp bloqueou o NÚMERO DA EMPRESA por um tempo, que insistir piora, e que o dono espere horas ou mande na mão pelo celular.',
        ].join(' ')
      : '',
    webSearchOn && toolSearchAvailable
      ? [
          'Você TEM web_search. Você é quem pensa: se a pessoa quer um fato que você não tem ao vivo (cotação, notícia, "quanto está", "o que aconteceu"), PESQUISE — mesmo que ela não tenha dito a palavra "pesquise".',
          'Horário futuro ("às 15h pesquisa o dólar"): NÃO busque agora — anotar_compromisso acao=pesquisar.',
          'Papo rotineiro, lembrete, opinião, contato: responda direto, sem buscar.',
          'Formule a query com inteligência (o assunto no fio). Follow-up "e o euro?" = nova busca do euro. "o link"/"a fonte" = use ÚLTIMA BUSCA abaixo, sem buscar a palavra link. Nunca cole transcrição, "paulo" ou "[áudio]".',
          'Leia os hits. Se forem fracos (tradutor, cupom, snippet velho), chame web_search de novo com query melhor. Cotação ao vivo na tool ganha de snippet.',
          'Responda com a SUA leitura: o fato pedido + 1 URL real da tool. Nunca invente número nem link.',
          'REGRA DE LINK: só existe URL que a tool devolveu, COPIADA caractere por caractere, e ela tem que ser do MESMO item que você está citando. Nunca monte URL de cabeça (nada de youtube.com/watch?v=... "parecido"), nunca reaproveite o link de um resultado para falar de outro. Se a tool não trouxe link daquele item, diga que não achou o link — o sistema apaga link não verificado.',
          'Se pedirem "tenta de novo", "busca outro link", "procura de novo": é a MESMA pergunta de antes — refaça a busca do assunto anterior com outra query. NUNCA pesquise as palavras "tente"/"de novo".',
        ].join(' ')
      : webSearchOn
        ? 'Busca na web está ligada na alavanca, mas a tool ainda não tem chave no servidor. Responda o que souber com cautela; NÃO peça API key.'
        : 'Busca na web está desligada. Se pedirem pesquisa, diga pra ligar a alavanca "Busca na web" em Lembretes.',
    persona?.trim()
      ? `Tom (se o dono PEDIR emoji nesta fala, mande o emoji pedido — você conhece todos; senão o TREINO manda):\n${persona.trim()}`
      : '',
    agendaLines.length
      ? `Caderno de compromissos (próximos dias):\n${agendaLines.join('\n')}`
      : 'Caderno de compromissos: (vazio por enquanto).',
    'NÃO recite a agenda em cumprimento ou despedida (bom dia, boa noite, até amanhã, tchau). Só liste compromissos se a pessoa PEDIR (hoje, amanhã, o que tenho, agenda). Despedida = 1 linha, sem cabeçalho HOJE e sem lista.',
    memoryBlock,
    playbookBlock,
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Junta user consecutivos no fim (várias msgs rápidas) num único turno. */
function historyToModelMessages(
  rows: Array<{ role: 'user' | 'assistant'; content: string }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    const content = row.content.trim().slice(0, 6000);
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === 'user' && row.role === 'user') {
      last.content = `${last.content}\n${content}`.slice(0, 12000);
      continue;
    }
    out.push({ role: row.role, content });
  }
  // Não cortar o fio: o banco tem tudo; o modelo lê o que foi carregado.
  while (out.length && out[out.length - 1]!.role !== 'user') out.pop();
  return out;
}

function attachImagesToLastUser(messages: ChatMessage[], images: ChatImage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      messages[i] = {
        ...messages[i]!,
        images: [...(messages[i]!.images ?? []), ...images],
      };
      return;
    }
  }
  messages.push({ role: 'user', content: 'O que você vê nesta imagem?', images });
}

/** Resumo do plano pedindo UMA confirmação (sim/não). Só o corpo literal aparece. */
function buildPlanConfirmation(sends: PlannedSend[]): string {
  const lines = sends.map((s, i) => {
    const when = s.fireAtMs ? formatForOwner(new Date(s.fireAtMs), DEFAULT_TZ) : 'agora';
    const body = s.body.replace(/\s+/g, ' ').slice(0, 140);
    return `${i + 1}. ${when} → ${s.name}: "${body}"`;
  });
  const n = sends.length;
  return [`Plano — ${n} envio${n > 1 ? 's' : ''}. Confirma? (sim / não)`, ...lines].join('\n');
}

/**
 * Executa um plano autorizado: imediato → sendOwnerRelay (owner_authorized);
 * com horário futuro → createReminder (dispara no gate por owner_authorized).
 * Nunca carrega texto do modelo — só o corpo literal de cada envio.
 */
async function executePlannedSends(
  tenantId: string,
  ownerPhone: string,
  connectionId: string | null | undefined,
  sends: PlannedSend[],
): Promise<string> {
  const nowSent: string[] = [];
  const scheduled: string[] = [];
  const failed: string[] = [];
  for (const s of sends) {
    const isFuture = typeof s.fireAtMs === 'number' && s.fireAtMs > Date.now() + 30_000;
    if (isFuture) {
      try {
        await createReminder(tenantId, {
          ownerPhone,
          task: `Enviar p/ ${s.name}: ${s.body}`,
          category: 'data_especifica',
          nextFireAt: new Date(s.fireAtMs!),
          timezone: DEFAULT_TZ,
          connectionId,
          targetClientId: s.clientId,
          relayBody: s.body,
        });
        scheduled.push(`*${s.name}* (${formatForOwner(new Date(s.fireAtMs!), DEFAULT_TZ)})`);
      } catch (err) {
        logger.warn('Secretária: falha ao agendar envio do plano', err);
        failed.push(s.name);
      }
      continue;
    }
    const sent = await sendOwnerRelay({ tenantId, connectionId, clientId: s.clientId, body: s.body });
    if (sent.ok) {
      void recordOwnerEvent({
        tenantId,
        ownerPhone,
        kind: 'acao',
        summary: `Enviei mensagem para ${sent.name}: "${s.body.slice(0, 160)}"`,
        connectionId,
        source: 'relay',
      });
      nowSent.push(`*${sent.name}*`);
    } else {
      failed.push(`${s.name} (${sent.error})`);
    }
  }
  const parts: string[] = [];
  if (nowSent.length) parts.push(`Pronto — mandei pra ${nowSent.join(', ')}.`);
  if (scheduled.length) parts.push(`Agendei pra ${scheduled.join(', ')}.`);
  if (failed.length) parts.push(`Não consegui: ${failed.join('; ')}.`);
  return parts.join('\n') || 'Não havia nada pra enviar.';
}

async function runFreeChatOnce(
  tenantId: string,
  phone: string,
  opts: FreeChatOptions,
): Promise<string | null> {
  const tz = DEFAULT_TZ;

  // "ajuda ia" — resposta automática (sem gastar IA), listando os verbos que
  // enviam direto e as travas. Vem antes de tudo pra nunca virar confirmação.
  if (isHelpAiCommand(opts.lastUserMessage ?? '')) {
    logger.info('Secretária: comando "ajuda ia" — devolvi o guia de envio.');
    return buildHelpAiMessage();
  }

  // Confirmação de plano pendente — determinística, ANTES de chamar o modelo.
  // Evita envio duplo e um "sim" antigo disparando algo solto depois.
  if (opts.listedOwner !== false) {
    const planKey = pendingPlanKey(tenantId, phone, opts.connectionId);
    const pending = getPendingPlan(planKey);
    if (pending) {
      const said = (opts.lastUserMessage ?? '').trim();
      if (looksLikeConfirmOutbound(said)) {
        clearPendingPlan(planKey);
        logger.info('Secretária: plano confirmado pelo dono — executo sem chamar o modelo.');
        return executePlannedSends(tenantId, phone, opts.connectionId, pending);
      }
      if (looksLikeDenyOutbound(said)) {
        clearPendingPlan(planKey);
        return 'Ok, cancelei o envio.';
      }
      // Fala não é confirm/deny clara → abandona o plano e segue fluxo normal.
      clearPendingPlan(planKey);
    }
  }
  const persona = await getReminderPersona(tenantId, opts.connectionId);
  const playbookBlock = formatSecretaryPlaybook(
    await getSecretaryPlaybook(tenantId, opts.connectionId),
    phone,
    null,
    opts.lastUserMessage,
  );
  const agenda = await loadOwnerAgenda(tenantId, phone, tz);
  const agendaLines = agenda.slice(0, 12).map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
    return `${i + 1}. ${reminderDisplayText(r)} — ${when}`;
  });

  const hasImages = Boolean(opts.images?.length);
  const listedOwner = opts.listedOwner !== false;
  if (hasImages && !(await hasVisionProvider(tenantId, opts.connectionId))) {
    return 'Recebi a foto, mas nenhuma IA com visão está ligada agora. Me descreve o que tem nela?';
  }

  const [dbRows, memoryBlock, aliasBlock, historyTotal, ownNotebook] = await Promise.all([
    listOwnerChatHistory(tenantId, phone, {
      connectionId: opts.connectionId,
      limit: HISTORY_LIMIT,
    }),
    buildOwnerMemoryPromptBlock(tenantId, phone, opts.connectionId),
    listedOwner
      ? buildContactAliasPromptBlock(tenantId, phone, opts.connectionId)
      : Promise.resolve(''),
    countOwnerChatMessages(tenantId, phone, opts.connectionId),
    buildLiveOwnNotebookBlock(tenantId, phone),
  ]);
  const historyNote =
    historyTotal > dbRows.length
      ? `Histórico comigo no banco: ${historyTotal} mensagens. Carregadas neste turno: as ${dbRows.length} mais recentes. Use ler_historico_comigo com offset=${dbRows.length} para as mais antigas até o começo — pediram acesso a TODAS.`
      : `Histórico comigo no banco: ${historyTotal} mensagens (todas neste turno).`;
  const lookback = [
    opts.lastUserMessage ?? '',
    ...dbRows
      .filter((r) => r.role === 'user')
      .slice(-8)
      .map((r) => r.content),
  ].join('\n');
  const liveFacts = listedOwner
    ? await buildLiveContactFactsBlock(tenantId, phone, opts.connectionId, lookback)
    : '';
  const lastSearchBlock = buildLastSearchBlock(tenantId, phone);
  const contextBlock = [ownNotebook, liveFacts, lastSearchBlock, historyNote, memoryBlock, aliasBlock]
    .filter(Boolean)
    .join('\n\n');
  const messages = historyToModelMessages(
    dbRows.map((r) => ({ role: r.role, content: r.content })),
  );

  if (!messages.length) {
    logger.warn('Agente: histórico vazio — nada para responder.');
    return null;
  }

  if (hasImages && opts.images?.length) {
    attachImagesToLastUser(messages, opts.images);
  }

  // Tools: caderno sempre (anotar/alterar/cancelar). Contatos só para número cadastrado, sem imagem.
  const webSearchOn = Boolean(opts.webSearchEnabled);
  const toolSearchAvailable = webSearchOn && isWebSearchToolAvailable() && !hasImages;
  const contactToolsOn = !hasImages && listedOwner;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  // Coletor do plano de envio deste turno (Fluxo C). enviar/agendar acumulam aqui.
  const plannedSends: PlannedSend[] = [];
  const ownerTools = registryAsRequestFields(
    buildOwnerToolRegistry(
      {
        tenantId,
        ownerPhone: phone,
        connectionId: opts.connectionId,
        lastUserMessage: typeof lastUser?.content === 'string' ? lastUser.content : null,
        plan: { sends: plannedSends },
      },
      { contacts: contactToolsOn },
    ),
  );

  const toolExecutors = { ...ownerTools.toolExecutors };
  let cancelOk = false;
  let saveOk = false;
  let searchOk = false;
  let editOk = false;
  // URLs que REALMENTE vieram da busca neste turno — só elas podem sair na resposta.
  const verifiedUrls = new Set<string>();
  const origCancelar = toolExecutors.cancelar_compromissos;
  if (origCancelar) {
    toolExecutors.cancelar_compromissos = async (input: unknown) => {
      const out = await origCancelar(input);
      if (typeof out === 'string' && /^OK — cancelei/i.test(out)) cancelOk = true;
      return out;
    };
  }
  const origAnotar = toolExecutors.anotar_compromisso;
  if (origAnotar) {
    toolExecutors.anotar_compromisso = async (input: unknown) => {
      const out = await origAnotar(input);
      if (typeof out === 'string' && (/^OK — salvo/i.test(out) || /j[aá] estava no caderno/i.test(out))) {
        saveOk = true;
      }
      return out;
    };
  }
  const origAlterar = toolExecutors.alterar_compromisso;
  if (origAlterar) {
    toolExecutors.alterar_compromisso = async (input: unknown) => {
      const out = await origAlterar(input);
      if (typeof out === 'string' && /^OK — alterei/i.test(out)) editOk = true;
      return out;
    };
  }
  if (toolSearchAvailable) {
    toolExecutors.web_search = async (input: unknown) => {
      let raw =
        input && typeof input === 'object' && 'query' in input
          ? String((input as { query: unknown }).query ?? '').trim()
          : '';
      // "tenta de novo" / "busca outro link" = REPETIR a busca anterior, não
      // pesquisar a palavra "tente". Sem isto ele buscava "tente" na Wikipedia.
      if (looksLikeRetrySearch(raw)) {
        const prev = getOwnerLastSearch(tenantId, phone);
        if (prev?.query) {
          logger.info(`Secretária: "tenta de novo" → repito a busca anterior ("${prev.query.slice(0, 60)}")`);
          raw = prev.query;
        }
      }
      const detailed = await searchWebDetailed(raw);
      const out = detailed.text;
      for (const u of detailed.urls) verifiedUrls.add(normalizeUrl(u));
      if (out && !/^Nenhum resultado/i.test(out)) searchOk = true;
      if (detailed.query && out && !out.startsWith('Nenhum resultado')) {
        rememberOwnerLastSearch(tenantId, phone, {
          query: detailed.query,
          urls: detailed.urls,
          answer: extractLiveQuoteLine(out) || out.replace(/\s+/g, ' ').slice(0, 240),
        });
        void recordOwnerEvent({
          tenantId,
          ownerPhone: phone,
          kind: 'fato',
          summary: `Pesquisa na internet: ${detailed.query.slice(0, 80)} — ${out.replace(/\s+/g, ' ').slice(0, 160)}`,
          connectionId: opts.connectionId,
          source: 'web_search',
        });
      }
      return out;
    };
  }

  const system =
    buildFastSystem(
      persona,
      agendaLines,
      contextBlock,
      webSearchOn,
      toolSearchAvailable,
      contactToolsOn,
      playbookBlock,
      listedOwner,
    ) + (hasImages ? OWNER_VISION_HINT : '');

  const maxTokens = hasImages
    ? VISION_MAX_TOKENS
    : ownerTools.tools.length || toolSearchAvailable
      ? TOOLS_MAX_TOKENS
      : FAST_MAX_TOKENS;

  const result = await complete(
    {
      system,
      messages,
      maxTokens,
      temperature: FAST_TEMPERATURE,
      tools: ownerTools.tools.length || toolSearchAvailable ? ownerTools.tools : undefined,
      toolExecutors:
        ownerTools.tools.length || toolSearchAvailable ? toolExecutors : undefined,
    },
    tenantId,
    {
      meter: true,
      connectionId: opts.connectionId,
      // true → mescla web_search; owner tools já vão no request.
      tools: toolSearchAvailable,
    },
  );

  if (!result?.text?.trim()) {
    logger.warn('Agente: nenhuma resposta da IA.');
    return null;
  }

  let text = result.text.trim();
  const userSaid = typeof lastUser?.content === 'string' ? lastUser.content : '';

  // Rede de segurança: se o modelo NÃO chamou a tool de envio mas o dono pediu um
  // envio a contato, reconstruímos a partir da FALA DO DONO (nunca do texto da IA)
  // e mandamos pro fluxo de decisão. Assim "avisa a esposa que…" (verbo fora da
  // whitelist) vira confirmação, e um "manda…" que o modelo esqueceu ainda sai —
  // sempre com o corpo que o DONO ditou, jamais com raciocínio do modelo.
  // Corpo em fala indireta ("se ele está bem") nunca sai sem o dono ver o texto.
  let forceConfirm = false;
  if (listedOwner && contactToolsOn && plannedSends.length === 0) {
    const parsed = parseRelayIntent(userSaid);
    if (parsed) {
      const matches = await resolveRelayContacts(
        tenantId,
        parsed.contactQuery,
        opts.connectionId,
        phone,
      ).catch(() => []);
      if (matches.length === 1) {
        const only = matches[0]!;
        plannedSends.push({
          clientId: only.id,
          name: displayName(only),
          phone: only.phone,
          body: parsed.body,
          fireAtMs: null,
        });
        forceConfirm = Boolean(parsed.indirect);
        logger.info('Secretária: envio reconstruído da fala do dono (modelo não chamou a tool).');
      }
    }
  }

  // Fluxo C — a autorização do envio é do CÓDIGO, não do modelo. O que a IA gera
  // vira, no máximo, o CORPO (campo mensagem) de cada PlannedSend; o texto que o
  // dono lê aqui é construído pelo código. Raciocínio/preâmbulo da IA nunca sai.
  if (listedOwner && contactToolsOn && plannedSends.length > 0) {
    if (plannedSends.length === 1 && hasClearSendVerb(userSaid) && !forceConfirm) {
      // Verbo claro da whitelist + 1 contato → envia direto (owner_authorized).
      text = await executePlannedSends(tenantId, phone, opts.connectionId, plannedSends);
    } else {
      // ≥2 envios OU verbo não-claro → UM plano, UMA confirmação. Nada sai sem o "sim".
      rememberPendingPlan(pendingPlanKey(tenantId, phone, opts.connectionId), plannedSends);
      text = buildPlanConfirmation(plannedSends);
    }
  } else if (listedOwner && contactToolsOn && assistantClaimedContactSend(text)) {
    // A IA AFIRMOU ter mandado, nenhuma tool disparou e não deu pra reconstruir o
    // pedido → NÃO envia. Corrige a resposta em vez de deixar a mentira passar.
    logger.info('Secretária: IA alegou envio sem tool nem reconstrução — corrijo, sem enviar.');
    const alvo = parseRelayIntent(userSaid)?.contactQuery ?? '';
    text = alvo
      ? `Ainda não mandei nada. O que você quer que eu escreva pro *${alvo}*?`
      : 'Ainda não mandei nada. Me diz pra quem e o que eu escrevo (ex.: "manda pro João: chego às 8").';
  }

  if (!cancelOk && assistantClaimedCancel(text) && userAskedCancelNotebook(userSaid)) {
    const ids = getOwnerLastList(tenantId, phone);
    const own = await listReminders(tenantId, phone, { statuses: ['pendente'], limit: 80 }).catch(
      () => [],
    );
    const fromList = own.filter((r) => ids.includes(r.id));
    const repeating = own.filter((r) => Boolean(r.recurrence));
    const targets = fromList.length ? fromList : repeating;
    let n = 0;
    for (const r of targets) {
      if (await cancelReminderById(tenantId, r.id)) n += 1;
    }
    rememberOwnerLastList(tenantId, phone, undefined);
    if (n > 0) {
      logger.info(`Secretária: cancelamento forçado após a IA não chamar a tool (${n})`);
      text =
        n === 1
          ? 'Pronto, cancelei. Saiu da lista e não toca mais.'
          : `Pronto, cancelei os ${n}. Saíram da lista e não tocam mais.`;
    }
  }

  const askedSchedule = userAskedScheduledSearch(userSaid);
  const askedTimed = userAskedTimedNotebook(userSaid) || askedSchedule;
  const askedSearchNow = userAskedSearchNow(userSaid);
  const askedLink = userAskedSearchLink(userSaid);
  if (userAskedTranscript(userSaid)) {
    const spoken = extractDictationText(userSaid);
    if (spoken) {
      logger.info('Secretária: devolvi a transcrição (pedido explícito)');
      text = spoken;
    }
  } else if (!saveOk && (askedTimed || assistantClaimedSave(text))) {
    const when =
      parseClockFromText(userSaid) ?? inferDueAtFromText(userSaid, new Date(), DEFAULT_TZ);
    const fireAction = inferFireAction(userSaid);
    const task =
      fireAction === 'search'
        ? `Pesquisar na internet: ${extractSearchQuery(userSaid)}`
        : extractNotebookTask(userSaid);
    // Trava anti-lixo: "remarque este compromisso…", "paulo", "temos compromisso
    // para" viravam TAREFA no caderno (a fala crua do dono). Pedido de MUDAR e
    // fala sem conteúdo nunca criam item novo — o código pergunta em vez de chutar.
    const isEditRequest = EDIT_REQUEST.test(userSaid);
    if (isEditRequest || taskLooksEmpty(task)) {
      logger.info(
        `Secretária: bloqueei criação forçada (${isEditRequest ? 'pedido de alterar' : 'fala sem tarefa'}): "${task.slice(0, 60)}"`,
      );
      if (assistantClaimedSave(text)) {
        text = isEditRequest
          ? 'Ainda não mexi no caderno. Me diz qual item e o novo horário — ex.: "muda o 2 para 21h".'
          : 'Ainda não anotei. Me diz o que salvar e o horário — ex.: "me lembra às 20h de ligar pro João".';
      }
    } else if (when && task) {
      const searchQuery = fireAction === 'search' ? extractSearchQuery(userSaid) : null;
      const dup = await findSimilarPendingReminder(tenantId, phone, task, when).catch(() => null);
      if (dup?.status === 'pendente') {
        logger.info(`Secretária: pesquisa/compromisso já estava no caderno (${dup.id})`);
        text = `Já estava no caderno. Te chamo ${formatForOwner(new Date(dup.next_fire_at), dup.timezone || DEFAULT_TZ)}.`;
      } else if (dup?.status === 'cancelado') {
        text = `Esse compromisso já tinha sido cancelado (${dup.task}). Não recriei.`;
      } else {
        const reminder = await createReminder(tenantId, {
          ownerPhone: phone,
          task,
          category: 'data_especifica',
          nextFireAt: when,
          timezone: DEFAULT_TZ,
          connectionId: opts.connectionId,
          fireAction,
          searchQuery,
        });
        rememberOwnerLastList(tenantId, phone, [reminder.id]);
        logger.info(`Secretária: compromisso forçado após a IA não chamar a tool → ${reminder.id}`);
        const kind =
          fireAction === 'search'
            ? 'No horário eu pesquiso de verdade e mando o resultado.'
            : `Te chamo ${formatForOwner(when, DEFAULT_TZ)}.`;
        text =
          fireAction === 'search'
            ? `Pronto, anotei. ${kind}\nTe chamo ${formatForOwner(when, DEFAULT_TZ)}.`
            : `Pronto, anotei. ${kind}`;
      }
    }
  } else if (askedLink && !askedSearchNow) {
    const last = getOwnerLastSearch(tenantId, phone);
    if (last?.urls[0] && searchReplyLooksWeak(text)) {
      logger.info('Secretária: fallback do link (resposta da IA fraca)');
      text = formatLastSearchLink(last);
    } else if (last?.urls[0] && !/https?:\/\//i.test(text)) {
      logger.info('Secretária: completei o link da busca anterior (IA não citou URL)');
      text = [text, formatLastSearchLink(last)].filter(Boolean).join('\n').trim();
    }
  } else if (askedSearchNow && (!searchOk || searchReplyLooksWeak(text))) {
    // "tenta de novo" no fallback também repete a busca anterior.
    const prev = looksLikeRetrySearch(userSaid) ? getOwnerLastSearch(tenantId, phone) : null;
    const query = prev?.query || userSaid;
    logger.info(`Secretária: fallback de pesquisa (searchOk=${searchOk}, retry=${Boolean(prev)})`);
    text = await searchAndAnswer({
      query,
      tenantId,
      connectionId: opts.connectionId,
      ownerPhone: phone,
      wantLink: askedLink,
    });
    for (const u of getOwnerLastSearch(tenantId, phone)?.urls ?? []) {
      verifiedUrls.add(normalizeUrl(u));
    }
  } else if (askedSearchNow && searchOk) {
    const last = getOwnerLastSearch(tenantId, phone);
    if (last) {
      rememberOwnerLastSearch(tenantId, phone, {
        query: last.query,
        urls: last.urls,
        answer: text.slice(0, 400),
      });
    }
  }

  void editOk;

  // Link inventado nunca sai: só sobrevive URL que veio nos resultados da busca.
  if (verifiedUrls.size) text = stripUnverifiedUrls(text, verifiedUrls);

  return sanitizeOwnerAssistantReply(text).slice(0, 4000);
}

async function drainQueue(tenantId: string, phone: string, k: string): Promise<void> {
  const q = queues.get(k);
  if (!q || q.running) return;
  q.running = true;

  while (q.jobs.length) {
    const job = q.jobs.shift()!;
    let text: string | null = null;
    try {
      text = await runFreeChatOnce(tenantId, phone, job.opts);
    } catch (err) {
      logger.warn('Agente: falha ao gerar resposta', err);
      text = null;
    }
    // Grava a resposta no histórico ANTES do próximo job — senão o turno
    // seguinte vê dois pedidos do dono sem a confirmação do anterior.
    if (text) {
      text = sanitizeOwnerAssistantReply(text);
      text = await applySecretaryPlaybookToText({
        tenantId,
        connectionId: job.opts.connectionId,
        toPhone: phone,
        text,
        lastUserMessage: job.opts.lastUserMessage,
      });
      text = sanitizeOwnerAssistantReply(text);
      await persistOwnerAssistantReply(tenantId, phone, text, job.opts.connectionId);
    }
    job.resolve({ status: 'reply', text, alreadyPersisted: Boolean(text) });
  }

  q.running = false;
  if (q.jobs.length) {
    void drainQueue(tenantId, phone, k);
  } else {
    queues.delete(k);
  }
}

/**
 * Cada mensagem do dono vira um turno na fila (um de cada vez, na ordem).
 * Pedidos novos enquanto ela trabalha esperam — não são fundidos nem descartados.
 */
export async function freeChatOwner(
  tenantId: string,
  phone: string,
  message: string,
  opts: FreeChatOptions = {},
): Promise<FreeChatResult> {
  const trimmed = message.trim();
  if (!trimmed && !opts.images?.length) return { status: 'reply', text: null };

  const k = batchKey(tenantId, phone, opts.connectionId);

  return new Promise<FreeChatResult>((resolve) => {
    const q = queues.get(k) ?? { jobs: [], running: false };
    q.jobs.push({ opts: { ...opts, lastUserMessage: trimmed || opts.lastUserMessage }, resolve });
    queues.set(k, q);
    void drainQueue(tenantId, phone, k);
  });
}

/** Grava resposta da secretária/agente no histórico (tempo real). */
export async function persistOwnerAssistantReply(
  tenantId: string,
  phone: string,
  text: string,
  connectionId?: string | null,
): Promise<void> {
  await appendOwnerChatMessage({
    tenantId,
    ownerPhone: phone,
    role: 'assistant',
    content: text,
    connectionId,
  }).catch((err) => logger.warn('Secretária: falha ao persistir resposta', err));
  // Depois de cada resposta: a IA interpreta o fio (sem keyword) e atualiza a memória.
  scheduleOwnerMemoryExtract(tenantId, phone, connectionId);
}

/** Grava mensagem inbound do dono (com id do provedor p/ idempotência). */
export async function persistOwnerUserMessage(input: {
  tenantId: string;
  phone: string;
  content: string;
  connectionId?: string | null;
  providerMessageId?: string | null;
}): Promise<void> {
  await appendOwnerChatMessage({
    tenantId: input.tenantId,
    ownerPhone: input.phone,
    role: 'user',
    content: input.content,
    connectionId: input.connectionId,
    providerMessageId: input.providerMessageId,
  }).catch((err) => logger.warn('Secretária: falha ao persistir msg do dono', err));
}

/** Flags efetivos da conexão (defaults: secretária ON, agente OFF, busca OFF, acesso livre OFF). */
export async function getOwnerModeFlags(
  tenantId: string,
  connectionId?: string | null,
): Promise<{ secretary: boolean; agent: boolean; webSearch: boolean; openAccess: boolean }> {
  if (!connectionId) {
    return { secretary: true, agent: false, webSearch: false, openAccess: false };
  }
  const conn = await getConnectionById(tenantId, connectionId);
  return {
    secretary: conn?.owner_secretary_enabled !== false,
    agent: conn?.owner_free_chat_enabled === true,
    webSearch: conn?.owner_web_search_enabled === true,
    openAccess: conn?.owner_open_access_enabled === true,
  };
}
