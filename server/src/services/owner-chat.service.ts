import { logger } from '../config/logger';
import { complete, hasVisionProvider } from './ai/orchestrator';
import { isWebSearchToolAvailable } from './ai/tools';
import type { ChatImage, ChatMessage } from './ai/types';
import { getReminderPersona } from '../db/queries/settings';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import {
  appendOwnerChatMessage,
  listOwnerChatHistory,
} from '../db/queries/owner_chat_messages';
import { loadOwnerAgenda } from './reminders/parse.service';
import { formatForOwner, DEFAULT_TZ } from './reminders/time';
import {
  buildOwnerMemoryPromptBlock,
  scheduleOwnerMemoryExtract,
} from './owner-memory.service';

/**
 * Modo Agente do dono: chat livre no WhatsApp.
 * Histórico no Postgres (tempo real) + caderno de eventos + debounce.
 */

/** Modo rápido: poucas tokens, resposta curta no WhatsApp. */
const FAST_MAX_TOKENS = 280;
const VISION_MAX_TOKENS = 500;
const FAST_TEMPERATURE = 0.2;
/** Espera msgs extras do dono antes de chamar a IA (anti-perda). */
const BATCH_DEBOUNCE_MS = 1600;
const HISTORY_LIMIT = 80;

const OWNER_VISION_HINT =
  '\n\nATENÇÃO — O DONO ENVIOU IMAGEM/VÍDEO. Analise o que aparece na mídia e responda com base nisso. ' +
  'Descreva o que vê com clareza; se ele pediu opinião ou ação, use o que enxergou. Não diga que não consegue ver fotos.';

export interface FreeChatOptions {
  connectionId?: string | null;
  /** Busca web ligada nesta conexão. */
  webSearchEnabled?: boolean;
  /** Imagens/quadros para visão (anexados ao último turno user). */
  images?: ChatImage[];
}

/** `merged` = outra mensagem do lote já gerou a resposta; não envie de novo. */
export type FreeChatResult =
  | { status: 'reply'; text: string | null }
  | { status: 'merged' };

interface BatchState {
  timer: NodeJS.Timeout;
  opts: FreeChatOptions;
  waiters: Array<(r: FreeChatResult) => void>;
}

const batches = new Map<string, BatchState>();
const processing = new Set<string>();

function batchKey(tenantId: string, phone: string, connectionId?: string | null): string {
  return `${tenantId}:${phone}:${connectionId ?? ''}`;
}

function buildFastSystem(
  persona: string | null | undefined,
  agendaLines: string[],
  memoryBlock: string,
  webSearchOn: boolean,
  toolSearchAvailable: boolean,
): string {
  const parts = [
    'Você fala com o DONO no WhatsApp — como um assistente humano rápido (estilo Claude), não como robô.',
    'Respostas CURTAS (WhatsApp): no máximo ~6 linhas; bullets quando ajudar.',
    'Nunca diga que é IA/bot. Não invente compromissos: agenda real está abaixo.',
    'Leitura completa: use o histórico + a memória interpretada (eventos, histórias, acontecimentos, problemas).',
    'Interprete o sentido do que o dono diz — não dependa de palavras-chave; entenda contexto e continuidade.',
    'Se o dono mandou várias mensagens seguidas sem sua resposta, trate como UM pedido contínuo — leia todas, interprete o conjunto e responda uma vez sem se perder.',
    'Se pedirem para anotar/lembrar algo com data, diga pra mandar tipo "me lembra amanhã às 9h de…".',
    webSearchOn && toolSearchAvailable
      ? [
          'Você TEM a ferramenta web_search (function calling).',
          'Use web_search quando precisar de fato atual (cotação, notícia, horário, algo após seu conhecimento).',
          'Cite a fonte em 1 linha. NUNCA peça chave de API / Tavily / configuração de servidor.',
          'Se a tool não trouxer resultado, diga que não achou fonte atual — sem inventar.',
        ].join(' ')
      : webSearchOn
        ? 'Busca na web está ligada na alavanca, mas a tool ainda não tem chave no servidor. Responda o que souber com cautela; NÃO peça API key.'
        : 'Busca na web está desligada. Se pedirem pesquisa, diga pra ligar a alavanca "Busca na web" em Lembretes.',
    persona?.trim() ? `Tom:\n${persona.trim()}` : '',
    agendaLines.length
      ? `Caderno de compromissos (próximos dias):\n${agendaLines.join('\n')}`
      : 'Caderno de compromissos: (vazio por enquanto).',
    memoryBlock,
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
  // Modelo precisa terminar com user
  while (out.length && out[out.length - 1]!.role !== 'user') out.pop();
  return out.slice(-48);
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

async function runFreeChatOnce(
  tenantId: string,
  phone: string,
  opts: FreeChatOptions,
): Promise<string | null> {
  const tz = DEFAULT_TZ;
  const persona = await getReminderPersona(tenantId, opts.connectionId);
  const agenda = await loadOwnerAgenda(tenantId, phone, tz);
  const agendaLines = agenda.slice(0, 12).map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
    return `${i + 1}. ${r.task} — ${when}`;
  });

  const hasImages = Boolean(opts.images?.length);
  if (hasImages && !(await hasVisionProvider(tenantId, opts.connectionId))) {
    return 'Recebi a foto, mas nenhuma IA com visão está ligada agora. Me descreve o que tem nela?';
  }

  const [dbRows, memoryBlock] = await Promise.all([
    listOwnerChatHistory(tenantId, phone, {
      connectionId: opts.connectionId,
      limit: HISTORY_LIMIT,
    }),
    buildOwnerMemoryPromptBlock(tenantId, phone, opts.connectionId),
  ]);
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

  // Busca via function calling (fase 3): o modelo decide quando chamar web_search.
  const webSearchOn = Boolean(opts.webSearchEnabled);
  const toolSearchAvailable = webSearchOn && isWebSearchToolAvailable() && !hasImages;

  const system =
    buildFastSystem(
      persona,
      agendaLines,
      memoryBlock,
      webSearchOn,
      toolSearchAvailable,
    ) + (hasImages ? OWNER_VISION_HINT : '');

  const result = await complete(
    {
      system,
      messages,
      maxTokens: hasImages ? VISION_MAX_TOKENS : FAST_MAX_TOKENS,
      temperature: FAST_TEMPERATURE,
    },
    tenantId,
    {
      meter: true,
      connectionId: opts.connectionId,
      tools: toolSearchAvailable,
    },
  );

  if (!result?.text?.trim()) {
    logger.warn('Agente: nenhuma resposta da IA.');
    return null;
  }

  return result.text.trim().slice(0, 4000);
}

