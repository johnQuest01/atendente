import { logger } from '../config/logger';
import { complete } from './ai/orchestrator';
import { getReminderPersona } from '../db/queries/settings';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import { loadOwnerAgenda } from './reminders/parse.service';
import { formatForOwner, DEFAULT_TZ } from './reminders/time';
import {
  formatSearchContext,
  messageLikelyNeedsSearch,
  webSearch,
} from './web-search.service';

/**
 * Modo Agente do dono: chat livre no WhatsApp (estilo Claude), rápido.
 * Isolado da whitelist — o handler já checou isReminderOwner.
 */

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatState {
  at: number;
  turns: ChatTurn[];
}

const HISTORY_TTL_MS = 30 * 60_000;
const MAX_TURNS = 8;
/** Modo rápido: poucas tokens, resposta curta no WhatsApp. */
const FAST_MAX_TOKENS = 220;
const FAST_TEMPERATURE = 0.2;

const history = new Map<string, ChatState>();

function key(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

function getHistory(tenantId: string, phone: string): ChatTurn[] {
  const k = key(tenantId, phone);
  const cur = history.get(k);
  if (!cur || Date.now() - cur.at > HISTORY_TTL_MS) {
    history.set(k, { at: Date.now(), turns: [] });
    return [];
  }
  return cur.turns;
}

function pushHistory(tenantId: string, phone: string, turn: ChatTurn): void {
  const k = key(tenantId, phone);
  const turns = getHistory(tenantId, phone);
  turns.push(turn);
  while (turns.length > MAX_TURNS) turns.shift();
  history.set(k, { at: Date.now(), turns });
}

function buildFastSystem(
  persona: string | null | undefined,
  agendaLines: string[],
  searchBlock: string | null,
  webSearchOn: boolean,
): string {
  const parts = [
    'Você fala com o DONO no WhatsApp — como um assistente humano rápido (estilo Claude), não como robô.',
    'Respostas CURTAS (WhatsApp): no máximo ~6 linhas; bullets quando ajudar.',
    'Nunca diga que é IA/bot. Não invente compromissos: agenda real está abaixo.',
    'Se pedirem para anotar/lembrar algo com data, diga pra mandar tipo "me lembra amanhã às 9h de…".',
    webSearchOn
      ? [
          'Busca na web está LIGADA neste WhatsApp.',
          'Se houver "Resultados da busca" abaixo, USE-OS na resposta (cite a fonte em 1 linha).',
          'NUNCA peça WEB_SEARCH_API_KEY, chave de API, Tavily, nem diga que falta configurar no servidor.',
          'Se a busca não trouxe resultado, diga só que não achou fonte atual — sem falar de configuração.',
        ].join(' ')
      : 'Busca na web está desligada. Se pedirem pesquisa, diga pra ligar a alavanca "Busca na web" em Lembretes.',
    persona?.trim() ? `Tom:\n${persona.trim()}` : '',
    agendaLines.length
      ? `Caderno (próximos dias):\n${agendaLines.join('\n')}`
      : 'Caderno: (vazio por enquanto).',
    searchBlock ?? '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

export interface FreeChatOptions {
  connectionId?: string | null;
  /** Busca web ligada nesta conexão. */
  webSearchEnabled?: boolean;
}

/**
 * Responde em modo Agente. Retorna o texto (caller envia no WhatsApp).
 * Otimizado para velocidade: 1 round de IA (+ no máx. 1 busca).
 */
export async function freeChatOwner(
  tenantId: string,
  phone: string,
  message: string,
  opts: FreeChatOptions = {},
): Promise<string | null> {
  const tz = DEFAULT_TZ;
  const persona = await getReminderPersona(tenantId, opts.connectionId);
  const agenda = await loadOwnerAgenda(tenantId, phone, tz);
  const agendaLines = agenda.slice(0, 12).map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
    return `${i + 1}. ${r.task} — ${when}`;
  });

  let searchBlock: string | null = null;
  const wantsSearch =
    Boolean(opts.webSearchEnabled) &&
    (messageLikelyNeedsSearch(message) ||
      /\b(pesquisa|pesquis|busca|buscar|procure|procura|internet|web)\b/i.test(message));

  if (wantsSearch) {
    const hits = await webSearch(message, 3);
    if (hits?.length) {
      searchBlock = formatSearchContext(hits);
      logger.info(`Agente: busca web com ${hits.length} resultado(s).`);
    } else {
      searchBlock =
        'Resultados da busca: (vazio). Não peça chave de API. Diga que não achou fonte atual e responda o que souber com cautela.';
      logger.warn('Agente: busca web sem resultados.');
    }
  }

  const prior = getHistory(tenantId, phone);
  const messages = [
    ...prior.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message.slice(0, 2000) },
  ];

  const result = await complete(
    {
      system: buildFastSystem(persona, agendaLines, searchBlock, Boolean(opts.webSearchEnabled)),
      messages,
      maxTokens: FAST_MAX_TOKENS,
      temperature: FAST_TEMPERATURE,
    },
    tenantId,
    { meter: true, connectionId: opts.connectionId },
  );

  if (!result?.text?.trim()) {
    logger.warn('Agente: nenhuma resposta da IA.');
    return null;
  }

  const reply = result.text.trim().slice(0, 3500);
  pushHistory(tenantId, phone, { role: 'user', content: message.slice(0, 2000) });
  pushHistory(tenantId, phone, { role: 'assistant', content: reply });
  return reply;
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
