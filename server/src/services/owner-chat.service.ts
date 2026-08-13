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
  executeWebSearch,
  isWebSearchToolAvailable,
  registryAsRequestFields,
} from './ai/tools';
import type { ChatImage, ChatMessage } from './ai/types';
import { getReminderPersona, getSecretaryPlaybook } from '../db/queries/settings';
import { getConnectionById } from '../db/queries/whatsapp_connections';
import {
  appendOwnerChatMessage,
  listOwnerChatHistory,
} from '../db/queries/owner_chat_messages';
import { loadOwnerAgenda } from './reminders/parse.service';
import { formatForOwner, DEFAULT_TZ } from './reminders/time';
import { applySecretaryPlaybookToText, formatSecretaryPlaybook } from './secretary-playbook.service';

/**
 * Modo Agente do dono: chat livre no WhatsApp.
 * Histórico no Postgres (tempo real) + caderno de eventos + fila por turno.
 */

/** Modo rápido: poucas tokens, resposta curta no WhatsApp. */
const FAST_MAX_TOKENS = 280;
const TOOLS_MAX_TOKENS = 900;
const VISION_MAX_TOKENS = 500;
const FAST_TEMPERATURE = 0.2;
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
  /** Fala atual do dono (pra emoji pedido nesta mensagem, etc.). */
  lastUserMessage?: string | null;
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

