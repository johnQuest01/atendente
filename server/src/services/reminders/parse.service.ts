import { z } from 'zod';
import { logger } from '../../config/logger';
import { complete } from '../ai/orchestrator';
import { listReminders } from '../../db/queries/reminders';
import { listOwnerChatHistory } from '../../db/queries/owner_chat_messages';
import { getReminderPersona } from '../../db/queries/settings';
import { buildOwnerMemoryPromptBlock } from '../owner-memory.service';
import type { Reminder, ReminderCategory } from '../../types';
import {
  DEFAULT_TZ,
  formatForOwner,
  fromWallClock,
  inferIntervalRecurrence,
  isValidRecurrence,
  nextOccurrence,
  parseLocalIso,
  snapPastYearToUpcoming,
  toWallClock,
  weekdayNamePt,
} from './time';

/**
 * Interpretação do lembrete em linguagem natural. Usa o orquestrador de IA da
 * empresa (com failover) — nunca um SDK cru.
 *
 * A data relativa é resolvida pelo MODELO, mas com a data/hora atual injetada
 * no prompt: sem isso ele chuta "hoje" a partir do treino. E o horário volta
 * como relógio de parede, convertido aqui para UTC no fuso do dono.
 *
 * O caderno do dono (lembretes pendentes no banco) entra no prompt para frases
 * abertas do tipo "não esquece do compromisso de hoje" saberem do que se trata.
 */

const parsedSchema = z.object({
  task: z.string().trim().min(1).max(4000),
  type: z.enum(['unico', 'recorrente']),
  due_at: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  remind_before_minutes: z.coerce.number().int().nullable().optional(),
  category: z.enum(['importante', 'rotina', 'data_especifica']),
  confirmation_text: z.string().trim().min(1).max(400),
  /** create = novo; acknowledge = só confirma (não grava); update = muda item do caderno. */
  action: z.enum(['create', 'acknowledge', 'update']).optional().default('create'),
  /** Índice 1-based da lista CADERNO DO DONO (obrigatório em update quando der). */
  caderno_n: z.coerce.number().int().positive().max(80).nullable().optional(),
});

export interface ParsedReminder {
  task: string;
  category: ReminderCategory;
  recurrence: string | null;
  nextFireAt: Date;
  /** Minutos de aviso prévio, quando o dono pediu ("1h antes" = 60). */
  leadMinutes: number | null;
  confirmationText: string;
  action: 'create' | 'acknowledge' | 'update';
  /** Id do compromisso no banco, quando action=update e o caderno casou. */
  existingId?: string;
}

/** Teto de 7 dias — bate com o CHECK da migration 025. */
const MAX_LEAD_MINUTES = 7 * 24 * 60;

export function describeLead(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? '1 dia antes' : `${d} dias antes`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hora antes' : `${h} horas antes`;
  }
  return `${minutes} min antes`;
}

/** Pendentes no prompt (despertar diários entram primeiro pela data). */
const AGENDA_LIMIT = 50;

/** Lê o caderno do dono (pendentes) para a IA não “esquecer” o que já foi anotado. */
export async function loadOwnerAgenda(
  tenantId: string,
  ownerPhone: string,
  _tz: string = DEFAULT_TZ,
): Promise<Reminder[]> {
  try {
    return await listReminders(tenantId, ownerPhone, {
      statuses: ['pendente'],
      limit: AGENDA_LIMIT,
    });
  } catch (err) {
    logger.warn('Lembretes: falha ao carregar agenda do banco para o parse', err);
    return [];
  }
}

