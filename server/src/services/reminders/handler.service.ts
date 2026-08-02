import { logger } from '../../config/logger';
import {
  cancelReminder,
  completeReminder,
  createReminder,
  listReminders,
  type ListRemindersFilter,
} from '../../db/queries/reminders';
import { env } from '../../config/env';
import { getTenantWhatsapp } from '../whatsapp.service';
import { transcribeAudioFromBase64, transcribeAudioFromUrl } from '../transcription.service';
import type { NormalizedInbound } from '../whatsapp/types';
import type { Reminder } from '../../types';
import { describeRecurrence, parseReminder } from './parse.service';
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

/** Estado curto por dono: confirmação pendente e a última lista exibida. */
interface OwnerState {
  at: number;
  pending?: {
    task: string;
    category: Reminder['category'];
    recurrence: string | null;
    nextFireAt: Date;
    /** Texto original, para o dono poder corrigir sem repetir tudo. */
    source: string;
  };
  lastList?: string[];
}

const STATE_TTL_MS = 15 * 60_000;
const state = new Map<string, OwnerState>();

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
  '🗒️ *Seu assistente de lembretes*',
  '',
  'Para criar, é só falar naturalmente (texto ou áudio):',
  '_"me lembra amanhã às 9h de pagar o fornecedor"_',
  '_"toda sexta cobrar os inadimplentes"_',
  '',
  'Para consultar: *HOJE*, *AMANHÃ*, *SEMANA*, *MÊS*, *ROTINA*, *IMPORTANTES*, *TODOS*',
  'Para fechar: *CONCLUIR 2* · Para remover: *CANCELAR 2*',
  '(o número é o da última lista que eu te mandei)',
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
};

function renderList(reminders: Reminder[], title: string, tz: string): string {
  if (reminders.length === 0) return `Nada em *${title}*. 🎉`;
  const lines = reminders.map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), tz);
    const repeat = r.recurrence ? ` 🔁 ${describeRecurrence(r.recurrence)}` : '';
    const flag = r.category === 'importante' ? '⚠️ ' : '';
    return `${i + 1}. ${flag}${r.task}\n   ${when}${repeat}`;
  });
  return [`🗒️ *${title}*`, '', ...lines, '', '_CONCLUIR N_ ou _CANCELAR N_ para fechar um item._'].join('\n');
}

const CREATE_TRIGGERS = /\b(lembr|anota|agenda|marca|avisa|nao me deixa esquecer|não me deixa esquecer)/i;

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
    if (AFFIRMATIVE.has(normalized)) {
      const p = owner.pending;
      await createReminder(tenantId, {
        ownerPhone: phone,
        task: p.task,
        category: p.category,
        recurrence: p.recurrence,
        nextFireAt: p.nextFireAt,
        timezone: tz,
      });
      setState(tenantId, phone, { pending: undefined });
      await reply(tenantId, phone, `✅ Anotado! Te aviso ${formatForOwner(p.nextFireAt, tz)}.`);
      return true;
    }
    if (NEGATIVE.has(normalized)) {
      setState(tenantId, phone, { pending: undefined });
      await reply(tenantId, phone, 'Beleza, descartei. 👍');
      return true;
    }
    // Qualquer outra coisa é uma CORREÇÃO: reprocessa somando o texto original,
    // para o dono poder dizer só "na verdade às 15h".
    setState(tenantId, phone, { pending: undefined });
    const corrected = `${owner.pending.source}\nCorreção: ${text}`;
    return handleCreate(tenantId, phone, corrected, tz, text);
  }

  // 2. Consulta por palavra-chave — sem IA, resposta imediata.
  const queryKey = QUERY_WORDS[normalized];
  if (queryKey) {
    const filter = rangeFor(queryKey, tz);
    if (filter) {
      const reminders = await listReminders(tenantId, phone, filter);
      setState(tenantId, phone, { lastList: reminders.map((r) => r.id) });
      await reply(tenantId, phone, renderList(reminders, normalized.toUpperCase(), tz));
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
          ? '✅ Marquei como concluído.'
          : '🗑️ Cancelado.'
        : 'Esse lembrete já não estava mais na lista.',
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

async function handleCreate(
  tenantId: string,
  phone: string,
  message: string,
  tz: string,
  originalText: string,
): Promise<boolean> {
  const looksLikeReminder = CREATE_TRIGGERS.test(message);
  const parsed = await parseReminder(tenantId, message, tz);

  if (!parsed) {
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

  setState(tenantId, phone, {
    pending: {
      task: parsed.task,
      category: parsed.category,
      recurrence: parsed.recurrence,
      nextFireAt: parsed.nextFireAt,
      source: originalText,
    },
  });

  await reply(tenantId, phone, `${parsed.confirmationText}\n\nConfirma? (responda *sim* ou me corrija)`);
  return true;
}