function buildFastSystem(
  persona: string | null | undefined,
  agendaLines: string[],
  memoryBlock: string,
  webSearchOn: boolean,
  toolSearchAvailable: boolean,
  contactToolsOn: boolean,
  playbookBlock: string,
): string {
  const parts = [
    'Você fala com o DONO no WhatsApp — como um assistente humano rápido (estilo Claude), não como robô.',
    'Respostas CURTAS (WhatsApp): no máximo ~6 linhas; bullets quando ajudar.',
    'Nunca diga que é IA/bot. Não invente compromissos: agenda real está abaixo.',
    'Emojis: você conhece TODOS. Se pedirem "emoji de coração", mande ❤️. De foguete, 🚀. De gato, 🐱. Qualquer nome ou o próprio emoji colado. Se pedirem só o emoji, responda SÓ com ele — sem frase.',
    'Leitura completa: use o histórico + a memória interpretada (eventos, histórias, acontecimentos, problemas) + os contatos que o dono JÁ ESCOLHEU + o que você leu nas conversas e buscou na internet.',
    'Interprete o sentido do que o dono diz — não dependa de palavras-chave; entenda contexto e continuidade. Raciocine com o que já sabe; não peça de novo o que já está na memória.',
    playbookBlock,
    'No WhatsApp o dono costuma quebrar o mesmo pedido em vários balões seguidos. Vários user seguidos sem a sua resposta no meio são UM pedido só — junte o sentido e execute uma vez. Não peça para repetir o que já está nesses balões.',
    'Se nesta mensagem (já juntada) houver VÁRIOS pedidos distintos (ex.: "manda oi pro João e pesquisa o dólar"), faça TODOS em sequência com as tools, um a um, e confirme cada um em 1 linha.',
    'Nunca ignore um pedido desta fala. Nunca misture com um pedido antigo já respondido.',
    'Se pedirem para anotar/lembrar algo com data (só pra ele), diga pra mandar tipo "me lembra amanhã às 9h de…".',
    contactToolsOn
      ? [
          'Você TEM acesso às conversas e aos contatos do WhatsApp business via tools:',
          'buscar_contato, ler_conversa_contato, listar_produtos, enviar_mensagem_contato, orientar_atendimento_contato, agendar_mensagem_contato, avisar_quando_contato_falar, responder_contato.',
          'NUNCA diga que não tem acesso às conversas — você LÊ com ler_conversa_contato e FALA com enviar_mensagem_contato.',
          'Áudio e foto/vídeo do contato aparecem transcritos ou descritos em ler_conversa_contato. Trate esse texto como o que a pessoa FALOU ou MOSTROU — responda com a mesma precisão de quando o dono te manda áudio ou foto.',
          'Quando o dono quiser ser AVISADO que alguém falou com este WhatsApp, use avisar_quando_contato_falar — em QUALQUER formulação, não só a frase pronta. Exemplos que são o MESMO pedido: "me avisa quando o Wender mandar mensagem", "quando o Wender chamar", "se a Maria falar me avisa", "me chama quando o João mandar zap", "avisa se o Pedro aparecer". Extraia o NOME e chame a tool (todos=false). Se citar o FINAL do número ("Jurandir final 3934", "o do 3934"), passe nome COM os dígitos ("Jurandir 3934") e NÃO pergunte qual contato — escolha o telefone que TERMINA com esses dígitos. Se disser "sempre que o X…", modo always; senão always também, salvo se pedir só a próxima. todos=true SOMENTE se pedir de qualquer pessoa / alguém / todo mundo SEM citar um nome. NUNCA use todos=true se houver um contato específico. Para parar um nome: acao=cancelar + nome. Para parar o geral: acao=cancelar + todos=true. Lista: acao=listar.',
          'Quando o dono pedir PARA DE RESPONDER / não fala mais com / não atende X: use responder_contato acao=parar + nome. Isso NÃO cancela o aviso (avisar_quando_contato_falar). Voltar a responder: acao=voltar. NUNCA trate "para de responder a esposa" como cancelar aviso.',
          'Quando o dono pedir "converse com X", "fala com o Wender", "atende ele", "responde o cliente":',
          '1) buscar_contato (se precisar) 2) ler_conversa_contato 3) se o contato pediu busca/fato atual, use web_search AGORA',
          '4) montar resposta útil (com o resultado da busca, se houver) 5) enviar_mensagem_contato',
          '6) orientar_atendimento_contato com o objetivo do dono para a IA do negócio CONTINUAR nas próximas msgs do contato.',
          'Se o contato pediu pesquisa na internet: NÃO ignore — pesquise com web_search e mande o resultado pra ele.',
          'Fluxo venda: listar_produtos → ler_conversa se já houver fio → texto humano → enviar + orientar.',
          'Fluxo rotina: agendar_mensagem_contato com quando=YYYY-MM-DDTHH:mm e recorrencia se pedir.',
          'Se o nome JÁ ESTIVER em CONTATOS QUE O DONO JÁ ESCOLHEU, use esse client_id e NÃO pergunte qual é. Só mostre lista se o nome NÃO estiver na memória e não houver final de telefone. Se 1 contato claro OU o dono já deu o final do número, aja na hora.',
          'Confirme ao dono em 1–2 linhas o que leu/enviou. Nunca invente envio sem OK da tool.',
        ].join(' ')
      : '',
    webSearchOn && toolSearchAvailable
      ? [
          'Você TEM a ferramenta web_search (function calling).',
          'Use SOMENTE se o dono (ou o contato, quando você estiver atendendo por ele) pedir fato atual (cotação, notícia, horário, pesquisa na internet).',
          'NÃO pesquise em conversa rotineira, lembrete, contato ou raciocínio próprio — responda direto.',
          'Cite a fonte em 1 linha. NUNCA peça chave de API / Tavily / configuração de servidor.',
          'Se a tool não trouxer resultado, diga que não achou fonte atual — sem inventar.',
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
  const playbookBlock = formatSecretaryPlaybook(
    await getSecretaryPlaybook(tenantId, opts.connectionId),
    phone,
    null,
    opts.lastUserMessage,
  );
  const agenda = await loadOwnerAgenda(tenantId, phone, tz);
  const agendaLines = agenda.slice(0, 12).map((r, i) => {
    const when = formatForOwner(new Date(r.next_fire_at), r.timezone || tz);
    return `${i + 1}. ${r.task} — ${when}`;
  });

  const hasImages = Boolean(opts.images?.length);
  if (hasImages && !(await hasVisionProvider(tenantId, opts.connectionId))) {
    return 'Recebi a foto, mas nenhuma IA com visão está ligada agora. Me descreve o que tem nela?';
  }

  const [dbRows, memoryBlock, aliasBlock] = await Promise.all([
    listOwnerChatHistory(tenantId, phone, {
      connectionId: opts.connectionId,
      limit: HISTORY_LIMIT,
    }),
    buildOwnerMemoryPromptBlock(tenantId, phone, opts.connectionId),
    buildContactAliasPromptBlock(tenantId, phone, opts.connectionId),
  ]);
  const contextBlock = [memoryBlock, aliasBlock].filter(Boolean).join('\n\n');
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

  // Tools do dono (contatos/venda/agenda) + web_search opcional.
  // Com imagem: só visão (sem tools) — adapters focam na mídia.
  const webSearchOn = Boolean(opts.webSearchEnabled);
  const toolSearchAvailable = webSearchOn && isWebSearchToolAvailable() && !hasImages;
  const contactToolsOn = !hasImages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ownerTools = contactToolsOn
    ? registryAsRequestFields(
        buildOwnerToolRegistry({
          tenantId,
          ownerPhone: phone,
          connectionId: opts.connectionId,
          lastUserMessage: typeof lastUser?.content === 'string' ? lastUser.content : null,
        }),
      )
    : { tools: [], toolExecutors: {} };

  const toolExecutors = { ...ownerTools.toolExecutors };
  if (toolSearchAvailable) {
    toolExecutors.web_search = async (input: unknown) => {
      const query =
        input && typeof input === 'object' && 'query' in input
          ? String((input as { query: unknown }).query ?? '').trim()
          : '';
      const out = await executeWebSearch(input);
      if (query && out && !out.startsWith('Nenhum resultado')) {
        void recordOwnerEvent({
          tenantId,
          ownerPhone: phone,
          kind: 'fato',
          summary: `Pesquisa na internet: ${query.slice(0, 80)} — ${out.replace(/\s+/g, ' ').slice(0, 160)}`,
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
    ) + (hasImages ? OWNER_VISION_HINT : '');

  const maxTokens = hasImages
    ? VISION_MAX_TOKENS
    : contactToolsOn
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

  return result.text.trim().slice(0, 4000);
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
      text = await applySecretaryPlaybookToText({
        tenantId,
        connectionId: job.opts.connectionId,
        toPhone: phone,
        text,
        lastUserMessage: job.opts.lastUserMessage,
      });
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