export function foldReminderTask(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Texto completo para mostrar ao dono: relay_body (mensagem que vai no zap) se a task foi cortada. */
export function reminderDisplayText(r: Pick<Reminder, 'task' | 'relay_body'>): string {
  const task = (r.task || '').trim();
  const relay = (r.relay_body || '').trim();
  if (!relay) return task;
  const prefix = task.match(/^(Enviar p\/\s*[^:]+:)\s*/i);
  const rest = prefix ? task.slice(prefix[0].length).trim() : task;
  if (rest.includes(relay) || relay === rest) return task;
  if (relay.startsWith(rest) && relay.length > rest.length) {
    return prefix ? `${prefix[1].trim()}\n${relay}` : relay;
  }
  if (prefix) return `${prefix[1].trim()}\n${relay}`;
  if (relay.length > rest.length) return `${task}\n${relay}`;
  return task;
}

/** Linha do caderno com horário relativo e se já tocou. */
export function formatCadernoItem(
  r: Pick<
    Reminder,
    | 'task'
    | 'relay_body'
    | 'next_fire_at'
    | 'timezone'
    | 'status'
    | 'last_fired_at'
    | 'recurrence'
    | 'fire_action'
  >,
  tz: string,
): string {
  const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
  const repeat = r.recurrence ? ` · repete ${describeRecurrence(r.recurrence)}` : '';
  const fired = r.last_fired_at
    ? ` · tocou ${formatForOwner(new Date(r.last_fired_at), r.timezone || tz)}`
    : '';
  const kind = r.fire_action === 'search' ? ' · pesquisa na hora' : '';
  return `${reminderDisplayText(r)} — ${when}${repeat}${kind} (${r.status}${fired})`;
}

export function matchRemindersByTask(task: string, agenda: Reminder[]): Reminder[] {
  const t = foldReminderTask(task);
  if (!t) return [];
  const exact = agenda.filter((r) => foldReminderTask(r.task) === t);
  if (exact.length) return exact;
  return agenda.filter((r) => {
    const rt = foldReminderTask(r.task);
    if (!rt) return false;
    return rt.includes(t) || t.includes(rt);
  });
}

function matchCaderno(
  data: { caderno_n?: number | null; task: string },
  agenda: Reminder[],
): Reminder | null {
  const n = data.caderno_n;
  if (typeof n === 'number' && n >= 1 && n <= agenda.length) return agenda[n - 1]!;
  const hits = matchRemindersByTask(data.task, agenda);
  return hits.length === 1 ? hits[0]! : null;
}

/** Se o relógio de parede já passou hoje, empurra para o próximo ciclo. */
export function bumpUntilFuture(d: Date, now: Date, tz: string, recurrence?: string | null): Date {
  let cur = snapPastYearToUpcoming(d, now, tz);
  if (cur.getTime() > now.getTime()) return cur;
  if (recurrence && isValidRecurrence(recurrence)) {
    const next = nextOccurrence(recurrence, cur, tz, now);
    if (next && next.getTime() > now.getTime()) return next;
  }
  let guard = 0;
  while (cur.getTime() <= now.getTime() && guard < 14) {
    const wc = toWallClock(cur, tz);
    cur = fromWallClock(
      { year: wc.year, month: wc.month, day: wc.day + 1, hour: wc.hour, minute: wc.minute },
      tz,
    );
    guard += 1;
  }
  if (cur.getTime() <= now.getTime()) {
    const nw = toWallClock(now, tz);
    const wc = toWallClock(d, tz);
    cur = fromWallClock(
      { year: nw.year, month: nw.month, day: nw.day + 1, hour: wc.hour, minute: wc.minute },
      tz,
    );
  }
  return cur;
}

function formatAgendaBlock(reminders: Reminder[], tz: string): string {
  if (reminders.length === 0) {
    return [
      '',
      'CADERNO DESTA PESSOA (banco, só este número): (vazio — nada pendente nos próximos dias).',
      'Se ela falar de "o compromisso de hoje" e o caderno estiver vazio, diga isso no confirmation_text e use action=acknowledge.',
    ].join('\n');
  }
  const lines = reminders.map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
    const repeat = r.recurrence ? ` · repete ${describeRecurrence(r.recurrence)}` : '';
    return `${i + 1}. ${reminderDisplayText(r)} — ${when}${repeat}`;
  });
  return [
    '',
    'CADERNO DESTA PESSOA (já salvo no banco, só este número — use isto para frases abertas):',
    ...lines,
    '',
    'Se ele disser "o compromisso de hoje", "aquela reunião", "não esquece de me avisar do de hoje", etc.:',
    '- Identifique o item no caderno (task e horário reais).',
    '- action=acknowledge (NÃO invente outro igual; o alarme já está salvo).',
    '- confirmation_text humano citando o nome real (ex.: "Pode deixar — te chamo pra Ir dormir às 22h.").',
    'Se ele pedir para ALTERAR / MUDAR / EDITAR horário (madrugada, manhã, despertar, "os horários que falei"):',
    '- action=update. NUNCA acknowledge (não grava) e NUNCA create (duplica).',
    '- caderno_n = o número da linha acima. Um objeto por item se forem vários.',
    'Só use action=create para compromisso NOVO que ainda não está no caderno.',
  ].join('\n');
}

