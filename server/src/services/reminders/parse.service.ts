import { z } from 'zod';
import { logger } from '../../config/logger';
import { complete } from '../ai/orchestrator';
import { getReminderPersona } from '../../db/queries/settings';
import type { ReminderCategory } from '../../types';
import { DEFAULT_TZ, formatForOwner, isValidRecurrence, parseLocalIso, toWallClock, weekdayNamePt } from './time';

/**
 * Interpretação do lembrete em linguagem natural. Usa o orquestrador de IA da
 * empresa (com failover) — nunca um SDK cru.
 *
 * A data relativa é resolvida pelo MODELO, mas com a data/hora atual injetada
 * no prompt: sem isso ele chuta "hoje" a partir do treino. E o horário volta
 * como relógio de parede, convertido aqui para UTC no fuso do dono.
 */

const parsedSchema = z.object({
  task: z.string().trim().min(1).max(500),
  type: z.enum(['unico', 'recorrente']),
  due_at: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  remind_before_minutes: z.coerce.number().int().nullable().optional(),
  category: z.enum(['importante', 'rotina', 'data_especifica']),
  confirmation_text: z.string().trim().min(1).max(400),
});

export interface ParsedReminder {
  task: string;
  category: ReminderCategory;
  recurrence: string | null;
  nextFireAt: Date;
  /** Minutos de aviso prévio, quando o dono pediu ("1h antes" = 60). */
  leadMinutes: number | null;
  confirmationText: string;
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

function buildSystemPrompt(now: Date, tz: string, persona?: string | null, bulk = false): string {
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
    formatLine,
    '{',
    '  "task": "só a ação/assunto, curto (ex.: Ir dormir, Pagar fornecedor) — SEM a palavra lembrete",',
    '  "type": "unico" | "recorrente",',
    '  "due_at": "YYYY-MM-DDTHH:mm do PRIMEIRO disparo (sempre preencha, inclusive se for recorrente)",',
    '  "recurrence": "daily | weekly:MON..SUN | monthly:N — apenas se recorrente, senão null",',
    '  "remind_before_minutes": "minutos de aviso ANTECIPADO se o usuário pediu, senão null",',
    '  "category": "importante" | "rotina" | "data_especifica",',
    '  "confirmation_text": "1 frase humana confirmando o que anotou (ex.: Anotei: ir dormir amanhã às 22h)"',
    '}',
    '',
    'Regras de task e confirmation_text:',
    '- task NUNCA começa com "Lembrete", "Lembrar de" genérico ou "Aviso:"; só o que fazer.',
    '- confirmation_text NÃO usa "lembrete cadastrado", "agendei", "sistema" nem se apresenta como IA.',
    '',
    'Regras de data, sempre a partir do agora informado acima:',
    '- "hoje" é a data de hoje; "amanhã" é o dia seguinte.',
    '- Um dia da semana ("quinta") é a próxima ocorrência dele; se hoje é esse dia e o horário já passou, é o da semana seguinte.',
    '- "dia N" é o dia N deste mês, ou do próximo se já passou.',
    '- "daqui a X dias" é hoje + X dias.',
    // Sem esta linha o modelo tende a arredondar "daqui a 5 minutos" para o dia
    // seguinte — e é assim que qualquer pessoa testa o recurso pela primeira vez.
    '- "daqui a X minutos" / "daqui a X horas" / "em X min" é o horário de agora + X, no MESMO dia.',
    '- "toda segunda" = weekly:MON; "todo dia N" = monthly:N; "todo dia" = daily.',
    '- Sem horário explícito, use 09:00 e diga isso no confirmation_text.',
    '- NUNCA use fuso ou "Z" no due_at: escreva a hora como o usuário leria no relógio dele.',
    '- Se a mensagem for ambígua, escolha a interpretação mais provável e explique-a no confirmation_text.',
    '',
    'Aviso antecipado (remind_before_minutes): só preencha se o usuário pedir explicitamente.',
    '- "me avise 1 hora antes" = 60; "meia hora antes" = 30; "avise na véspera" ou "um dia antes" = 1440.',
    '- O due_at continua sendo o horário DO COMPROMISSO, nunca o do aviso antecipado.',
    '- Sem pedido de aviso prévio, use null.',
    '',
    'Categorias: "importante" para pagamentos/prazos críticos; "rotina" para hábitos repetidos;',
    '"data_especifica" para compromissos pontuais.',
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
 * due_at, data no passado, etc.) — o item é simplesmente ignorado.
 */
function resolveParsed(data: z.infer<typeof parsedSchema>, now: Date, tz: string): ParsedReminder | null {
  if (!data.due_at) {
    logger.warn('Lembretes: IA não devolveu due_at.');
    return null;
  }

  const nextFireAt = parseLocalIso(data.due_at, tz);
  if (!nextFireAt) {
    logger.warn(`Lembretes: due_at inválido — "${data.due_at}"`);
    return null;
  }

  // A IA às vezes calcula um horário que já passou (ex.: "às 8h" quando são 9h).
  // Salvar assim faria o agendador disparar no mesmo minuto.
  if (nextFireAt.getTime() <= now.getTime()) {
    logger.warn(`Lembretes: due_at no passado (${data.due_at}) — descartado.`);
    return null;
  }

  let recurrence: string | null = null;
  if (data.type === 'recorrente' && data.recurrence) {
    const rule = data.recurrence.trim().toLowerCase();
    if (isValidRecurrence(rule)) recurrence = rule;
    else logger.warn(`Lembretes: recorrência não reconhecida — "${data.recurrence}" (salvando como único).`);
  }

  // Antecedência: descartada se não couber antes do próprio compromisso — avisar
  // "1 dia antes" de algo que é daqui a 2h não faz sentido e o toque prévio
  // nunca dispararia.
  let leadMinutes: number | null = null;
  const rawLead = data.remind_before_minutes ?? null;
  if (rawLead && rawLead > 0) {
    const clamped = Math.min(rawLead, MAX_LEAD_MINUTES);
    const fitsBeforeNow = nextFireAt.getTime() - clamped * 60_000 > now.getTime();
    if (fitsBeforeNow) leadMinutes = clamped;
    else logger.warn(`Lembretes: aviso de ${clamped}min antes não cabe até o compromisso — ignorado.`);
  }

  const task = stripReminderLabel(data.task);
  return {
    task,
    category: data.category,
    recurrence,
    nextFireAt,
    leadMinutes,
    // Anexamos a data resolvida: é a checagem que o dono realmente precisa ver
    // antes de confirmar, e não dá para confiar que o modelo a escreveu certo.
    confirmationText:
      `${data.confirmation_text}\n${formatForOwner(nextFireAt, tz)}` +
      `${recurrence ? ` · repete ${describeRecurrence(recurrence)}` : ''}` +
      `${leadMinutes ? `\nTe aviso ${describeLead(leadMinutes)}` : ''}`,
  };
}

/** Evita task tipo "Lembrete: ir dormir" — no disparo deve sair só "Ir dormir". */
function stripReminderLabel(task: string): string {
  return task
    .replace(/^(lembrete|aviso|alerta)\s*[:\-–—]?\s*/i, '')
    .replace(/^lembrar\s+de\s+/i, '')
    .trim() || task.trim();
}

/**
 * Interpreta a mensagem do dono. Retorna null quando a IA não está disponível
 * ou devolveu algo que não dá para confiar — o chamador então pede o texto de
 * outro jeito, em vez de salvar um lembrete errado.
 */
export interface ParseReminderOptions {
  /** Persona a usar no lugar da salva (playground do painel). */
  personaOverride?: string | null;
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
  const result = await complete(
    {
      system: buildSystemPrompt(now, tz, persona),
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
    return null;
  }

  const parsed = parsedSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn(`Lembretes: JSON da IA fora do formato — ${parsed.error.issues[0]?.message}`);
    return null;
  }

  return resolveParsed(parsed.data, now, tz);
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
): Promise<ParsedReminder[]> {
  const now = new Date();
  const persona = await getReminderPersona(tenantId);
  const result = await complete(
    {
      system: buildSystemPrompt(now, tz, persona, true),
      messages: [{ role: 'user', content: message.slice(0, 2000) }],
      // Mais itens = mais tokens; ainda modesto. O orquestrador dobra se truncar.
      maxTokens: 900,
      temperature: 0,
    },
    tenantId,
    { meter: true },
  );
  if (!result) {
    logger.warn('Lembretes: nenhuma IA disponível para interpretar a mensagem.');
    return [];
  }

  const rawItems = extractJsonArray(result.text);
  if (!rawItems) {
    logger.warn(`Lembretes: resposta da IA não era JSON — "${result.text.slice(0, 120)}"`);
    return [];
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
    const resolved = resolveParsed(parsed.data, now, tz);
    if (resolved) out.push(resolved);
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
  return rule;
}
