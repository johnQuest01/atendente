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
} from '../../../db/queries/conversations';
import { countOwnerChatMessages, listOwnerChatHistory } from '../../../db/queries/owner_chat_messages';
import { listProducts } from '../../../db/queries/products';
import {
  cancelAllPendingReminders,
  cancelReminder,
  createReminder,
  updateOwnerReminder,
} from '../../../db/queries/reminders';
import { formatBRL } from '../../../utils/text';
import { DEFAULT_TZ, formatForOwner, isValidRecurrence, parseLocalIso } from '../../reminders/time';
import {
  displayName,
  resolveRelayContacts,
  sendOwnerRelay,
} from '../../owner-relay.service';
import { bumpUntilFuture, loadOwnerAgenda } from '../../reminders/parse.service';
import { rememberContactChoice } from '../../owner-contact-memory.service';
import { extractPhoneHint } from '../../../utils/phone-hint';
import { describeInboundVisual } from '../../inbound-understand.service';
import { recordOwnerEvent } from '../../owner-memory.service';
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
import type { Tool, ToolExecutor, ToolRegistry } from './types';

export interface OwnerToolContext {
  tenantId: string;
  ownerPhone: string;
  connectionId?: string | null;
  /** Fala atual do dono — pra cruzar "final 3934" mesmo se a tool só mandar o nome. */
  lastUserMessage?: string | null;
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
    'Envia uma mensagem de WhatsApp AGORA para um contato do CRM. Use client_id se já souber; senão passe nome. Se houver vários matches, NÃO envia — devolve a lista para o dono escolher.',
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
          'Opcional: daily | weekly:SUN|MON|TUE|WED|THU|FRI|SAT | monthly:1-31. Omita para envio único.',
      },
    },
    required: ['mensagem', 'quando'],
    additionalProperties: false,
  },
};