function buildSystemPrompt(
  now: Date,
  tz: string,
  persona?: string | null,
  bulk = false,
  agenda: Reminder[] = [],
  memoryBlock = '',
  recentTurns = '',
): string {
  const wc = toWallClock(now, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  const agora = `${wc.year}-${pad(wc.month)}-${pad(wc.day)}T${pad(wc.hour)}:${pad(wc.minute)}`;
  // A persona (editável no painel) molda só o TOM do confirmation_text — a data
  // resolvida continua sendo anexada pelo código, para não depender de a IA
  // acertar o horário.
  const personaBlock = persona?.trim()
    ? [
        '',
        'TOM ao redigir o confirmation_text (como pessoa anotando, nunca como IA):',
        persona.trim(),
      ].join('\n')
    : '';
  const formatLine = bulk
    ? 'O usuário pode ter enviado VÁRIOS compromissos numa mensagem. Responda APENAS com um ' +
      'ARRAY JSON (um objeto por item, no máximo 20; se houver só um, um array de um item), ' +
      'sem texto antes ou depois. Cada objeto tem o formato:'
    : 'Responda APENAS com JSON válido, sem texto antes ou depois, no formato:';
  return [
    `Extraia o que a pessoa pediu para anotar. Agora é ${agora} (${weekdayNamePt(now, tz)}), fuso ${tz}.`,
    'Escreva como quem anota no caderno — nunca como assistente, robô ou IA.',
    'Você TEM o caderno real do banco abaixo: use-o. Não finja que não sabe o que já foi anotado.',
    formatLine,
    '{',
    '  "task": "só a ação/assunto, curto (ex.: Ir dormir, Pagar fornecedor) — SEM a palavra lembrete",',
    '  "type": "unico" | "recorrente",',
    '  "due_at": "YYYY-MM-DDTHH:mm do PRIMEIRO disparo (sempre preencha em create/update; em acknowledge use o horário do caderno)",',
    '  "recurrence": "daily | weekly:MON..SUN | monthly:N | every:2d — apenas se recorrente, senão null",',
    '  "remind_before_minutes": "minutos de aviso ANTECIPADO se o usuário pediu, senão null",',
    '  "category": "importante" | "rotina" | "data_especifica",',
    '  "confirmation_text": "1 frase humana (ex.: Anotei: ir dormir amanhã às 22h / Vou alterar o despertar para 05h)",',
    '  "action": "create" | "acknowledge" | "update",',
    '  "caderno_n": "número 1-based do CADERNO DO DONO quando action=update, senão null"',
    '}',
    '',
    'Regras de action:',
    '- create: compromisso novo a salvar.',
    '- acknowledge: ele fala de algo JÁ no caderno SEM pedir mudança ("não esquece do de hoje"); não duplicar.',
    '- update: ALTERAR/MUDAR/EDITAR horário ou tarefa de item JÁ no caderno. Nunca acknowledge (não grava) nem create (duplica).',
    '- "os horários que falei" / despertar / alarme: use o caderno + o fio recente; um JSON update por item.',
    '',
    'Regras de task e confirmation_text:',
    '- task NUNCA começa com "Lembrete", "Lembrar de" genérico ou "Aviso:"; só o que fazer.',
    '- confirmation_text NÃO usa "lembrete cadastrado", "agendei", "sistema" nem se apresenta como IA.',
    '',
    'Regras de data, sempre a partir do agora informado acima:',
    '- "hoje" é a data de hoje; "amanhã" é o dia seguinte.',
    '- "11h da noite" / "11 horas da noite" / "11 da noite" / "23h" = 23:00 (NUNCA 11:00). "12 da noite" = 00:00.',
    '- "11h da manhã" = 11:00. "da tarde" em hora 1–11 = +12 (15h).',
    '- Se a pessoa disse HOJE / AMANHÃ / um dia + um horário, due_at é OBRIGATÓRIO — nunca null.',
    '- Um dia da semana ("quinta") é a próxima ocorrência dele; se hoje é esse dia e o horário já passou, é o da semana seguinte.',
    '- "dia N" é o dia N deste mês, ou do próximo se já passou.',
    '- "daqui a X dias" é hoje + X dias.',
    // Sem esta linha o modelo tende a arredondar "daqui a 5 minutos" para o dia
    // seguinte — e é assim que qualquer pessoa testa o recurso pela primeira vez.
    '- "daqui a X minutos" / "daqui a X horas" / "em X min" é o horário de agora + X, no MESMO dia.',
    '- "toda segunda" = weekly:MON; "todo dia N" = monthly:N; "todo dia" = daily.',
    '- "um dia sim, um dia não" / "dia sim dia não" / "12x36" / "12 por 36" / "a cada 2 dias" / "de dois em dois dias" = every:2d (type=recorrente). Plantão 19h–7h = dois itens (entrada 19:00 e saída 07:00).',
    '- "7 da manhã" / "7h da manhã" / "às 7 da manhã" = 07:00.',
    '- Sem horário explícito, use 09:00 e diga isso no confirmation_text.',
    '- "madrugada" sem hora = 05:00. "de manhã" / "manhã" sem hora = 08:00.',
    '- Se due_at já passou hoje (ex.: despertar 05:00 às 23h), use o PRÓXIMO disparo (amanhã nesse horário) — não deixe vazio.',
    '- NUNCA use ano anterior ao agora no due_at (treino antigo). Se a pessoa disse 15/08 e hoje é 2026, due_at é 2026-08-15 — não 2025.',
    '- Se a mensagem for ambígua, escolha a interpretação mais provável e explique-a no confirmation_text.',
    '',
    'Aviso antecipado (remind_before_minutes): só preencha se o usuário pedir explicitamente.',
    '- "me avise 1 hora antes" = 60; "meia hora antes" = 30; "avise na véspera" ou "um dia antes" = 1440.',
    '- O due_at continua sendo o horário DO COMPROMISSO, nunca o do aviso antecipado.',
    '- Sem pedido de aviso prévio, use null.',
    '',
    'Categorias: "importante" para pagamentos/prazos críticos; "rotina" para hábitos repetidos;',
    '"data_especifica" para compromissos pontuais.',
    formatAgendaBlock(agenda, tz),
    recentTurns,
    memoryBlock ? `\n${memoryBlock}` : '',
    personaBlock,
  ].join('\n');
}

function extractJson(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Extrai um ARRAY JSON; tolera a IA devolver um objeto só (vira array de 1). */
function extractJsonArray(text: string): unknown[] | null {
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* cai no objeto único abaixo */
    }
  }
  const obj = extractJson(text);
  return obj ? [obj] : null;
}

