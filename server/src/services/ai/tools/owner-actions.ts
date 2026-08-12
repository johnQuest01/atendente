/**
 * Tools do chat do DONO (secretário/agente): contatos, catálogo, envio e agenda
 * de mensagem para contato. Contexto via closure — não entram no registry global
 * do atendimento ao cliente.
 */

import { getClientById } from '../../../db/queries/clients';
import { listProducts } from '../../../db/queries/products';
import { createReminder } from '../../../db/queries/reminders';
import { formatBRL } from '../../../utils/text';
import {
  displayName,
  resolveRelayContacts,
  sendOwnerRelay,
} from '../../owner-relay.service';
import { recordOwnerEvent } from '../../owner-memory.service';
import { DEFAULT_TZ, formatForOwner, parseLocalIso } from '../../reminders/time';
import type { Tool, ToolExecutor, ToolRegistry } from './types';

export interface OwnerToolContext {
  tenantId: string;
  ownerPhone: string;
  connectionId?: string | null;
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
    'Busca livre no CRM (agenda sincronizada do WhatsApp + quem já falou): nome, trecho do nome, empresa ou telefone. Use antes de enviar/agendar. Ex.: "Wender", "wend", "55119…".',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome, trecho, empresa ou telefone.' },
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

  const matches = await resolveRelayContacts(ctx.tenantId, q, ctx.connectionId);
  if (matches.length === 0) {
    return {
      ok: false,
      text: `Nenhum contato "${q}" no CRM. O nome precisa estar em Clientes no painel (já ter falado no WhatsApp ou importado).`,
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
    const matches = await resolveRelayContacts(ctx.tenantId, nome, ctx.connectionId);
    if (!matches.length) {
      return `Nenhum contato "${nome}" no CRM/painel.`;
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

  return {
    buscar_contato: { tool: buscarContatoTool, execute: buscar },
    listar_produtos: { tool: listarProdutosTool, execute: listar },
    enviar_mensagem_contato: { tool: enviarMensagemTool, execute: enviar },
    agendar_mensagem_contato: { tool: agendarMensagemTool, execute: agendar },
  };
}
