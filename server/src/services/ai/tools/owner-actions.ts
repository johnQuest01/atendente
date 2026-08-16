/**
 * Tools do chat do DONO (secretário/agente): contatos, catálogo, envio e agenda
 * de mensagem para contato. Contexto via closure — não entram no registry global
 * do atendimento ao cliente.
 */

import { getClientById, updateClient } from '../../../db/queries/clients';
import {
  clearHumanPause,
  countMessagesInConversation,
  findOrCreateOpenConversation,
  getRecentMessagesForAI,
  searchConversationMessages,
} from '../../../db/queries/conversations';
import { countOwnerChatMessages, listOwnerChatHistory, searchOwnerChatHistory } from '../../../db/queries/owner_chat_messages';
import { listProducts } from '../../../db/queries/products';
import {
  cancelAllPendingReminders,
  cancelReminder,
  cancelReminderById,
  createReminder,
  findSimilarPendingReminder,
  listReminders,
  listRemindersAboutContact,
  updateOwnerReminder,
} from '../../../db/queries/reminders';
import { formatBRL } from '../../../utils/text';
import {
  DEFAULT_TZ,
  formatForOwner,
  fromWallClock,
  inferIntervalRecurrence,
  isValidRecurrence,
  parseLocalIso,
  toWallClock,
} from '../../reminders/time';
import {
  displayName,
  parseRelayIntent,
  resolveRelayContacts,
  sendOwnerRelay,
} from '../../owner-relay.service';
import type { PlannedSend } from '../../owner-pending';
import {
  bumpUntilFuture,
  describeRecurrence,
  formatCadernoItem,
  loadOwnerAgenda,
  reminderDisplayText,
} from '../../reminders/parse.service';
import { rememberContactChoice } from '../../owner-contact-memory.service';
import { extractPhoneHint } from '../../../utils/phone-hint';
import { describeInboundVisual } from '../../inbound-understand.service';
import { recordOwnerEvent } from '../../owner-memory.service';
import { getOwnerLastList, rememberOwnerLastList } from '../../reminders/owner-last-list';
import {
  extractSearchQuery,
  inferFireAction,
} from '../../reminders/reminder-actions';
import { buildMemoryPromptBlock } from '../../memory.service';
import {
  assertListedOwner,
  cancelWatchForAnyone,
  cancelWatchForContact,
  createWatchForAnyone,
  createWatchForContact,
  formatWatchList,
  looksLikeAnyone,
} from '../../contact-watch.service';
import { resolveMuteContact, setContactAutoReply } from '../../contact-reply.service';
import type { ReminderStatus } from '../../../types';
import type { Tool, ToolExecutor, ToolRegistry } from './types';

export interface OwnerToolContext {
  tenantId: string;
  ownerPhone: string;
  connectionId?: string | null;
  /** Fala atual do dono — pra cruzar "final 3934" mesmo se a tool só mandar o nome. */
  lastUserMessage?: string | null;
  /**
   * Coletor de plano de envio do turno (Fluxo C). Quando presente, enviar_mensagem_contato
   * e agendar_mensagem_contato (envio único) NÃO disparam na hora: acumulam aqui e o código
   * decide no fim do turno (envia direto se verbo claro + 1 contato; senão pede UMA confirmação).
   */
  plan?: { sends: PlannedSend[] };
}

export interface OwnerToolRegistryOpts {
  /** Tools de contato/CRM. Sem isto, só caderno + catálogo. */
  contacts?: boolean;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

async function cadernoSnapshot(
  tenantId: string,
  phone: string,
  tz: string,
  highlightId?: string,
): Promise<string> {
  const ownBook = await listReminders(tenantId, phone, {
    statuses: ['pendente'],
    limit: 20,
  }).catch(() => []);
  if (!ownBook.length) return 'SEU CADERNO (só este número): (vazio)';
  const lines = ownBook.map((r, i) => {
    const mark = highlightId && r.id === highlightId ? ' ← este' : '';
    return `${i + 1}. ${formatCadernoItem(r, r.timezone || tz)}${mark}`;
  });
  return `SEU CADERNO (só este número, não mistura com outros):\n${lines.join('\n')}`;
}

const buscarContatoTool: Tool = {
  name: 'buscar_contato',
  description:
    'Busca livre no CRM (agenda sincronizada do WhatsApp + quem já falou): nome, trecho do nome, empresa ou telefone. Se o dono citar o FINAL do número, inclua os dígitos (ex.: "Jurandir 3934") — não liste os dois homônimos.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome, trecho, empresa ou telefone (inclua o final se o dono citou).' },
    },
    required: ['nome'],
    additionalProperties: false,
  },
};

const listarProdutosTool: Tool = {
  name: 'listar_produtos',
  description:
    'Lista produtos/serviços do catálogo (nome, preço, pedido mínimo) para montar pitch de venda ou oferta.',
  inputSchema: {
    type: 'object',
    properties: {
      limite: {
        type: 'number',
        description: 'Quantos itens retornar (padrão 20, máx. 40).',
      },
    },
    additionalProperties: false,
  },
};

const enviarMensagemTool: Tool = {
  name: 'enviar_mensagem_contato',
  description:
    'Envia uma mensagem de WhatsApp AGORA para um contato do CRM. Este número é Z-API (WhatsApp comum), NÃO Cloud API da Meta: NÃO existe janela de 24h nem bloqueio da Meta — sempre envie. Use client_id se já souber; senão passe nome. Se houver vários matches, NÃO envia — devolve a lista para o dono escolher.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do contato (se não tiver client_id).' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      mensagem: { type: 'string', description: 'Texto completo a enviar ao contato.' },
    },
    required: ['mensagem'],
    additionalProperties: false,
  },
};

const agendarMensagemTool: Tool = {
  name: 'agendar_mensagem_contato',
  description:
    'Agenda envio automático de mensagem a um contato (boa noite, cobrança de rotina, follow-up). No horário, o sistema envia ao contato e avisa o dono.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do contato (se não tiver client_id).' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      mensagem: { type: 'string', description: 'Texto que será enviado AO CONTATO no horário.' },
      quando: {
        type: 'string',
        description:
          'Horário de parede America/Sao_Paulo no formato YYYY-MM-DDTHH:mm (ex.: 2026-08-12T21:00).',
      },
      recorrencia: {
        type: 'string',
        description:
          'Opcional: daily | weekly:SUN|MON|TUE|WED|THU|FRI|SAT | monthly:1-31 | every:2d (um dia sim, um dia não). Omita para envio único.',
      },
    },
    required: ['mensagem', 'quando'],
    additionalProperties: false,
  },
};

const lerConversaTool: Tool = {
  name: 'ler_conversa_contato',
  description:
    'Lê AGORA no banco a conversa com o contato (painel + fio de acesso livre/secretária deste número). Sempre chame de novo neste turno se pedirem a última mensagem — não recicle leitura antiga. A primeira linha do retorno é a ÚLTIMA inbound real. Áudio vem transcrito; foto/vídeo descritos. Se for lembrete/compromisso, execute anotar_compromisso neste turno.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do contato.' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      limite: {
        type: 'number',
        description: 'Quantas mensagens nesta página (padrão 200, máx. 500).',
      },
      offset: {
        type: 'number',
        description: 'Pular as N mais recentes para ler as mais antigas (0 = começo pelo recente).',
      },
    },
    additionalProperties: false,
  },
};