/** Teto por mensagem — barra alucinação/abuso (bate com a Parte 1 do prompt). */
const MAX_BULK = 20;

/**
 * Converte UM objeto validado da IA em ParsedReminder resolvendo data,
 * recorrência e aviso prévio. Retorna null quando não dá para confiar (sem
 * due_at) — o item é simplesmente ignorado.
 */
function foldPt(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

const MONTHS_PT: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

/**
 * Relógio de parede a partir da frase, quando a IA omite due_at ou troca
 * "11h da noite" por 11:00. Sem chute: só casa horário explícito.
 */
export function inferDueAtFromText(text: string, now: Date, tz: string): Date | null {
  const t = foldPt(text);
  const wcNow = toWallClock(now, tz);

  let hour: number | null = null;
  let minute = 0;

  const spokenShift = t.match(
    /\b(\d{1,2})\s+e\s+(\d{1,2})\s*(?:da|de)\s*(tarde|noite|manha)\b/,
  );
  const night = t.match(/\b(\d{1,2})\s*(?:h|:|horas?)?\s*(\d{2})?\s*(?:da|a)\s*noite\b/);
  const morning = t.match(/\b(\d{1,2})\s*(?:h|:|horas?)?\s*(\d{2})?\s*(?:da|de)\s*manha\b/);
  const afternoon = t.match(/\b(\d{1,2})\s*(?:h|:|horas?)?\s*(\d{2})?\s*(?:da|de)\s*tarde\b/);
  const clock24 = t.match(/\b(\d{1,2})h(\d{2})?\b/);
  const colon = t.match(/\b(\d{1,2}):(\d{2})\b/);

  if (spokenShift) {
    hour = Number(spokenShift[1]);
    minute = Number(spokenShift[2]);
    const period = spokenShift[3];
    if (period === 'tarde' && hour > 0 && hour < 12) hour += 12;
    else if (period === 'noite') {
      if (hour === 12) hour = 0;
      else if (hour > 0 && hour < 12) hour += 12;
    } else if (period === 'manha' && hour === 12) hour = 0;
  } else if (night) {
    hour = Number(night[1]);
    minute = night[2] && /^\d{2}$/.test(night[2]) ? Number(night[2]) : 0;
    if (hour === 12) hour = 0;
    else if (hour > 0 && hour < 12) hour += 12;
  } else if (morning) {
    hour = Number(morning[1]);
    minute = morning[2] && /^\d{2}$/.test(morning[2]) ? Number(morning[2]) : 0;
    if (hour === 12) hour = 0;
  } else if (afternoon) {
    hour = Number(afternoon[1]);
    minute = afternoon[2] && /^\d{2}$/.test(afternoon[2]) ? Number(afternoon[2]) : 0;
    if (hour > 0 && hour < 12) hour += 12;
  } else if (clock24) {
    hour = Number(clock24[1]);
    minute = clock24[2] ? Number(clock24[2]) : 0;
  } else if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  }

  if (hour === null || hour > 23 || minute > 59) return null;

  let year = wcNow.year;
  let month = wcNow.month;
  let day = wcNow.day;

  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const long = t.match(
    /\b(?:dia\s+)?(\d{1,2})\s+de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?\b/,
  );
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (slash) {
    day = Number(slash[1]);
    month = Number(slash[2]);
    if (slash[3]) {
      year = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    }
  } else if (long) {
    day = Number(long[1]);
    month = MONTHS_PT[long[2]!] ?? month;
    if (long[3]) year = Number(long[3]);
  } else if (/\bamanha\b/.test(t)) {
    const tmr = fromWallClock(
      { year: wcNow.year, month: wcNow.month, day: wcNow.day + 1, hour: 12, minute: 0 },
      tz,
    );
    const w = toWallClock(tmr, tz);
    year = w.year;
    month = w.month;
    day = w.day;
  }

  const date = fromWallClock({ year, month, day, hour, minute }, tz);
  if (Number.isNaN(date.getTime())) return null;
  return bumpUntilFuture(date, now, tz);
}

