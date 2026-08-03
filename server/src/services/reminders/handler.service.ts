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
import { getTenantWhatsapp } from '../whatsapp.service';
import { transcribeAudioFromBase64, transcribeAudioFromUrl } from '../transcription.service';
import type { NormalizedInbound } from '../whatsapp/types';
import type { Reminder } from '../../types';
import { describeLead, describeRecurrence, parseReminders, type ParsedReminder } from './parse.service';
import { DEFAULT_TZ, formatForOwner, fromWallClock, toWallClock } from './time';

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

async function reply(tenantId: string, phone: string, text: string): Promise<void> {
  const wa = await getTenantWhatsapp(tenantId);
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

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const AFFIRMATIVE = new Set(['sim', 's', 'ok', 'okay', 'isso', 'confirmar', 'confirma', 'pode', 'certo', 'blz', 'beleza', 'positivo', '1', '👍']);
const NEGATIVE = new Set(['nao', 'n', 'cancela', 'cancelar', 'esquece', 'deixa', 'nada', '0']);

const HELP_TEXT = [
  '*Seu assistente de lembretes*',
  '',
  'Para criar, é só falar naturalmente (texto ou áudio):',
  '_"me lembra amanhã às 9h de pagar o fornecedor"_',
  '_"toda sexta cobrar os inadimplentes"_',
  '_"reunião quinta às 15h, me avise 1 hora antes"_',
  '_"me lembra daqui a 10 minutos de ligar pro cliente"_',
  '',
  'Para consultar, pergunte à vontade:',
  '_"o que temos para hoje?"_ · _"meus compromissos da semana"_',
  'Ou mande a palavra: *HOJE*, *AMANHÃ*, *SEMANA*, *MÊS*, *ROTINA*, *IMPORTANTES*, *TODOS*',
  'Para fechar: *CONCLUIR 2* · Para remover: *CANCELAR 2*',
  '(o número é o da última lista que eu te mandei)',
  '',
  'Manda vários de uma vez que eu confirmo todos juntos.',
  'Se a varredura estiver ligada: *RECUPERAR COMPROMISSOS* ou *VARRER 7 DIAS*.',
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

function detectQuery(normalized: string): string | null {
  // 1) Palavra solta, como sempre funcionou.
  const exact = QUERY_WORDS[normalized];
  if (exact) return exact;

  const asks = ASK_OPENERS.test(normalized);
  const isQuestion = normalized.trim().endsWith('?');
  const mentionsAgenda = AGENDA_NOUNS.test(normalized);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const scope = SCOPE_WORDS.find(([re]) => re.test(normalized))?.[1] ?? null;

  // "me lembra de pagar amanhã" é cadastro, mesmo citando um dia — a menos que
  // a frase seja explicitamente uma pergunta ("o que você tem pra me lembrar?").
  if (STRONG_CREATE.test(normalized) && !asks) return null;

  // Pergunta explícita, ou frase curta girando em torno da agenda
  // ("agenda hoje", "meus compromissos"). O limite de 3 palavras evita
  // confundir com "agenda uma reunião amanhã", que é cadastro.
  const looksLikeQuery =
    asks || (isQuestion && (mentionsAgenda || scope !== null)) || (mentionsAgenda && words <= 3);
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

function renderList(reminders: Reminder[], title: string, tz: string): string {
  if (reminders.length === 0) return `Nenhum compromisso ${title.toLowerCase()}.`;
  const lines = reminders.map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), tz);
    const repeat = r.recurrence ? ` · repete ${describeRecurrence(r.recurrence)}` : '';
    const lead = r.lead_minutes ? ` · aviso ${describeLead(r.lead_minutes)}` : '';
    return `${i + 1}. ${r.task}\n   ${when}${repeat}${lead}`;
  });
  return [`*${title}*`, '', ...lines, '', 'Para fechar: CONCLUIR N ou CANCELAR N.'].join('\n');
}

const CREATE_TRIGGERS = /\b(lembr|anota|agenda|marca|avisa|nao me deixa esquecer|não me deixa esquecer)/i;

/**
 * A empresa cadastrou uma keyword de disparo (content_type='reminders_today') e
 * a mensagem do dono casa com ela? Zero IA — só leitura das keywords + match
 * normalizado. As de outros tipos são ignoradas aqui (são do fluxo de vendas).
 */
