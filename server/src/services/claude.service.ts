import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DEFAULT_AI_PERSONA } from '../config/persona';
import { formatBRL } from '../utils/text';
import type { AiHistoryMessage, Client, Product, TextScript } from '../types';

const client = env.hasAnthropic ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

function buildClientContext(c: Client | null): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.name) parts.push(`Nome: ${c.name}`);
  if (c.company_name) parts.push(`Empresa: ${c.company_name}`);
  if (c.segment) parts.push(`Segmento: ${c.segment}`);
  if (c.notes) parts.push(`Observações: ${c.notes}`);
  if (parts.length === 0) return '';
  return `\n\nDADOS DO CLIENTE ATUAL:\n${parts.join('\n')}`;
}

/** Monta um bloco com o catálogo para a IA usar preços/condições reais. */
function buildCatalog(products: Product[] | undefined): string {
  if (!products || products.length === 0) return '';
  const lines = products.slice(0, 40).map((p) => {
    const price = p.price_wholesale ? formatBRL(Number(p.price_wholesale)) : 'sob consulta';
    const min = `mín. ${p.min_quantity}${p.unit ? ` ${p.unit}` : ''}`;
    return `- ${p.name}: ${price} (${min})`;
  });
  return `\n\nCATÁLOGO DISPONÍVEL (use SEMPRE estes preços e condições; nunca invente valores):\n${lines.join('\n')}`;
}

/**
 * Inclui os scripts de mensagem salvos como MODELOS para a IA seguir. Assim a
 * persona e os scripts trabalham juntos: o Claude reaproveita o tom e o
 * conteúdo dos textos prontos, adaptando ao contexto da conversa.
 */
function buildScriptsReference(scripts: TextScript[] | undefined): string {
  if (!scripts || scripts.length === 0) return '';
  const lines = scripts.slice(0, 20).map((s) => {
    const content = s.content.replace(/\s+/g, ' ').trim().slice(0, 300);
    return `- [${s.category}] ${s.title}: "${content}"`;
  });
  return (
    '\n\nSCRIPTS/MODELOS DE MENSAGEM (use como base e adapte ao cliente; ' +
    '{{client_name}} = nome do cliente, {{company_name}} = empresa dele. ' +
    'Nunca escreva as chaves {{...}} na resposta — substitua pelo valor real ou ' +
    `omita se não souber):\n${lines.join('\n')}`
  );
}

/** Converte um turno (texto/áudio/imagem) em texto legível para a IA. */
function describeMessage(msg: AiHistoryMessage): string {
  if (msg.type === 'text') return msg.content ?? '';
  if (msg.type === 'audio') {
    if (msg.direction === 'outbound') {
      // Representa o áudio enviado como o que foi falado (texto natural),
      // para o histórico ficar como um diálogo normal e o modelo NÃO copiar
      // anotações meta na resposta.
      return msg.audio_transcription ?? (msg.audio_title ? `[áudio: ${msg.audio_title}]` : '[áudio]');
    }
    // Áudio do cliente: o conteúdo guarda a transcrição (quando disponível).
    return msg.content && msg.content !== '[áudio]' ? msg.content : '[áudio sem transcrição]';
  }
  if (msg.type === 'image') {
    return msg.direction === 'outbound'
      ? `[imagens enviadas${msg.product_name ? ` do produto: ${msg.product_name}` : ''}]`
      : '[imagem recebida]';
  }
  return msg.content ?? '[documento]';
}

function toAnthropicMessages(history: AiHistoryMessage[]): Anthropic.MessageParam[] {
  const raw: Anthropic.MessageParam[] = [];
  for (const msg of history) {
    const content = describeMessage(msg).trim();
    if (!content) continue;
    raw.push({ role: msg.direction === 'inbound' ? 'user' : 'assistant', content });
  }

  // A API exige começar com 'user'.
  while (raw.length > 0 && raw[0].role !== 'user') raw.shift();

  // Funde turnos consecutivos do mesmo papel (a API exige alternância).
  const merged: Anthropic.MessageParam[] = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string') {
      last.content = `${last.content}\n${m.content as string}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  return merged;
}

export interface GenerateReplyInput {
  history: AiHistoryMessage[];
  client: Client | null;
  products?: Product[];
  /** Scripts de mensagem prontos, usados como modelos pela IA. */
  scripts?: TextScript[];
  storeName?: string;
  /** Persona/instruções (system prompt) editadas pelo usuário no app. */
  systemPrompt?: string;
}

/**
 * Gera uma resposta humanizada de vendas com base no histórico da conversa.
 * Retorna null se a Anthropic não estiver configurada.
 */
export async function generateReply(input: GenerateReplyInput): Promise<string | null> {
  if (!client) {
    logger.warn('ANTHROPIC_API_KEY ausente — pulando geração via Claude.');
    return null;
  }

  const messages = toAnthropicMessages(input.history);
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Oi' });
  }

  const basePrompt = (input.systemPrompt?.trim() || DEFAULT_AI_PERSONA).replace(
    /\[NOME DA LOJA\]/g,
    input.storeName ?? 'nossa loja',
  );
  const system =
    basePrompt +
    buildClientContext(input.client) +
    buildCatalog(input.products) +
    buildScriptsReference(input.scripts);

  try {
    const response = await client.messages.create({
      model: env.CLAUDE_MODEL,
      max_tokens: 500,
      temperature: 0.7,
      system,
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return text || null;
  } catch (err) {
    logger.error('Erro ao chamar a Anthropic API', err);
    return null;
  }
}

export interface ExtractedClientInfo {
  name: string | null;
  company_name: string | null;
  segment: string | null;
  notes: string | null;
}

/**
 * Extrai dados estruturados do cliente a partir do histórico da conversa
 * (nome, empresa, segmento, necessidade). Retorna null se a IA não estiver
 * configurada ou se não houver nada confiável a extrair.
 */
export async function extractClientInfo(
  history: AiHistoryMessage[],
): Promise<ExtractedClientInfo | null> {
  if (!client) return null;

  const transcript = history
    .filter((m) => (m.type === 'text' || m.type === 'audio') && m.content && m.content !== '[áudio]')
    .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Atendente'}: ${m.content}`)
    .join('\n')
    .slice(0, 6000);

  if (!transcript) return null;

  const system = [
    'Você extrai dados de um cliente a partir de uma conversa de atendimento.',
    'Responda APENAS com um JSON válido, sem texto extra, no formato:',
    '{"name": string|null, "company_name": string|null, "segment": string|null, "notes": string|null}',
    '- "name": primeiro nome ou nome completo informado pelo cliente.',
    '- "company_name": nome da empresa/loja, se mencionado.',
    '- "segment": ramo do negócio (ex: farmácia, mercado, loja de roupa).',
    '- "notes": resumo em 1 frase do que o cliente procura/precisa.',
    'Use null quando a informação não estiver clara. NUNCA invente.',
  ].join('\n');

  try {
    const response = await client.messages.create({
      model: env.CLAUDE_MODEL,
      max_tokens: 300,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: transcript }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as Partial<ExtractedClientInfo>;
    return {
      name: parsed.name ?? null,
      company_name: parsed.company_name ?? null,
      segment: parsed.segment ?? null,
      notes: parsed.notes ?? null,
    };
  } catch (err) {
    logger.warn('Falha ao extrair dados do cliente via IA', err);
    return null;
  }
}