function applyInferredDue(
  parsedDue: Date | null,
  sourceText: string | undefined,
  now: Date,
  tz: string,
): Date | null {
  if (!sourceText?.trim()) return parsedDue;
  const inferred = inferDueAtFromText(sourceText, now, tz);
  if (!inferred) return parsedDue;
  if (!parsedDue) return inferred;
  const night = /\bnoite\b/.test(foldPt(sourceText));
  const wcDue = toWallClock(parsedDue, tz);
  const wcInf = toWallClock(inferred, tz);
  if (night && wcDue.hour < 12 && wcInf.hour >= 12) return inferred;
  return parsedDue;
}

function resolveParsed(
  data: z.infer<typeof parsedSchema>,
  now: Date,
  tz: string,
  agenda: Reminder[] = [],
  sourceText?: string,
): ParsedReminder | null {
  const action = data.action ?? 'create';
  const task = stripReminderLabel(data.task);

  if (action === 'acknowledge') {
    const nextFireAt = data.due_at ? parseLocalIso(data.due_at, tz) : null;
    return {
      task,
      category: data.category,
      recurrence: null,
      nextFireAt: nextFireAt && nextFireAt.getTime() > now.getTime() ? nextFireAt : now,
      leadMinutes: null,
      confirmationText: data.confirmation_text,
      action: 'acknowledge',
    };
  }

  let parsedDue = data.due_at ? parseLocalIso(data.due_at, tz) : null;
  if (data.due_at && !parsedDue) {
    logger.warn(`Lembretes: due_at inválido — "${data.due_at}"`);
  }
  parsedDue = applyInferredDue(parsedDue, sourceText, now, tz);
  if (!parsedDue) {
    logger.warn('Lembretes: IA não devolveu due_at.');
    return null;
  }

  const existing = action === 'update' ? matchCaderno(data, agenda) : null;

  let recurrence: string | null = null;
  if (data.type === 'recorrente' && data.recurrence) {
    const rule = data.recurrence.trim().toLowerCase();
    if (isValidRecurrence(rule)) recurrence = rule;
    else logger.warn(`Lembretes: recorrência não reconhecida — "${data.recurrence}" (salvando como único).`);
  }
  const inferredRec = sourceText ? inferIntervalRecurrence(sourceText) : null;
  if (inferredRec) recurrence = inferredRec;
  if (action === 'update' && !recurrence && existing?.recurrence) {
    recurrence = existing.recurrence;
  }

  const nextFireAt = bumpUntilFuture(parsedDue, now, tz, recurrence);

  let leadMinutes: number | null = null;
  const rawLead = data.remind_before_minutes ?? null;
  if (rawLead && rawLead > 0) {
    const clamped = Math.min(rawLead, MAX_LEAD_MINUTES);
    const fitsBeforeNow = nextFireAt.getTime() - clamped * 60_000 > now.getTime();
    if (fitsBeforeNow) leadMinutes = clamped;
    else logger.warn(`Lembretes: aviso de ${clamped}min antes não cabe até o compromisso — ignorado.`);
  } else if (action === 'update' && existing) {
    leadMinutes = existing.lead_minutes;
  }

  const verb = data.confirmation_text;
  return {
    task: existing?.task ?? task,
    category: data.category,
    recurrence,
    nextFireAt,
    leadMinutes,
    confirmationText:
      `${verb}\n${formatForOwner(nextFireAt, tz)}` +
      `${recurrence ? ` · repete ${describeRecurrence(recurrence)}` : ''}` +
      `${leadMinutes ? `\nTe aviso ${describeLead(leadMinutes)}` : ''}`,
    action: action === 'update' ? 'update' : 'create',
    existingId: existing?.id,
  };
}