const lerHistoricoComigoTool: Tool = {
  name: 'ler_historico_comigo',
  description:
    'Lê o histórico COMPLETO da conversa DESTA pessoa ↔ secretária no banco. Use quando precisar de mensagens mais antigas do que as já carregadas. Para achar um trecho (horário, nome, frase), prefira buscar_no_historico.',
  inputSchema: {
    type: 'object',
    properties: {
      limite: {
        type: 'number',
        description: 'Quantas nesta página (padrão 200, máx. 500).',
      },
      offset: {
        type: 'number',
        description: 'Pular as N mais recentes (0 = as mais novas).',
      },
    },
    additionalProperties: false,
  },
};

const buscarNoHistoricoTool: Tool = {
  name: 'buscar_no_historico',
  description:
    'Busca no banco por trecho, horário ou nome nas conversas. OBRIGATÓRIO quando perguntarem se você lembrou/avisou/anotou/disparou, por que não chamou, o que combinaram, ou para achar fala antiga. Não chute — busque e cite. Sem contato = fio DESTA pessoa com você. Com contato = conversa desse contato (só dono cadastrado).',
  inputSchema: {
    type: 'object',
    properties: {
      termo: {
        type: 'string',
        description: 'Trecho a achar: "19:40", "Kelly", "acordar", "halteres".',
      },
      contato: {
        type: 'string',
        description: 'Nome do contato (só dono). Omita para buscar a conversa de quem está falando com você.',
      },
    },
    required: ['termo'],
    additionalProperties: false,
  },
};

const avisarContatoTool: Tool = {
  name: 'avisar_quando_contato_falar',
  description:
    'Cadastra aviso para o DONO quando um contato (ou qualquer pessoa) mandar mensagem / chamar / falar neste WhatsApp. Entenda QUALQUER formulação: "quando o Wender chamar", "se a Maria falar me avisa", "me chama quando o João mandar zap". Se houver NOME específico, NÃO use todos. todos=true só para qualquer pessoa/todo mundo sem nome. acao=criar|cancelar|listar. modo=once (próxima) ou always (sempre).',
  inputSchema: {
    type: 'object',
    properties: {
      acao: {
        type: 'string',
        description: 'criar | cancelar | listar',
      },
      todos: {
        type: 'boolean',
        description: 'true = qualquer pessoa neste WhatsApp (um aviso por contato).',
      },
      nome: {
        type: 'string',
        description:
          'Nome do contato. Se o dono deu o final do telefone, inclua (ex.: "Jurandir 3934").',
      },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      modo: {
        type: 'string',
        description:
          'always = toda vez (padrão). once = só a próxima. Use once só se o dono pedir a próxima / uma vez.',
      },
    },
    additionalProperties: false,
  },
};

const orientarAtendimentoTool: Tool = {
  name: 'orientar_atendimento_contato',
  description:
    'Deixa a IA de atendimento do negócio CONTINUAR conversando com o contato nas próximas mensagens dele, seguindo sua orientação. Use junto com ler_conversa + enviar quando o dono pedir "converse com X", "atende o Wender", "fica falando com ele".',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do contato.' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      instrucao: {
        type: 'string',
        description:
          'Orientação clara do dono para as próximas respostas (tom, oferta, o que evitar, objetivo).',
      },
    },
    required: ['instrucao'],
    additionalProperties: false,
  },
};

const responderContatoTool: Tool = {
  name: 'responder_contato',
  description:
    'Liga ou desliga a secretária/IA RESPONDER um contato. Use quando o dono pedir "para de responder a esposa", "não fala mais com ela", "não responde o Jurandir". acao=parar deixa de responder (o AVISO ao dono continua). acao=voltar retoma. NÃO use para cancelar aviso — isso é avisar_quando_contato_falar.',
  inputSchema: {
    type: 'object',
    properties: {
      acao: { type: 'string', description: 'parar | voltar' },
      nome: { type: 'string', description: 'Nome do contato.' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
    },
    additionalProperties: false,
  },
};

const listarCompromissosTool: Tool = {
  name: 'listar_compromissos',
  description:
    'Lista compromissos REAIS do caderno DESTA pessoa (o número que está falando). Sem contato = só o caderno dela, mesmo que outros números também criem lembretes. Use ao perguntarem a agenda OU o que acabou de anotar. incluir=todos quando for auditoria. contato = nome se a pergunta for sobre outra pessoa. periodo: hoje|amanha|semana|mes|todos.',
  inputSchema: {
    type: 'object',
    properties: {
      periodo: {
        type: 'string',
        description: 'hoje | amanha | semana | mes | todos. Padrão: todos.',
      },
      contato: {
        type: 'string',
        description: 'Nome do contato se a pergunta for sobre alguém específico.',
      },
      incluir: {
        type: 'string',
        description:
          'pendentes (padrão) | disparados (já tocaram) | todos (pendente+enviado+cancelado+concluido). Use todos se perguntarem se lembrou ou por que não avisou.',
      },
    },
    additionalProperties: false,
  },
};

const anotarCompromissoTool: Tool = {
  name: 'anotar_compromisso',
  description:
    'Grava um compromisso no caderno para DISPARO AUTOMÁTICO no WhatsApp. Use sempre que pedirem para lembrar/anotar/salvar horário (inclusive áudio já transcrito). Se pedirem para PESQUISAR/buscar cotação EM UM HORÁRIO, use acao=pesquisar — no horário o sistema busca de verdade e manda o resultado. Se for PARA um contato receber a mensagem no horário, preencha para_contato + mensagem_contato.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'O que fazer. Texto COMPLETO (listas, kg, cores) — nunca corte o final.' },
      quando: {
        type: 'string',
        description: 'Horário de parede YYYY-MM-DDTHH:mm (America/Sao_Paulo). Ano = o atual (2026), nunca o ano anterior.',
      },
      acao: {
        type: 'string',
        description:
          'lembrar (padrão, só avisa) | pesquisar (no horário busca na web e manda o resultado). Use pesquisar para cotação, preço, notícia agendada.',
      },
      consulta: {
        type: 'string',
        description: 'Texto da busca quando acao=pesquisar. Se omitir, usa a tarefa.',
      },
      recorrencia: {
        type: 'string',
        description:
          'daily | weekly:MON..SUN | monthly:1-31 | every:2d (um dia sim, um dia não / a cada 2 dias). Omita se for único.',
      },
      lead_minutes: {
        type: 'number',
        description: 'Aviso antecipado em minutos, só se pediram (60 = 1h antes).',
      },
      para_contato: {
        type: 'string',
        description: 'Nome do contato que deve receber no horário (só dono cadastrado).',
      },
      mensagem_contato: {
        type: 'string',
        description: 'Texto COMPLETO enviado AO CONTATO no horário (listas inteiras, sem cortar). Exige para_contato.',
      },
    },
    required: ['task', 'quando'],
    additionalProperties: false,
  },
};