const lerConversaTool: Tool = {
  name: 'ler_conversa_contato',
  description:
    'Lê o histórico da conversa de um contato no banco (TODAS as mensagens, não só as últimas). Padrão: 200 mais recentes. Se vier "há mais", chame de novo com offset maior até o fim. Inclui TEXTO de áudios transcritos e DESCRIÇÃO de fotos/vídeos.',
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
    'Lê o histórico COMPLETO da conversa dono ↔ secretária no banco. Use quando precisar de mensagens mais antigas do que as já carregadas neste turno. offset pula as mais recentes.',
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

const anotarCompromissoTool: Tool = {
  name: 'anotar_compromisso',
  description:
    'Grava um compromisso no caderno para DISPARO AUTOMÁTICO no WhatsApp. Use sempre que pedirem para lembrar/anotar/salvar horário (inclusive áudio já transcrito). Se for PARA um contato receber a mensagem no horário, preencha para_contato + mensagem_contato.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'O que fazer, curto, sem a palavra lembrete.' },
      quando: {
        type: 'string',
        description: 'Horário de parede YYYY-MM-DDTHH:mm (America/Sao_Paulo).',
      },
      recorrencia: {
        type: 'string',
        description: 'daily | weekly:MON..SUN | monthly:1-31. Omita se for único.',
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
        description: 'Texto enviado AO CONTATO no horário (exige para_contato).',
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
    'Cancela no banco (param de tocar e saem da lista). todos=true cancela todos os pendentes. Ou caderno_n para um item.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: { type: 'boolean', description: 'true = cancelar todos os pendentes desta pessoa.' },
      caderno_n: { type: 'number', description: 'Número do item no caderno, se não for todos.' },
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
  return null;
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
    const mensagem = str(o.mensagem);
    if (!mensagem || mensagem.length < 2) return 'Informe a mensagem a enviar.';
    if (/^(mensagem|msg|texto)$/i.test(mensagem)) {
      return 'Mensagem genérica demais. Escreva o texto completo (ex.: Boa noite!).';
    }

    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

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
    const [history, total] = await Promise.all([
      getRecentMessagesForAI(ctx.tenantId, conversation.id, lim, offset),
      countMessagesInConversation(ctx.tenantId, conversation.id),
    ]);
    if (!history.length) {
      return (
        `Contato ${resolved.name} (${resolved.phone}) — ${
          total === 0
            ? 'conversa aberta, ainda sem mensagens no painel. Pode enviar a primeira com enviar_mensagem_contato.'
            : `offset ${offset} passou do fim (${total} no banco).`
        }`
      );
    }

    let described = 0;
    const lines: string[] = [];
    for (const m of history) {
      const who = m.direction === 'inbound' ? resolved.name : 'Loja';
      let text = (m.content || m.transcription || '').trim();
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
      lines.push(`${who}: ${text.slice(0, 800)}`);
    }

    const memory = await buildMemoryPromptBlock(ctx.tenantId, resolved.id).catch(() => '');
    const loadedUntil = offset + history.length;
    const more =
      loadedUntil < total
        ? `\nHá mais ${total - loadedUntil} mais antigas. Chame de novo com offset=${loadedUntil} para continuar até o começo.`
        : '\nFim do fio — todas as mensagens desta página até o começo já cobertas com os offsets anteriores.';
    return (
      `Conversa com ${resolved.name} (${resolved.phone}) · client_id=${resolved.id} · ${total} msgs no banco · offset ${offset}\n` +
      (memory ? `${memory.trim()}\n` : '') +
      `${lines.length} msgs (da mais antiga desta página à mais nova):\n` +
      lines.join('\n') +
      more
    );
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
      const who = m.role === 'user' ? 'DONO' : 'VOCÊ';
      return `${who}: ${m.content.slice(0, 800)}`;
    });
    const loadedUntil = offset + rows.length;
    const more =
      loadedUntil < total
        ? `\nHá mais ${total - loadedUntil} mais antigas. Chame de novo com offset=${loadedUntil}.`
        : '\nFim do fio comigo.';
    return `Histórico comigo · ${total} no banco · offset ${offset}\n${lines.join('\n')}${more}`;
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
      'Se o contato pedir busca na internet, cotação, notícia ou fato atual, use a ferramenta web_search e responda com o resultado — não ignore nem invente.';

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
      return 'recorrencia inválida. Use daily, weekly:MON, monthly:15, ou omita.';
    }

    const task = `Enviar p/ ${resolved.name}: ${mensagem.slice(0, 120)}`;
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
        return 'recorrencia inválida. Use daily, weekly:MON, monthly:15, ou omita.';
      }
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

    return (
      `OK — salvo no caderno para disparo automático em ${formatForOwner(nextFireAt, tz)}` +
      (recurrence ? ` · repete ${recurrence}` : ' · único') +
      (para ? ` · no horário mando pra ${para}` : '') +
      ` · id=${reminder.id}.`
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
    const updated = await updateOwnerReminder(ctx.tenantId, ctx.ownerPhone, existing.id, {
      nextFireAt,
      task,
      recurrence: existing.recurrence,
    });
    if (!updated) return 'Não consegui alterar — talvez já tenha sido cancelado.';
    return `OK — alterei: ${updated.task} · ${formatForOwner(nextFireAt, tz)}. Disparo automático atualizado.`;
  };

  const cancelar: ToolExecutor = async (input) => {
    const o = asRecord(input);
    if (o.todos === true) {
      const count = await cancelAllPendingReminders(ctx.tenantId, ctx.ownerPhone);
      return count === 0
        ? 'Não tinha nenhum pendente.'
        : `OK — cancelei ${count}. Saíram da lista e não tocam mais.`;
    }
    const n = typeof o.caderno_n === 'number' ? o.caderno_n : Number(o.caderno_n);
    if (!Number.isInteger(n) || n < 1) return 'Informe todos=true ou caderno_n.';
    const agenda = await loadOwnerAgenda(ctx.tenantId, ctx.ownerPhone, DEFAULT_TZ);
    const existing = agenda[n - 1];
    if (!existing) return `Não achei o item ${n} no caderno.`;
    const ok = await cancelReminder(ctx.tenantId, ctx.ownerPhone, existing.id);
    return ok
      ? `OK — cancelei "${existing.task}". Não toca mais.`
      : 'Esse já não estava pendente.';
  };

  const reminderRegistry: ToolRegistry = {
    anotar_compromisso: { tool: anotarCompromissoTool, execute: anotar },
    alterar_compromisso: { tool: alterarCompromissoTool, execute: alterar },
    cancelar_compromissos: { tool: cancelarCompromissosTool, execute: cancelar },
    ler_historico_comigo: { tool: lerHistoricoComigoTool, execute: lerMeuHistorico },
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