/** Evita task tipo "Lembrete: ir dormir" — no disparo deve sair só "Ir dormir". */
function stripReminderLabel(task: string): string {
  return task
    .replace(/^(lembrete|aviso|alerta)\s*[:\-–—]?\s*/i, '')
    .replace(/^lembrar\s+de\s+/i, '')
    .trim() || task.trim();
}

async function loadRecentTurns(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<string> {
  try {
    const rows = await listOwnerChatHistory(tenantId, ownerPhone, {
      connectionId,
      limit: 12,
    });
    if (rows.length === 0) return '';
    const lines = rows.map((m) => {
      const who = m.role === 'user' ? 'DONO' : 'VOCÊ';
      return `${who}: ${m.content.slice(0, 400)}`;
    });
    return [
      '',
      'FIO RECENTE (ele pode dizer "os horários que falei" — use isto + o caderno):',
      ...lines,
    ].join('\n');
  } catch (err) {
    logger.warn('Lembretes: falha ao carregar fio recente para o parse', err);
    return '';
  }
}

/**
 * Interpreta a mensagem do dono. Retorna null quando a IA não está disponível
 * ou devolveu algo que não dá para confiar — o chamador então pede o texto de
 * outro jeito, em vez de salvar um lembrete errado.
 */
export interface ParseReminderOptions {
  /** Persona a usar no lugar da salva (playground do painel). */
  personaOverride?: string | null;
  /** Dono: carrega o caderno dele do banco para frases abertas. */
  ownerPhone?: string;
  /** WhatsApp da conversa, para filtrar o fio recente. */
  connectionId?: string | null;
}

export async function parseReminder(
  tenantId: string,
  message: string,
  tz: string = DEFAULT_TZ,
  opts: ParseReminderOptions = {},
): Promise<ParsedReminder | null> {
  const now = new Date();
  const persona =
    opts.personaOverride !== undefined ? opts.personaOverride : await getReminderPersona(tenantId);
  const agenda = opts.ownerPhone ? await loadOwnerAgenda(tenantId, opts.ownerPhone, tz) : [];
  const memoryBlock = opts.ownerPhone
    ? await buildOwnerMemoryPromptBlock(tenantId, opts.ownerPhone)
    : '';
  const recentTurns = opts.ownerPhone
    ? await loadRecentTurns(tenantId, opts.ownerPhone, opts.connectionId)
    : '';
  const result = await complete(
    {
      system: buildSystemPrompt(now, tz, persona, false, agenda, memoryBlock, recentTurns),
      messages: [{ role: 'user', content: message.slice(0, 1000) }],
      maxTokens: 400,
      temperature: 0,
    },
    tenantId,
    { meter: true },
  );
  if (!result) {
    logger.warn('Lembretes: nenhuma IA disponível para interpretar a mensagem.');
    return null;
  }

  const json = extractJson(result.text);
  if (!json) {
    logger.warn(`Lembretes: resposta da IA não era JSON — "${result.text.slice(0, 120)}"`);
    return fallbackCreateFromText(message, now, tz, agenda)[0] ?? null;
  }

  const parsed = parsedSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(`Lembretes: JSON da IA fora do formato — ${parsed.error.issues[0]?.message}`);
    return fallbackCreateFromText(message, now, tz, agenda)[0] ?? null;
  }

  const resolved = resolveParsed(parsed.data, now, tz, agenda, message);
  if (!resolved) return fallbackCreateFromText(message, now, tz, agenda)[0] ?? null;
  return expandReminderUpdates([resolved], agenda, now, tz)[0] ?? null;
}

/**
 * Criação em MASSA: a mensagem pode conter vários lembretes de uma vez. Devolve
 * a lista resolvida (data/recorrência/aviso), no máximo MAX_BULK, ignorando
 * itens sem data/tarefa. Vazio quando não deu para interpretar nada.
 */