const alterarCompromissoTool: Tool = {
  name: 'alterar_compromisso',
  description:
    'Muda o horário (e opcionalmente a tarefa) de um item JÁ no caderno. caderno_n é o número 1-based da lista do caderno.',
  inputSchema: {
    type: 'object',
    properties: {
      caderno_n: { type: 'number', description: 'Número do item no caderno (1, 2, 3…).' },
      quando: { type: 'string', description: 'Novo horário YYYY-MM-DDTHH:mm.' },
      task: { type: 'string', description: 'Nova tarefa, só se pediram para mudar o texto.' },
    },
    required: ['caderno_n', 'quando'],
    additionalProperties: false,
  },
};

const cancelarCompromissosTool: Tool = {
  name: 'cancelar_compromissos',
  description:
    'Cancela no banco (param de tocar e saem da lista). estes=true cancela a última lista mostrada (use em "cancele estes / risque do caderno / não repetir mais"). todos=true LIMPA o caderno inteiro desta pessoa. Ou caderno_n para um item. NUNCA diga que riscou sem esta tool devolver OK — cancelei.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: { type: 'boolean', description: 'true = cancelar todos os pendentes desta pessoa.' },
      estes: {
        type: 'boolean',
        description: 'true = cancelar os itens da última lista (estes / que se repetem).',
      },
      caderno_n: { type: 'number', description: 'Número do item no caderno, se não for todos/estes.' },
    },
    additionalProperties: false,
  },
};

function normalizeRecurrence(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^daily$/i.test(t)) return 'daily';
  const weekly = t.match(/^weekly:([A-Za-z]{3})$/i);
  if (weekly) return `weekly:${weekly[1]!.toUpperCase()}`;
  const monthly = t.match(/^monthly:(\d{1,2})$/i);
  if (monthly) {
    const d = Number(monthly[1]);
    if (d >= 1 && d <= 31) return `monthly:${d}`;
  }
  const every = t.match(/^every:(\d+)d$/i);
  if (every) {
    const n = Number(every[1]);
    if (n >= 2 && n <= 30) return `every:${n}d`;
  }
  return inferIntervalRecurrence(t);
}

async function resolveOneContact(
  ctx: OwnerToolContext,
  nome: string,
  clientId: string,
): Promise<
  | { ok: true; id: string; name: string; phone: string }
  | { ok: false; text: string }
> {
  if (clientId) {
    const c = await getClientById(ctx.tenantId, clientId);
    if (!c) return { ok: false, text: 'client_id não encontrado no CRM.' };
    if (nome.trim()) {
      void rememberContactChoice({
        tenantId: ctx.tenantId,
        ownerPhone: ctx.ownerPhone,
        query: nome,
        clientId: c.id,
        name: displayName(c),
        phone: c.phone,
        connectionId: ctx.connectionId,
      });
    }
    return { ok: true, id: c.id, name: displayName(c), phone: c.phone };
  }

  const q = nome.trim();
  if (!q) return { ok: false, text: 'Informe nome ou client_id do contato.' };

  const hint = extractPhoneHint(q) ?? extractPhoneHint(ctx.lastUserMessage ?? '');
  const search = hint && !q.includes(hint) ? `${q} ${hint}` : q;
  const matches = await resolveRelayContacts(ctx.tenantId, search, ctx.connectionId, ctx.ownerPhone);
  if (matches.length === 0) {
    return {
      ok: false,
      text: `Não achei "${q}" nas conversas nem na agenda. Manda o nome como no zap (pode ter emoji).`,
    };
  }
  if (matches.length > 1) {
    const lines = matches.map((c, i) => `${i + 1}. ${displayName(c)} (${c.phone}) id=${c.id}`);
    return {
      ok: false,
      text:
        `Vários contatos para "${q}". Peça ao dono o número da lista ou use o client_id:\n` +
        lines.join('\n'),
    };
  }
  const only = matches[0]!;
  return { ok: true, id: only.id, name: displayName(only), phone: only.phone };
}

async function denyUnlessListed(ctx: OwnerToolContext): Promise<string | null> {
  if (await assertListedOwner(ctx.tenantId, ctx.ownerPhone, ctx.connectionId)) return null;
  return 'Sem acesso aos contatos deste WhatsApp.';
}