async function matchesReminderKeyword(tenantId: string, text: string): Promise<boolean> {
  const keywords = await getActiveKeywords(tenantId);
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
): Promise<boolean> {
  const phone = inbound.phone;
  const tz = DEFAULT_TZ;

  if (alreadyHandled(inbound.providerMessageId)) {
    logger.info(`Lembretes: webhook repetido ignorado (${inbound.providerMessageId}).`);
    return true;
  }

  // Passo 0: obter o texto do comando, venha de onde vier.
  let text: string | null = null;
  if (inbound.type === 'text') {
    text = inbound.text;
  } else if (inbound.type === 'audio') {
    text = await transcribeOwnerAudio(inbound);
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
    logger.info(`Lembretes: áudio do dono transcrito (${text.length} chars).`);
  }

  if (!text || !text.trim()) return true;
  const normalized = normalize(text);
  const owner = getState(tenantId, phone);

  // 1. Confirmação pendente tem prioridade sobre tudo.
  if (owner.pending) {
    const { items, source } = owner.pending;

    if (AFFIRMATIVE.has(normalized)) {
      const inputs: CreateReminderInput[] = items.map((p) => ({
        ownerPhone: phone,
        task: p.task,
        category: p.category,
        recurrence: p.recurrence,
        nextFireAt: p.nextFireAt,
        leadMinutes: p.leadMinutes,
        timezone: tz,
      }));
      // Tudo-ou-nada: ou grava todos, ou nenhum (transação).
      await createRemindersBulk(tenantId, inputs);
      setState(tenantId, phone, { pending: undefined });
      await reply(
        tenantId,
        phone,
        items.length === 1
          ? `Anotado! Te aviso ${formatForOwner(items[0].nextFireAt, tz)}.`
          : `Salvei os ${items.length} lembretes.`,
      );
      return true;
    }

    if (NEGATIVE.has(normalized)) {
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
        const reparsed = await parseReminders(tenantId, `${items[idx].task}\nCorreção: ${correction}`, tz);
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
  const queryKey = detectQuery(normalized);
  if (queryKey) {
    const filter = rangeFor(queryKey, tz);
    if (filter) {
      const reminders = await listReminders(tenantId, phone, filter);
      setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
      await reply(tenantId, phone, renderList(reminders, QUERY_TITLE[queryKey] ?? queryKey.toUpperCase(), tz));
      return true;
    }
  }

  // 2.5. Disparo por palavra-chave CADASTRADA (content_type='reminders_today').
  // Zero IA: casa a frase que o dono cadastrou no painel e responde a lista de
  // hoje. Vive aqui de propósito — só roda para a whitelist —, com re-checagem
  // defensiva para o cliente jamais receber lembrete (isolamento máximo).
  if (await matchesReminderKeyword(tenantId, text)) {
    if (!(await isReminderOwner(tenantId, phone))) return true;
    const todays = await getTodayReminders(tenantId, phone);
    setState(tenantId, phone, { lastList: todays.map((r) => r.id) });
    await reply(tenantId, phone, renderList(todays, QUERY_TITLE.hoje, tz));
    return true;
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
    if (!(await isMemoryScanEnabled(tenantId))) {
      await reply(
        tenantId,
        phone,
        'A varredura de conversas está desligada. Ligue em Configurações → Recuperar compromissos e tente de novo.',
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

  if (normalized === 'ajuda' || normalized === 'menu' || normalized === '?') {
    await reply(tenantId, phone, HELP_TEXT);
    return true;
  }

  // 4. Cadastro em linguagem natural.
  return handleCreate(tenantId, phone, text, tz, text);
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
    return `${items[0].confirmationText}\n\nConfirma? (responda *sim* ou me corrija)`;
  }
  const lines = items.map((it, i) => {
    const when = formatForOwner(it.nextFireAt, tz);
    const repeat = it.recurrence ? ` · repete ${describeRecurrence(it.recurrence)}` : '';
    const lead = it.leadMinutes ? ` · aviso ${describeLead(it.leadMinutes)}` : '';
    return `${i + 1}. ${it.task}\n   ${when}${repeat}${lead}`;
  });
  return [
    `Entendi ${items.length} lembretes:`,
    '',
    ...lines,
    '',
    'Responda SIM para salvar todos, ou diga o número a corrigir (ex.: "2 na verdade às 16h").',
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
  const parsed = await parseReminders(tenantId, message, tz);

  if (parsed.length === 0) {
    // Sem gatilho claro E sem interpretação: provavelmente não era um lembrete.
    // Mesmo assim respondemos o menu — o dono nunca deve cair no fluxo de vendas.
    await reply(
      tenantId,
      phone,
      looksLikeReminder
        ? 'Entendi que é um lembrete, mas não consegui identificar a data. Pode repetir dizendo quando?'
        : HELP_TEXT,
    );
    return true;
  }

  const items = parsed.map(toPendingItem);
  setState(tenantId, phone, { pending: { items, source: originalText } });
  await reply(tenantId, phone, renderConfirmation(items, tz));
  return true;
}