export async function parseReminders(
  tenantId: string,
  message: string,
  tz: string = DEFAULT_TZ,
  opts: ParseReminderOptions = {},
): Promise<ParsedReminder[]> {
  const now = new Date();
  const persona =
    opts.personaOverride !== undefined ? opts.personaOverride : await getReminderPersona(tenantId);
  const agenda = opts.ownerPhone ? await loadOwnerAgenda(tenantId, opts.ownerPhone, tz) : [];
  const memoryBlock = opts.ownerPhone
    ? await buildOwnerMemoryPromptBlock(tenantId, opts.ownerPhone)
    : '';
  const recentTurns = opts.ownerPhone
    ? await loadRecentTurns(tenantId, opts.ownerPhone, opts.connectionId)
    : '';
  if (agenda.length > 0) {
    logger.info(`Lembretes: parse com ${agenda.length} item(ns) do caderno no contexto.`);
  }
  const result = await complete(
    {
      system: buildSystemPrompt(now, tz, persona, true, agenda, memoryBlock, recentTurns),
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
      // Mais itens = mais tokens; ainda modesto. O orquestrador dobra se truncar.
      maxTokens: 900,
      temperature: 0,
    },
    tenantId,
    { meter: true },
  );
  if (!result) {
    logger.warn('Lembretes: nenhuma IA disponível para interpretar a mensagem.');
    return fallbackCreateFromText(message, now, tz, agenda);
  }

  const rawItems = extractJsonArray(result.text);
  if (!rawItems) {
    logger.warn(`Lembretes: resposta da IA não era JSON — "${result.text.slice(0, 120)}"`);
    return fallbackCreateFromText(message, now, tz, agenda);
  }

  if (rawItems.length > MAX_BULK) {
    logger.warn(`Lembretes: ${rawItems.length} itens recebidos — cortando para ${MAX_BULK}.`);
  }

  const out: ParsedReminder[] = [];
  for (const raw of rawItems.slice(0, MAX_BULK)) {
    const parsed = parsedSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`Lembretes: item fora do formato — ${parsed.error.issues[0]?.message}`);
      continue;
    }
    const resolved = resolveParsed(parsed.data, now, tz, agenda, message);
    if (resolved) out.push(resolved);
  }
  if (out.length === 0) {
    logger.warn(
      `Lembretes: IA não devolveu item utilizável (${rawItems.length} bruto(s)) para "${message.slice(0, 90)}" — caindo no fallback.`,
    );
    return fallbackCreateFromText(message, now, tz, agenda);
  }
  return expandReminderUpdates(out, agenda, now, tz);
}

/** Próxima vez que dá esse horário (hoje se ainda vem, senão amanhã). */
function nextOccurrenceOfClock(hour: number, minute: number, now: Date, tz: string): Date {
  const wc = toWallClock(now, tz);
  const at = fromWallClock({ year: wc.year, month: wc.month, day: wc.day, hour, minute }, tz);
  if (at.getTime() > now.getTime() + 30_000) return at;
  return fromWallClock({ year: wc.year, month: wc.month, day: wc.day + 1, hour, minute }, tz);
}

/**
 * TODOS os horários citados na frase — "despertar 1h59 da madrugada, 2h49 da
 * madrugada, 3h59 e 4h45". A IA às vezes devolve lista vazia nesses pedidos
 * múltiplos; aqui o código extrai sozinho, sem depender dela.
 */
export function extractClockTimes(text: string, now: Date, tz: string): Date[] {
  const n = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const re = /\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/g;
  const out: Date[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(n)) !== null) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour > 23 || minute > 59) continue;
    const depois = n.slice(m.index + m[0].length, m.index + m[0].length + 26);
    const periodo = depois.match(/^[\s,]*(?:da|de|pela)?\s*(madrugada|manha|tarde|noite)/)?.[1];
    if ((periodo === 'tarde' || periodo === 'noite') && hour > 0 && hour < 12) hour += 12;
    else if (periodo === 'noite' && hour === 12) hour = 0;
    const chave = `${hour}:${minute}`;
    if (seen.has(chave)) continue;
    seen.add(chave);
    out.push(nextOccurrenceOfClock(hour, minute, now, tz));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