async function flushBatch(tenantId: string, phone: string, k: string): Promise<void> {
  const batch = batches.get(k);
  if (!batch) return;
  batches.delete(k);

  if (processing.has(k)) {
    // Ainda gerando resposta anterior: reencaixa waiters e espera um pouco.
    const again = batches.get(k) ?? {
      timer: setTimeout(() => void flushBatch(tenantId, phone, k), 400),
      opts: batch.opts,
      waiters: [] as Array<(r: FreeChatResult) => void>,
    };
    clearTimeout(again.timer);
    again.waiters.push(...batch.waiters);
    again.opts = batch.opts;
    again.timer = setTimeout(() => void flushBatch(tenantId, phone, k), 400);
    batches.set(k, again);
    return;
  }

  processing.add(k);
  let text: string | null = null;
  try {
    text = await runFreeChatOnce(tenantId, phone, batch.opts);
  } catch (err) {
    logger.warn('Agente: falha ao gerar resposta', err);
    text = null;
  } finally {
    processing.delete(k);
  }

  batch.waiters[0]?.({ status: 'reply', text });
  for (let i = 1; i < batch.waiters.length; i++) {
    batch.waiters[i]!({ status: 'merged' });
  }

  // Mensagens que chegaram durante o processamento
  if (batches.has(k)) {
    const pending = batches.get(k)!;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => void flushBatch(tenantId, phone, k), 300);
  }
}

/**
 * Persiste a mensagem do dono (tempo real) e agenda resposta com debounce.
 * Várias msgs rápidas → um único reply coerente; waiters extras recebem `merged`.
 */
export async function freeChatOwner(
  tenantId: string,
  phone: string,
  message: string,
  opts: FreeChatOptions = {},
): Promise<FreeChatResult> {
  const trimmed = message.trim();
  if (!trimmed && !opts.images?.length) return { status: 'reply', text: null };

  // Mensagem do dono já deve estar em owner_chat_messages (handler).
  const k = batchKey(tenantId, phone, opts.connectionId);
  // Com imagem: responde mais rápido (sem esperar lote longo).
  const waitMs = opts.images?.length ? 400 : BATCH_DEBOUNCE_MS;

  return new Promise<FreeChatResult>((resolve) => {
    const existing = batches.get(k);
    if (existing) {
      clearTimeout(existing.timer);
      existing.waiters.push(resolve);
      existing.opts = {
        ...opts,
        images: [...(existing.opts.images ?? []), ...(opts.images ?? [])],
        webSearchEnabled: opts.webSearchEnabled ?? existing.opts.webSearchEnabled,
        connectionId: opts.connectionId ?? existing.opts.connectionId,
      };
      existing.timer = setTimeout(() => void flushBatch(tenantId, phone, k), waitMs);
      return;
    }
    batches.set(k, {
      opts,
      waiters: [resolve],
      timer: setTimeout(() => void flushBatch(tenantId, phone, k), waitMs),
    });
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

/** Flags efetivos da conexão (defaults: secretária ON, agente OFF, busca OFF). */
export async function getOwnerModeFlags(
  tenantId: string,
  connectionId?: string | null,
): Promise<{ secretary: boolean; agent: boolean; webSearch: boolean }> {
  if (!connectionId) {
    return { secretary: true, agent: false, webSearch: false };
  }
  const conn = await getConnectionById(tenantId, connectionId);
  return {
    secretary: conn?.owner_secretary_enabled !== false,
    agent: conn?.owner_free_chat_enabled === true,
    webSearch: conn?.owner_web_search_enabled === true,
  };
}
