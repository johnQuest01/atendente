/**
 * Tools do chat do DONO (secretário/agente): contatos, catálogo, envio e agenda
 * de mensagem para contato. Contexto via closure — não entram no registry global
 * do atendimento ao cliente.
 */

import { getClientById, updateClient } from '../../../db/queries/clients';
import {
  clearHumanPause,
  findOrCreateOpenConversation,
  getRecentMessagesForAI,
} from '../../../db/queries/conversations';
import { listProducts } from '../../../db/queries/products';
import { createReminder } from '../../../db/queries/reminders';
import { formatBRL } from '../../../utils/text';
import {
  displayName,
  resolveRelayContacts,
  sendOwnerRelay,
} from '../../owner-relay.service';
import { extractPhoneHint } from '../../../utils/phone-hint';
import { describeInboundVisual } from '../../inbound-understand.service';
import { recordOwnerEvent } from '../../owner-memory.service';
import { DEFAULT_TZ, formatForOwner, parseLocalIso } from '../../reminders/time';
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
    'Lê o histórico recente da conversa de um contato. Inclui o TEXTO de áudios transcritos e a DESCRIÇÃO de fotos/vídeos — use isso como o que a pessoa falou ou mostrou, com a mesma precisão de quando o dono manda áudio/foto pra você.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do contato.' },
      client_id: { type: 'string', description: 'UUID do contato, se já conhecido.' },
      limite: {
        type: 'number',
        description: 'Quantas mensagens recentes (padrão 25, máx. 40).',
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
    return { ok: true, id: c.id, name: displayName(c), phone: c.phone };
  }

  const q = nome.trim();
  if (!q) return { ok: false, text: 'Informe nome ou client_id do contato.' };

  const hint = extractPhoneHint(q) ?? extractPhoneHint(ctx.lastUserMessage ?? '');
  const search = hint && !q.includes(hint) ? `${q} ${hint}` : q;
  const matches = await resolveRelayContacts(ctx.tenantId, search, ctx.connectionId);
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

/** Registry de tools do dono (sempre disponível no chat do agente). */
export function buildOwnerToolRegistry(ctx: OwnerToolContext): ToolRegistry {
  const buscar: ToolExecutor = async (input) => {
    const nome = str(asRecord(input).nome);
    if (!nome) return 'Informe o nome do contato.';
    const hint = extractPhoneHint(nome) ?? extractPhoneHint(ctx.lastUserMessage ?? '');
    const search = hint && !nome.includes(hint) ? `${nome} ${hint}` : nome;
    const matches = await resolveRelayContacts(ctx.tenantId, search, ctx.connectionId);
    if (!matches.length) {
      return `Não achei "${nome}" nas conversas nem na agenda deste WhatsApp.`;
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
    const o = asRecord(input);
    const resolved = await resolveOneContact(ctx, str(o.nome), str(o.client_id));
    if (!resolved.ok) return resolved.text;

    const limRaw = o.limite;
    const lim = Math.min(40, Math.max(5, typeof limRaw === 'number' ? limRaw : 25));
    const conversation = await findOrCreateOpenConversation(
      ctx.tenantId,
      resolved.id,
      ctx.connectionId ?? null,
    );
    await clearHumanPause(ctx.tenantId, conversation.id).catch(() => null);
    const history = await getRecentMessagesForAI(ctx.tenantId, conversation.id, lim);
    if (!history.length) {
      return (
        `Contato ${resolved.name} (${resolved.phone}) — conversa aberta, ainda sem mensagens no painel. ` +
        `Pode enviar a primeira mensagem com enviar_mensagem_contato.`
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

    return (
      `Conversa com ${resolved.name} (${resolved.phone}) · client_id=${resolved.id}\n` +
      `Últimas ${lines.length} msgs:\n` +
      lines.join('\n')
    );
  };

  const orientar: ToolExecutor = async (input) => {
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

  return {
    buscar_contato: { tool: buscarContatoTool, execute: buscar },
    listar_produtos: { tool: listarProdutosTool, execute: listar },
    ler_conversa_contato: { tool: lerConversaTool, execute: lerConversa },
    orientar_atendimento_contato: { tool: orientarAtendimentoTool, execute: orientar },
    enviar_mensagem_contato: { tool: enviarMensagemTool, execute: enviar },
    agendar_mensagem_contato: { tool: agendarMensagemTool, execute: agendar },
    avisar_quando_contato_falar: { tool: avisarContatoTool, execute: avisar },
    responder_contato: { tool: responderContatoTool, execute: responderContato },
  };
}