function fallbackCreateFromText(
  message: string,
  now: Date,
  tz: string,
  agenda: Reminder[],
): ParsedReminder[] {
  // Vários horários na mesma fala → um compromisso por horário.
  const horarios = extractClockTimes(message, now, tz);
  if (horarios.length >= 2) {
    const task = guessTaskFromText(message);
    logger.info(
      `Lembretes: ${horarios.length} horários extraídos da frase (fallback múltiplo) — "${task}"`,
    );
    return expandReminderUpdates(
      horarios.map((quando) => ({
        task,
        category: 'data_especifica' as const,
        recurrence: null,
        nextFireAt: quando,
        leadMinutes: null,
        confirmationText: `Anotei: ${task} — ${formatForOwner(quando, tz)}`,
        action: 'create' as const,
      })),
      agenda,
      now,
      tz,
    );
  }

  const inferred = inferDueAtFromText(message, now, tz);
  if (!inferred) return [];
  const task = guessTaskFromText(message);
  logger.info(`Lembretes: due_at inferido da frase (${formatForOwner(inferred, tz)}) — "${task}"`);
  return expandReminderUpdates(
    [
      {
        task,
        category: 'data_especifica',
        recurrence: null,
        nextFireAt: inferred,
        leadMinutes: null,
        confirmationText: `Anotei: ${task} — ${formatForOwner(inferred, tz)}`,
        action: 'create',
      },
    ],
    agenda,
    now,
    tz,
  );
}

function guessTaskFromText(text: string): string {
  const cleaned = foldPt(text)
    .replace(
      /\b(opa|ok|oi|preciso que|quando for umas|me lembre|me lembra|lembr[ae]\w*|anota(?:r)?|agenda(?:r)?|hoje|amanha|da noite|da manha|da tarde|horas?)\b/g,
      ' ',
    )
    .replace(/\b(?:as|a)?\s*\d{1,2}\s*(?:h|:)?\s*\d{0,2}\b/g, ' ')
    .replace(/\b(?:dia\s+)?\d{1,2}\s+de\s+\w+(?:\s+de\s+\d{4})?\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(para|pra|de|do|da|um|uma|o|a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3) return 'Compromisso';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Se o modelo mandou um update sem caderno_n e a task casa com vários
 * (ex.: todos os "despertar"), aplica o mesmo relógio novo em cada um.
 */
export function expandReminderUpdates(
  parsed: ParsedReminder[],
  agenda: Reminder[],
  now: Date,
  tz: string,
): ParsedReminder[] {
  const out: ParsedReminder[] = [];
  for (const item of parsed) {
    if (item.action !== 'update' || item.existingId) {
      out.push(item);
      continue;
    }
    const hits = matchRemindersByTask(item.task, agenda);
    if (hits.length === 0) {
      out.push(item);
      continue;
    }
    if (hits.length === 1) {
      const h = hits[0]!;
      out.push({
        ...item,
        existingId: h.id,
        task: h.task,
        recurrence: item.recurrence ?? h.recurrence,
        leadMinutes: item.leadMinutes ?? h.lead_minutes,
      });
      continue;
    }
    const wcNew = toWallClock(item.nextFireAt, tz);
    for (const h of hits) {
      const wcOld = toWallClock(new Date(h.next_fire_at), h.timezone || tz);
      const candidate = fromWallClock(
        { year: wcOld.year, month: wcOld.month, day: wcOld.day, hour: wcNew.hour, minute: wcNew.minute },
        h.timezone || tz,
      );
      const recurrence = item.recurrence ?? h.recurrence;
      const nextFireAt = bumpUntilFuture(candidate, now, h.timezone || tz, recurrence);
      out.push({
        ...item,
        existingId: h.id,
        task: h.task,
        recurrence,
        nextFireAt,
        leadMinutes: item.leadMinutes ?? h.lead_minutes,
        confirmationText:
          `${item.confirmationText.split('\n')[0]}\n${formatForOwner(nextFireAt, h.timezone || tz)}` +
          `${recurrence ? ` · repete ${describeRecurrence(recurrence)}` : ''}`,
      });
    }
  }
  return out;
}

const WEEKDAY_PT: Record<string, string> = {
  MON: 'toda segunda',
  TUE: 'toda terça',
  WED: 'toda quarta',
  THU: 'toda quinta',
  FRI: 'toda sexta',
  SAT: 'todo sábado',
  SUN: 'todo domingo',
};

export function describeRecurrence(rule: string): string {
  const r = rule.toLowerCase();
  if (r === 'daily') return 'todo dia';
  const weekly = r.match(/^weekly:([a-z]{3})$/);
  if (weekly) return WEEKDAY_PT[weekly[1].toUpperCase()] ?? rule;
  const monthly = r.match(/^monthly:(\d{1,2})$/);
  if (monthly) return `todo dia ${monthly[1]}`;
  const every = r.match(/^every:(\d+)d$/);
  if (every) {
    const n = Number(every[1]);
    return n === 2 ? 'um dia sim, um dia não' : `a cada ${n} dias`;
  }
  return rule;
}