/** Registry de tools do dono (caderno sempre; contatos opcional). */
export function buildOwnerToolRegistry(
  ctx: OwnerToolContext,
  opts: OwnerToolRegistryOpts = {},
): ToolRegistry {
  const contacts = opts.contacts !== false;
  const buscar: ToolExecutor = async (input) => {
    const denied = await denyUnlessListed(ctx);
    if (denied) return denied;
    const nome = str(asRecord(input).nome);
    if (!nome) return 'Informe o nome do contato.';
    const hint = extractPhoneHint(nome) ?? extractPhoneHint(ctx.lastUserMessage ?? '');
    const search = hint && !nome.includes(hint) ? `${nome} ${hint}` : nome;
    const matches = await resolveRelayContacts(ctx.tenantId, search, ctx.connectionId, ctx.ownerPhone);
    if (!matches.length) {
      return `Não achei "${nome}" nas conversas nem na agenda deste WhatsApp.`;
    }
    if (matches.length === 1) {
      const c = matches[0]!;
      return (
        `PREFERIDO (o dono já escolheu este — use client_id, NÃO pergunte de novo):\n` +
        `1. ${displayName(c)} | telefone ${c.phone} | client_id=${c.id}`
      );
    }
    return matches
      .map((c, i) => `${i + 1}. ${displayName(c)} | telefone ${c.phone} | client_id=${c.id}`)
      .join('\n');
  };

  const listar: ToolExecutor = async (input) => {
    const limRaw = asRecord(input).limite;
    const lim = Math.min(40, Math.max(1, typeof limRaw === 'number' ? limRaw : 20));
    const products = await listProducts(ctx.tenantId, true);
    if (!products.length) return 'Catálogo vazio — cadastre produtos/serviços no painel.';
    return products
      .slice(0, lim)
      .map((p) => {
        const price = p.price_wholesale ? formatBRL(Number(p.price_wholesale)) : 'sob consulta';
        const min = `mín. ${p.min_quantity}${p.unit ? ` ${p.unit}` : ''}`;
        const desc = p.description?.trim() ? ` — ${p.description.trim().slice(0, 120)}` : '';
        return `- ${p.name}: ${price} (${min})${desc}`;
      })
      .join('\n');
  };

  const enviar: ToolExecutor = async (input) => {
    const denied = await denyUnlessListed(ctx);
    if (denied) return denied;
    const o = asRecord(input);
    let mensagem = str(o.mensagem);
    if (!mensagem || mensagem.length < 2) return 'Informe a mensagem a enviar.';
    if (/^(mensagem|msg|texto)$/i.test(mensagem)) {
      return 'Mensagem genérica demais. Escreva o texto completo (ex.: Boa noite!).';
    }

    let resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) {
      const parsed = parseRelayIntent(ctx.lastUserMessage ?? '');
      if (parsed) {
        resolved = await resolveOneContact(ctx, parsed.contactQuery, '');
        if (resolved.ok) mensagem = parsed.body || mensagem;
      }
    }
    if (!resolved.ok) return resolved.text;

    // Fluxo C: com coletor de plano, NÃO envia agora — acumula. O código decide
    // no fim do turno (direto se verbo claro + 1 contato; senão confirmação única).
    if (ctx.plan) {
      const dup = ctx.plan.sends.some(
        (s) => s.clientId === resolved.id && s.body === mensagem && !s.fireAtMs,
      );
      if (!dup) {
        ctx.plan.sends.push({
          clientId: resolved.id,
          name: resolved.name,
          phone: resolved.phone,
          body: mensagem,
          fireAtMs: null,
        });
      }
      return `PLANEJADO — envio para ${resolved.name} já está no plano do turno. NÃO chame de novo; o sistema confirma com o dono e envia.`;
    }

    const sent = await sendOwnerRelay({
      tenantId: ctx.tenantId,
      connectionId: ctx.connectionId,
      clientId: resolved.id,
      body: mensagem,
    });
    if (!sent.ok) return `Falha ao enviar: ${sent.error}`;

    void recordOwnerEvent({
      tenantId: ctx.tenantId,
      ownerPhone: ctx.ownerPhone,
      kind: 'acao',
      summary: `Enviei mensagem para ${sent.name}: "${mensagem.slice(0, 160)}"`,
      connectionId: ctx.connectionId,
      source: 'relay',
    });

    return `OK — enviado para ${sent.name} (${sent.phone}): "${mensagem.slice(0, 200)}"`;
  };

  const lerConversa: ToolExecutor = async (input) => {
    const denied = await denyUnlessListed(ctx);
    if (denied) return denied;
    const o = asRecord(input);
    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

    const limRaw = o.limite;
    const lim = Math.min(500, Math.max(20, typeof limRaw === 'number' ? limRaw : 200));
    const offset = Math.max(0, typeof o.offset === 'number' ? o.offset : 0);
    const conversation = await findOrCreateOpenConversation(
      ctx.tenantId,
      resolved.id,
      ctx.connectionId ?? null,
    );
    await clearHumanPause(ctx.tenantId, conversation.id).catch(() => null);
    const clientRow = await getClientById(ctx.tenantId, resolved.id);
    const threadPhones = [...new Set(
      [resolved.phone, clientRow?.whatsapp_lid].filter((p): p is string => Boolean(p?.trim())),
    )];
    const [history, total, ...secretaryThreads] = await Promise.all([
      getRecentMessagesForAI(ctx.tenantId, conversation.id, lim, offset),
      countMessagesInConversation(ctx.tenantId, conversation.id),
      ...threadPhones.map((p) =>
        listOwnerChatHistory(ctx.tenantId, p, {
          connectionId: ctx.connectionId,
          limit: Math.min(lim, 80),
          offset: 0,
        }).catch(() => []),
      ),
    ]);
    const seenOwner = new Set<string>();
    const secretaryThread = secretaryThreads.flat().filter((row) => {
      if (seenOwner.has(row.id)) return false;
      seenOwner.add(row.id);
      return true;
    });

    let described = 0;
    const crmLines: string[] = [];
    type InboundSnap = { at: number; text: string; kind: string; source: string };
    const inbounds: InboundSnap[] = [];

    for (const m of history) {
      const who = m.direction === 'inbound' ? resolved.name : 'Loja';
      let text = (m.content || m.transcription || m.audio_transcription || '').trim();
      if (
        !text &&
        described < 4 &&
        (m.type === 'image' || m.type === 'video') &&
        m.media_url
      ) {
        const desc = await describeInboundVisual(
          ctx.tenantId,
          {
            type: m.type,
            mediaUrl: m.media_url,
            mediaBase64: null,
            mediaMime: m.media_mime,
            caption: '',
            text: '',
          },
          ctx.connectionId,
          m.media_url,
        );
        described += 1;
        text = (desc ?? '').trim();
      }
      if (!text) {
        if (m.type === 'image') text = '[imagem sem descrição]';
        else if (m.type === 'audio') text = '[áudio sem transcrição]';
        else if (m.type === 'video') text = '[vídeo sem descrição]';
        else text = `[${m.type}]`;
      } else if (m.type === 'audio') {
        text = `(áudio) ${text}`;
      } else if (m.type === 'image') {
        text = `(foto) ${text}`;
      } else if (m.type === 'video') {
        text = `(vídeo) ${text}`;
      }
      crmLines.push(`${who}: ${text.slice(0, 800)}`);
      if (m.direction === 'inbound' && text) {
        inbounds.push({
          at: Date.parse(m.sent_at) || 0,
          text,
          kind: m.type,
          source: 'conversa WhatsApp (painel)',
        });
      }
    }

    const secretLines = secretaryThread.map((row) => {
      const who = row.role === 'user' ? resolved.name : 'Secretária';
      const text = row.content.trim();
      if (row.role === 'user' && text) {
        inbounds.push({
          at: Date.parse(row.created_at) || 0,
          text,
          kind: text.startsWith('[áudio]') ? 'audio' : 'texto',
          source: 'fio da secretária (acesso livre)',
        });
      }
      return `${who}: ${text.slice(0, 800)}`;
    });

    if (!crmLines.length && !secretLines.length) {
      return `Contato ${resolved.name} (${resolved.phone}) — nenhuma mensagem no painel nem no fio da secretária.`;
    }

    const lastInbound = inbounds.reduce<InboundSnap | null>(
      (best, cur) => (!best || cur.at >= best.at ? cur : best),
      null,
    );
    const ultima = lastInbound
      ? [
          'ÚLTIMA MENSAGEM DO CONTATO (lida AGORA no banco — não invente outra, não recicle "Oi"):',
          `quando: ${formatForOwner(new Date(lastInbound.at), DEFAULT_TZ)}`,
          `tipo: ${lastInbound.kind} · fonte: ${lastInbound.source}`,
          `texto: ${lastInbound.text.slice(0, 1200)}`,
          'Se for pedido de lembrar/acordar/compromisso: USE anotar_compromisso NESTE turno com o horário. Não peça o dono para repetir o que já está acima.',
          '',
        ].join('\n')
      : 'ÚLTIMA MENSAGEM DO CONTATO: (não há inbound no banco)\n';

    const memory = await buildMemoryPromptBlock(ctx.tenantId, resolved.id).catch(() => '');
    const loadedUntil = offset + history.length;
    const more =
      loadedUntil < total
        ? `\nHá mais ${total - loadedUntil} no painel. Chame de novo com offset=${loadedUntil}.`
        : '';
    const parts = [
      ultima,
      `Conversa com ${resolved.name} (${resolved.phone}) · client_id=${resolved.id}`,
      memory?.trim() ?? '',
      crmLines.length
        ? `Painel (${total} msgs, offset ${offset}):\n${crmLines.join('\n')}${more}`
        : 'Painel: (vazio)',
      secretLines.length
        ? `Fio secretária deste número (${secretLines.length}):\n${secretLines.join('\n')}`
        : '',
    ];
    return parts.filter(Boolean).join('\n');
  };

  const lerMeuHistorico: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const lim = Math.min(500, Math.max(20, typeof o.limite === 'number' ? o.limite : 200));
    const offset = Math.max(0, typeof o.offset === 'number' ? o.offset : 0);
    const [rows, total] = await Promise.all([
      listOwnerChatHistory(ctx.tenantId, ctx.ownerPhone, {
        connectionId: ctx.connectionId,
        limit: lim,
        offset,
      }),
      countOwnerChatMessages(ctx.tenantId, ctx.ownerPhone, ctx.connectionId),
    ]);
    if (!rows.length) {
      return total === 0
        ? 'Ainda não há histórico comigo no banco.'
        : `offset ${offset} passou do fim (${total} mensagens).`;
    }
    const lines = rows.map((m) => {
      const who = m.role === 'user' ? 'PESSOA' : 'VOCÊ';
      return `${who}: ${m.content.slice(0, 800)}`;
    });
    const loadedUntil = offset + rows.length;
    const more =
      loadedUntil < total
        ? `\nHá mais ${total - loadedUntil} mais antigas. Chame de novo com offset=${loadedUntil}.`
        : '\nFim do fio comigo.';
    return `Histórico comigo · ${total} no banco · offset ${offset}\n${lines.join('\n')}${more}`;
  };

  const buscarHistorico: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const termo = str(o.termo);
    if (termo.length < 2) return 'Informe o termo (horário, nome ou trecho).';
    const contato = str(o.contato);
    const parts: string[] = [];

    const fold = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const needle = fold(termo);

    if (contato) {
      const denied = await denyUnlessListed(ctx);
      if (denied) return denied;
      const resolved = await resolveOneContact(ctx, contato, '');
      if (!resolved.ok) return resolved.text;
      const clientRow = await getClientById(ctx.tenantId, resolved.id);
      const conversation = await findOrCreateOpenConversation(
        ctx.tenantId,
        resolved.id,
        ctx.connectionId ?? null,
      );
      const phones = [...new Set(
        [resolved.phone, clientRow?.whatsapp_lid].filter((p): p is string => Boolean(p?.trim())),
      )];
      const [crmHits, ...threads] = await Promise.all([
        searchConversationMessages(ctx.tenantId, conversation.id, termo, 30),
        ...phones.map((p) =>
          searchOwnerChatHistory(ctx.tenantId, p, termo, {
            connectionId: ctx.connectionId,
            limit: 30,
          }).catch(() => []),
        ),
      ]);
      const threadHits = threads.flat();
      if (crmHits.length) {
        parts.push(
          `Painel com ${resolved.name}:`,
          ...crmHits.map((m) => {
            const who = m.direction === 'inbound' ? resolved.name : 'Loja';
            const text = (m.content || m.transcription || m.audio_transcription || '').trim();
            const when = formatForOwner(new Date(m.sent_at), DEFAULT_TZ);
            return `- ${when} ${who}: ${text.slice(0, 400)}`;
          }),
        );
      }
      if (threadHits.length) {
        parts.push(
          `Fio da secretária com ${resolved.name}:`,
          ...threadHits.map((m) => {
            const who = m.role === 'user' ? resolved.name : 'VOCÊ';
            const when = formatForOwner(new Date(m.created_at), DEFAULT_TZ);
            return `- ${when} ${who}: ${m.content.slice(0, 400)}`;
          }),
        );
      }
      const book = await listRemindersAboutContact(ctx.tenantId, ctx.ownerPhone, {
        clientId: resolved.id,
        contactPhone: resolved.phone,
        nameHints: [resolved.name, contato],
        filter: {
          statuses: ['pendente', 'enviado', 'cancelado', 'concluido'],
          limit: 20,
        },
      }).catch(() => []);
      const bookHits = book.filter(
        (r) => fold(reminderDisplayText(r)).includes(needle) || fold(r.task).includes(needle),
      );
      const bookShow = bookHits.length ? bookHits : book.slice(0, 8);
      if (bookShow.length) {
        parts.push(
          `Caderno ligado a ${resolved.name}:`,
          ...bookShow.map((r) => `- ${formatCadernoItem(r, r.timezone || DEFAULT_TZ)}`),
        );
      }
      if (!parts.length) {
        return `Não achei "${termo}" na conversa nem no caderno de ${resolved.name}.`;
      }
      return `Busca "${termo}" · ${resolved.name}\n${parts.join('\n')}`;
    }

    const [ownHits, book] = await Promise.all([
      searchOwnerChatHistory(ctx.tenantId, ctx.ownerPhone, termo, {
        connectionId: ctx.connectionId,
        limit: 40,
      }),
      listReminders(ctx.tenantId, ctx.ownerPhone, {
        statuses: ['pendente', 'enviado', 'cancelado', 'concluido'],
        limit: 40,
      }).catch(() => []),
    ]);
    if (ownHits.length) {
      parts.push(
        'Fio comigo:',
        ...ownHits.map((m) => {
          const who = m.role === 'user' ? 'PESSOA' : 'VOCÊ';
          const when = formatForOwner(new Date(m.created_at), DEFAULT_TZ);
          return `- ${when} ${who}: ${m.content.slice(0, 400)}`;
        }),
      );
    }
    const bookHits = book.filter(
      (r) =>
        fold(reminderDisplayText(r)).includes(needle) ||
        fold(r.task).includes(needle) ||
        formatForOwner(new Date(r.next_fire_at), r.timezone || DEFAULT_TZ).includes(termo),
    );
    if (bookHits.length) {
      parts.push(
        'Caderno desta pessoa:',
        ...bookHits.map((r) => `- ${formatCadernoItem(r, r.timezone || DEFAULT_TZ)}`),
      );
    }
    if (!parts.length) {
      return `Não achei "${termo}" no fio comigo nem no caderno desta pessoa.`;
    }
    return `Busca "${termo}" (conversa comigo)\n${parts.join('\n')}`;
  };

  const orientar: ToolExecutor = async (input) => {
    const denied = await denyUnlessListed(ctx);
    if (denied) return denied;
    const o = asRecord(input);
    const instrucao = str(o.instrucao);
    if (!instrucao || instrucao.length < 3) {
      return 'Informe a orientação (o que a IA deve fazer com esse contato).';
    }
    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

    const prompt =
      `ORIENTAÇÃO DO DONO (prioridade alta para este contato):\n${instrucao.slice(0, 1800)}\n\n` +
      'Continue a conversa de forma natural no WhatsApp, alinhada a essa orientação e ao catálogo. ' +
      'Se o contato pedir busca na internet, cotação, notícia ou fato atual, use web_search, julgue as fontes e busque de novo se estiver fraco — não ignore nem invente.';

    const updated = await updateClient(ctx.tenantId, resolved.id, {
      ai_enabled: true,
      ai_prompt: prompt,
    });
    if (!updated) return 'Não consegui salvar a orientação no contato.';

    const conversation = await findOrCreateOpenConversation(
      ctx.tenantId,
      resolved.id,
      ctx.connectionId ?? null,
    );
    await clearHumanPause(ctx.tenantId, conversation.id).catch(() => null);

    void recordOwnerEvent({
      tenantId: ctx.tenantId,
      ownerPhone: ctx.ownerPhone,
      kind: 'acao',
      summary: `Orientei atendimento de ${resolved.name}: ${instrucao.slice(0, 140)}`,
      connectionId: ctx.connectionId,
      source: 'relay',
    });

    return (
      `OK — a IA do negócio vai continuar conversando com ${resolved.name} seguindo: "${instrucao.slice(0, 200)}". ` +
      `Se ainda não mandou resposta agora, use ler_conversa_contato e enviar_mensagem_contato.`
    );
  };

  const agendar: ToolExecutor = async (input) => {
    const denied = await denyUnlessListed(ctx);
    if (denied) return denied;
    const o = asRecord(input);
    const mensagem = str(o.mensagem);
    const quando = str(o.quando);
    if (!mensagem) return 'Informe a mensagem que será enviada ao contato.';
    if (!quando) return 'Informe quando (YYYY-MM-DDTHH:mm).';

    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

    const tz = DEFAULT_TZ;
    const at = parseLocalIso(quando, tz);
    if (!at) return 'quando inválido. Use YYYY-MM-DDTHH:mm (ex.: 2026-08-12T21:00).';
    if (at.getTime() < Date.now() - 60_000) {
      return 'Horário no passado. Escolha um horário futuro.';
    }

    const recRaw = str(o.recorrencia);
    const recurrence = recRaw ? normalizeRecurrence(recRaw) : null;
    if (recRaw && !recurrence) {
      return 'recorrencia inválida. Use daily, weekly:MON, monthly:15, every:2d, ou omita.';
    }

    // Fluxo C: envio único agendado entra no plano do turno (uma confirmação).
    // Recorrência (rotina deliberada) mantém o caminho direto — dispara no gate
    // por owner_authorized no horário.
    if (ctx.plan && !recurrence) {
      const dup = ctx.plan.sends.some(
        (s) => s.clientId === resolved.id && s.body === mensagem && s.fireAtMs === at.getTime(),
      );
      if (!dup) {
        ctx.plan.sends.push({
          clientId: resolved.id,
          name: resolved.name,
          phone: resolved.phone,
          body: mensagem,
          fireAtMs: at.getTime(),
        });
      }
      return `PLANEJADO — envio para ${resolved.name} em ${formatForOwner(at, tz)} já está no plano do turno. NÃO chame de novo; o sistema confirma com o dono e agenda.`;
    }

    const task = `Enviar p/ ${resolved.name}: ${mensagem.slice(0, 4000)}`;
    const reminder = await createReminder(ctx.tenantId, {
      ownerPhone: ctx.ownerPhone,
      task,
      category: recurrence ? 'rotina' : 'data_especifica',
      recurrence,
      nextFireAt: at,
      timezone: tz,
      connectionId: ctx.connectionId,
      targetClientId: resolved.id,
      relayBody: mensagem,
    });

    void recordOwnerEvent({
      tenantId: ctx.tenantId,
      ownerPhone: ctx.ownerPhone,
      kind: 'acao',
      summary: `Agendei msg para ${resolved.name} em ${formatForOwner(at, tz)}${
        recurrence ? ` (${recurrence})` : ''
      }: "${mensagem.slice(0, 100)}"`,
      connectionId: ctx.connectionId,
      source: 'relay',
    });

    return (
      `OK — agendado para ${resolved.name} em ${formatForOwner(at, tz)}` +
      (recurrence ? ` · repete ${recurrence}` : ' · único') +
      ` · id=${reminder.id}. No horário envio ao contato e te aviso.`
    );
  };

  const avisar: ToolExecutor = async (input) => {
    const listed = await assertListedOwner(ctx.tenantId, ctx.ownerPhone, ctx.connectionId);
    if (!listed) {
      return 'Só números cadastrados na lista de Lembretes podem pedir aviso de contato.';
    }

    const o = asRecord(input);
    const acao = str(o.acao).toLowerCase() || 'criar';

    if (acao === 'listar') {
      return formatWatchList(ctx.tenantId, ctx.ownerPhone, ctx.connectionId);
    }

    const nome = str(o.nome);
    const anyoneName = looksLikeAnyone(nome);
    // Nome específico ganha: nunca vira "qualquer pessoa" se citou um contato.
    const todos =
      (o.todos === true || anyoneName) && !str(o.client_id) && (!nome || anyoneName);
    if (todos) {
      if (acao === 'cancelar') {
        const ok = await cancelWatchForAnyone({
          tenantId: ctx.tenantId,
          ownerPhone: ctx.ownerPhone,
          connectionId: ctx.connectionId,
        });
        return ok
          ? 'OK — parei de te avisar de qualquer pessoa.'
          : 'Não tinha aviso de qualquer pessoa ativo.';
      }
      await createWatchForAnyone({
        tenantId: ctx.tenantId,
        ownerPhone: ctx.ownerPhone,
        connectionId: ctx.connectionId,
      });
      return 'OK — te aviso cada vez que alguém mandar mensagem neste WhatsApp, não importa quantas pessoas. Manda "para de me avisar de todo mundo" pra parar.';
    }

    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

    if (acao === 'cancelar') {
      const done = await cancelWatchForContact({
        tenantId: ctx.tenantId,
        ownerPhone: ctx.ownerPhone,
        clientId: resolved.id,
        connectionId: ctx.connectionId,
      });
      return done.ok
        ? `OK — parei de te avisar quando *${done.name}* mandar mensagem.`
        : `Não tinha aviso ativo para *${done.name}*.`;
    }

    const modoRaw = str(o.modo).toLowerCase();
    const mode =
      modoRaw === 'once' || modoRaw === 'proxima' || modoRaw === 'próxima' ? 'once' : 'always';
    const created = await createWatchForContact({
      tenantId: ctx.tenantId,
      ownerPhone: ctx.ownerPhone,
      clientId: resolved.id,
      mode,
      connectionId: ctx.connectionId,
    });
    return mode === 'always'
      ? `OK — te aviso sempre que *${created.name}* mandar mensagem neste WhatsApp.`
      : `OK — te aviso quando *${created.name}* mandar a próxima mensagem. Depois o aviso sai sozinho.`;
  };

  const responderContato: ToolExecutor = async (input) => {
    const listed = await assertListedOwner(ctx.tenantId, ctx.ownerPhone, ctx.connectionId);
    if (!listed) {
      return 'Só números cadastrados na lista de Lembretes podem ligar/desligar resposta a contato.';
    }

    const o = asRecord(input);
    const acao = str(o.acao).toLowerCase();
    if (!acao || !['parar', 'voltar', 'desligar', 'ligar'].includes(acao)) {
      return 'acao deve ser parar ou voltar.';
    }
    const enabled = acao === 'voltar' || acao === 'ligar';

    const clientId = str(o.client_id);
    const nome = str(o.nome);
    let id: string;
    if (clientId) {
      const resolved = await resolveOneContact(ctx, nome, clientId);
      if (!resolved.ok) return resolved.text;
      id = resolved.id;
    } else {
      const resolved = await resolveMuteContact(
        ctx.tenantId,
        nome || 'ela',
        ctx.ownerPhone,
        ctx.connectionId,
      );
      if (!resolved.ok) return resolved.text;
      id = resolved.id;
    }

    const done = await setContactAutoReply({
      tenantId: ctx.tenantId,
      clientId: id,
      enabled,
      ownerPhone: ctx.ownerPhone,
      connectionId: ctx.connectionId,
    });
    return done.enabled
      ? `OK — voltei a responder *${done.name}*.`
      : `OK — parei de responder *${done.name}*. O aviso ao dono continua, se estiver ativo.`;
  };

  const anotar: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const task = str(o.task);
    const quando = str(o.quando);
    if (!task) return 'Informe a tarefa.';
    if (!quando) return 'Informe quando (YYYY-MM-DDTHH:mm).';
    const tz = DEFAULT_TZ;
    const parsed = parseLocalIso(quando, tz);
    if (!parsed) return 'quando inválido. Use YYYY-MM-DDTHH:mm.';
    let recurrence: string | null = null;
    const recRaw = str(o.recorrencia);
    if (recRaw) {
      recurrence = normalizeRecurrence(recRaw);
      if (!recurrence || !isValidRecurrence(recurrence)) {
        return 'recorrencia inválida. Use daily, weekly:MON, monthly:15, every:2d, ou omita.';
      }
    }
    if (!recurrence && ctx.lastUserMessage) {
      recurrence = inferIntervalRecurrence(ctx.lastUserMessage);
    }
    const nextFireAt = bumpUntilFuture(parsed, new Date(), tz, recurrence);
    const leadRaw = o.lead_minutes;
    const leadMinutes =
      typeof leadRaw === 'number' && leadRaw > 0 ? Math.min(Math.floor(leadRaw), 7 * 24 * 60) : null;

    const para = str(o.para_contato);
    const msgContato = str(o.mensagem_contato);
    let targetClientId: string | null = null;
    let relayBody: string | null = null;
    if (para) {
      const denied = await denyUnlessListed(ctx);
      if (denied) return denied;
      const resolved = await resolveOneContact(ctx, para, '');
      if (!resolved.ok) return resolved.text;
      targetClientId = resolved.id;
      relayBody = msgContato || task;
    }

    const savedTask = para ? `Enviar p/ ${para}: ${relayBody || task}` : task;
    const dup = await findSimilarPendingReminder(ctx.tenantId, ctx.ownerPhone, savedTask, nextFireAt);
    if (dup) {
      if (dup.status === 'cancelado') {
        return `Esse compromisso já tinha sido cancelado (${dup.task}). Não recriei.`;
      }
      if (dup.status === 'enviado') {
        return `Esse já tocou (${dup.task}). Não recriei.`;
      }
      return `Já estava no caderno: ${dup.task} · ${formatForOwner(new Date(dup.next_fire_at), tz)} · id=${dup.id}. Não dupliquei.`;
    }

    const acao = str(o.acao).toLowerCase();
    const consulta = str(o.consulta);
    const fireAction =
      acao === 'pesquisar' || acao === 'pesquisa' || inferFireAction(task, ctx.lastUserMessage) === 'search'
        ? 'search'
        : 'notify';
    const searchQuery =
      fireAction === 'search' ? consulta || extractSearchQuery(task || ctx.lastUserMessage || '') : null;

    const reminder = await createReminder(ctx.tenantId, {
      ownerPhone: ctx.ownerPhone,
      task: para ? `Enviar p/ ${para}: ${task}` : task,
      category: recurrence ? 'rotina' : 'data_especifica',
      recurrence,
      nextFireAt,
      timezone: tz,
      leadMinutes,
      connectionId: ctx.connectionId,
      targetClientId,
      relayBody,
      fireAction,
      searchQuery,
    });

    void recordOwnerEvent({
      tenantId: ctx.tenantId,
      ownerPhone: ctx.ownerPhone,
      kind: 'evento',
      summary: `Compromisso anotado: ${reminder.task} (${formatForOwner(nextFireAt, tz)})`,
      connectionId: ctx.connectionId,
      occurredAt: nextFireAt,
      source: 'reminder',
    });

    const book = await cadernoSnapshot(ctx.tenantId, ctx.ownerPhone, tz, reminder.id);
    rememberOwnerLastList(
      ctx.tenantId,
      ctx.ownerPhone,
      (await listReminders(ctx.tenantId, ctx.ownerPhone, { statuses: ['pendente'], limit: 20 }).catch(() => [])).map(
        (r) => r.id,
      ),
    );

    return (
      `OK — salvo no SEU caderno (este número) para disparo automático em ${formatForOwner(nextFireAt, tz)}` +
      (recurrence ? ` · repete ${describeRecurrence(recurrence)}` : ' · único') +
      (fireAction === 'search' ? ' · no horário eu PESQUISO e mando o resultado' : '') +
      (para ? ` · no horário mando pra ${para}` : '') +
      ` · id=${reminder.id}.\n` +
      `Criado: ${formatCadernoItem(reminder, tz)}\n` +
      book
    );
  };

  const listarCaderno: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const periodo = (str(o.periodo) || 'todos').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const incluir = (str(o.incluir) || 'pendentes').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tz = DEFAULT_TZ;
    const wc = toWallClock(new Date(), tz);
    const startOfToday = fromWallClock({ ...wc, hour: 0, minute: 0 }, tz);
    const endOfToday = fromWallClock({ ...wc, day: wc.day + 1, hour: 0, minute: 0 }, tz);
    let statuses: ReminderStatus[] = ['pendente'];
    if (incluir === 'todos' || incluir === 'tudo') {
      statuses = ['pendente', 'enviado', 'cancelado', 'concluido'];
    } else if (incluir === 'disparados' || incluir === 'enviados' || incluir === 'tocados') {
      statuses = ['enviado', 'concluido'];
    }
    const filter: { from?: Date; until?: Date; statuses: ReminderStatus[]; limit: number } = {
      statuses,
      limit: 40,
    };
    if (periodo === 'hoje') {
      filter.from = startOfToday;
      filter.until = endOfToday;
    } else if (periodo === 'amanha') {
      filter.from = endOfToday;
      filter.until = fromWallClock({ ...wc, day: wc.day + 2, hour: 0, minute: 0 }, tz);
    } else if (periodo === 'semana') {
      filter.from = startOfToday;
      filter.until = fromWallClock({ ...wc, day: wc.day + 7, hour: 0, minute: 0 }, tz);
    } else if (periodo === 'mes') {
      filter.from = startOfToday;
      filter.until = fromWallClock({ ...wc, day: wc.day + 30, hour: 0, minute: 0 }, tz);
    }

    const contato = str(o.contato)
      .replace(/^(o|a|os|as|meu|minha|meus|minhas|seu|sua)\s+/i, '')
      .trim();
    let rows;
    if (contato) {
      const matches = await resolveRelayContacts(
        ctx.tenantId,
        contato,
        ctx.connectionId,
        ctx.ownerPhone,
      );
      const nameHints = [contato, ...matches.map((m) => m.name).filter((n): n is string => Boolean(n))];
      rows = await listRemindersAboutContact(ctx.tenantId, ctx.ownerPhone, {
        clientIds: matches.map((m) => m.id),
        contactPhones: matches.map((m) => m.phone),
        nameHints,
        filter,
      });
    } else {
      rows = await listReminders(ctx.tenantId, ctx.ownerPhone, filter);
    }

    if (!rows.length) {
      if (!contato && (periodo === 'hoje' || periodo === 'amanha')) {
        const upcoming = await listReminders(ctx.tenantId, ctx.ownerPhone, {
          statuses: ['pendente'],
          limit: 8,
        }).catch(() => []);
        if (upcoming.length) {
          rememberOwnerLastList(
            ctx.tenantId,
            ctx.ownerPhone,
            upcoming.map((r) => r.id),
          );
          return (
            `Nada para ${periodo}. Próximos no SEU caderno:\n` +
            upcoming.map((r, i) => `${i + 1}. ${formatCadernoItem(r, r.timezone || tz)}`).join('\n')
          );
        }
      }
      return contato
        ? `Nada anotado para "${contato}"${periodo === 'todos' ? '' : ` (${periodo})`}${incluir === 'pendentes' ? '' : ` · ${incluir}`}.`
        : `Seu caderno (só este número) está vazio${periodo === 'todos' ? '' : ` (${periodo})`}${incluir === 'pendentes' ? '' : ` · ${incluir}`}.`;
    }
    const header = contato
      ? `Caderno sobre ${contato}:`
      : 'SEU CADERNO (só este número, sem misturar outros):';
    if (!contato) {
      rememberOwnerLastList(
        ctx.tenantId,
        ctx.ownerPhone,
        rows.filter((r) => r.status === 'pendente').map((r) => r.id),
      );
    }
    return [header, ...rows.map((r, i) => `${i + 1}. ${formatCadernoItem(r, r.timezone || tz)}`)].join(
      '\n',
    );
  };

  const alterar: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const n = typeof o.caderno_n === 'number' ? o.caderno_n : Number(o.caderno_n);
    if (!Number.isInteger(n) || n < 1) return 'caderno_n deve ser o número do item (1, 2, …).';
    const quando = str(o.quando);
    if (!quando) return 'Informe o novo horário (YYYY-MM-DDTHH:mm).';
    const tz = DEFAULT_TZ;
    const parsed = parseLocalIso(quando, tz);
    if (!parsed) return 'quando inválido. Use YYYY-MM-DDTHH:mm.';
    const agenda = await loadOwnerAgenda(ctx.tenantId, ctx.ownerPhone, tz);
    const existing = agenda[n - 1];
    if (!existing) return `Não achei o item ${n} no caderno. Manda HOJE pra eu listar.`;
    const nextFireAt = bumpUntilFuture(parsed, new Date(), tz, existing.recurrence);
    const task = str(o.task) || existing.task;
    const fireAction = inferFireAction(task, ctx.lastUserMessage);
    const updated = await updateOwnerReminder(ctx.tenantId, ctx.ownerPhone, existing.id, {
      nextFireAt,
      task,
      recurrence: existing.recurrence,
      fireAction,
      searchQuery: fireAction === 'search' ? extractSearchQuery(task) : existing.search_query,
    });
    if (!updated) return 'Não consegui alterar — talvez já tenha sido cancelado.';
    const book = await cadernoSnapshot(ctx.tenantId, ctx.ownerPhone, tz, updated.id);
    return (
      `OK — alterei: ${updated.task} · ${formatForOwner(nextFireAt, tz)}. Disparo automático atualizado.\n` +
      `Alterado: ${formatCadernoItem(updated, tz)}\n` +
      book
    );
  };

  const cancelar: ToolExecutor = async (input) => {
    const o = asRecord(input);
    const tz = DEFAULT_TZ;
    if (o.todos === true) {
      const count = await cancelAllPendingReminders(ctx.tenantId, ctx.ownerPhone);
      rememberOwnerLastList(ctx.tenantId, ctx.ownerPhone, undefined);
      const book = await cadernoSnapshot(ctx.tenantId, ctx.ownerPhone, tz);
      return count === 0
        ? `Não tinha nenhum pendente.\n${book}`
        : `OK — cancelei ${count}. Saíram da lista e não tocam mais.\n${book}`;
    }
    if (o.estes === true) {
      const ids = getOwnerLastList(ctx.tenantId, ctx.ownerPhone);
      const own = await listReminders(ctx.tenantId, ctx.ownerPhone, {
        statuses: ['pendente'],
        limit: 80,
      });
      const fromList = own.filter((r) => ids.includes(r.id));
      const repeating = own.filter((r) => Boolean(r.recurrence));
      const targets = fromList.length ? fromList : repeating;
      if (!targets.length) return 'Não achei a última lista. Informe caderno_n ou todos=true.';
      let count = 0;
      const cancelled: string[] = [];
      for (const r of targets) {
        if (await cancelReminderById(ctx.tenantId, r.id)) {
          count += 1;
          cancelled.push(r.task);
        }
      }
      rememberOwnerLastList(ctx.tenantId, ctx.ownerPhone, undefined);
      const book = await cadernoSnapshot(ctx.tenantId, ctx.ownerPhone, tz);
      return count === 0
        ? `Não tinha nenhum desses pendente.\n${book}`
        : `OK — cancelei ${count}. Saíram da lista e não tocam mais.\nCancelados: ${cancelled.join('; ')}\n${book}`;
    }
    const n = typeof o.caderno_n === 'number' ? o.caderno_n : Number(o.caderno_n);
    if (!Number.isInteger(n) || n < 1) return 'Informe todos=true, estes=true ou caderno_n.';
    const agenda = await loadOwnerAgenda(ctx.tenantId, ctx.ownerPhone, DEFAULT_TZ);
    const existing = agenda[n - 1];
    if (!existing) return `Não achei o item ${n} no caderno.`;
    const ok = await cancelReminder(ctx.tenantId, ctx.ownerPhone, existing.id);
    const book = await cadernoSnapshot(ctx.tenantId, ctx.ownerPhone, tz);
    return ok
      ? `OK — cancelei "${existing.task}". Não toca mais.\n${book}`
      : `Esse já não estava pendente.\n${book}`;
  };

  const reminderRegistry: ToolRegistry = {
    listar_compromissos: { tool: listarCompromissosTool, execute: listarCaderno },
    anotar_compromisso: { tool: anotarCompromissoTool, execute: anotar },
    alterar_compromisso: { tool: alterarCompromissoTool, execute: alterar },
    cancelar_compromissos: { tool: cancelarCompromissosTool, execute: cancelar },
    ler_historico_comigo: { tool: lerHistoricoComigoTool, execute: lerMeuHistorico },
    buscar_no_historico: { tool: buscarNoHistoricoTool, execute: buscarHistorico },
    listar_produtos: { tool: listarProdutosTool, execute: listar },
  };

  if (!contacts) return reminderRegistry;

  return {
    ...reminderRegistry,
    buscar_contato: { tool: buscarContatoTool, execute: buscar },
    ler_conversa_contato: { tool: lerConversaTool, execute: lerConversa },
    orientar_atendimento_contato: { tool: orientarAtendimentoTool, execute: orientar },
    enviar_mensagem_contato: { tool: enviarMensagemTool, execute: enviar },
    agendar_mensagem_contato: { tool: agendarMensagemTool, execute: agendar },
    avisar_quando_contato_falar: { tool: avisarContatoTool, execute: avisar },
    responder_contato: { tool: responderContatoTool, execute: responderContato },
  };
}
