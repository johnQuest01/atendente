import { DEFAULT_AI_PERSONA } from '../config/persona';
import { logger } from '../config/logger';
import { formatBRL } from '../utils/text';
import type { AiHistoryMessage, Client, Product, TextScript } from '../types';
import { complete, isAiConfigured } from './ai/orchestrator';
import type { ChatMessage } from './ai/types';

export { isAiConfigured };

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
 * persona e os scripts trabalham juntos: a IA reaproveita o tom e o conteúdo
 * dos textos prontos, adaptando ao contexto da conversa.
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
      return msg.audio_transcription ?? (msg.audio_title ? `[áudio: ${msg.audio_title}]` : '[áudio]');
    }
    const said = msg.transcription ?? msg.content;
    return said && said !== '[áudio]' ? said : '[áudio sem transcrição]';
  }
  if (msg.type === 'image') {
    return msg.direction === 'outbound'
      ? `[imagens enviadas${msg.product_name ? ` do produto: ${msg.product_name}` : ''}]`
      : `[imagem recebida${msg.content ? `: ${msg.content}` : ''}]`;
  }
  if (msg.type === 'video') {
    return msg.direction === 'outbound'
      ? '[vídeo enviado]'
      : `[vídeo recebido${msg.content ? `: ${msg.content}` : ''}]`;
  }
  return msg.content ?? '[documento]';
}

/**
 * Normaliza o histórico num formato agnóstico de provedor: alterna user/assistant,
 * começa com 'user' e funde turnos consecutivos do mesmo papel. Cada adaptador
 * traduz isso para o formato nativo da sua API.
 */
function toChatMessages(history: AiHistoryMessage[]): ChatMessage[] {
  const raw: ChatMessage[] = [];
  for (const msg of history) {
    const content = describeMessage(msg).trim();
    if (!content) continue;
    raw.push({ role: msg.direction === 'inbound' ? 'user' : 'assistant', content });
  }

  while (raw.length > 0 && raw[0].role !== 'user') raw.shift();

  const merged: ChatMessage[] = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  return merged;
}

interface SystemPromptInput {
  client: Client | null;
  products?: Product[];
  scripts?: TextScript[];
  storeName?: string;
  systemPrompt?: string;
}

/**
 * Monta o system prompt completo: persona (com [NOME DA LOJA] substituído) +
 * contexto do cliente + catálogo + scripts. Reaproveitado pelo atendimento
 * real (generateReply) e pelo preview/playground do app (previewReply).
 */
function buildSystemPrompt(input: SystemPromptInput): string {
  const basePrompt = (input.systemPrompt?.trim() || DEFAULT_AI_PERSONA).replace(
    /\[NOME DA LOJA\]/g,
    input.storeName ?? 'nossa loja',
  );
  return (
    basePrompt +
    buildClientContext(input.client) +
    buildCatalog(input.products) +
    buildScriptsReference(input.scripts)
  );
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
 * Gera uma resposta humanizada de vendas com base no histórico da conversa,
 * usando a corrente de IA DA EMPRESA (com failover automático). Conta no teto
 * mensal quando a plataforma paga. Retorna null se nenhum provedor estiver
 * disponível, o teto foi atingido, ou todos falharem.
 */
export async function generateReply(
  input: GenerateReplyInput,
  tenantId: string,
): Promise<string | null> {
  const messages = toChatMessages(input.history);
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'Oi' });
  }

  const system = buildSystemPrompt(input);

  const result = await complete({ system, messages, maxTokens: 500, temperature: 0.7 }, tenantId, {
    meter: true,
  });
  if (!result) {
    logger.warn('Sem resposta da IA (nenhum provedor disponível, teto atingido ou todos em falha).');
    return null;
  }
  return result.text || null;
}

function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface PreviewReplyInput extends SystemPromptInput {
  /** Mensagem do "cliente" digitada no teste. */
  userMessage: string;
  /** Turnos anteriores opcionais (role user/assistant). */
  history?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface PreviewReplyResult {
  reply: string | null;
  providerLabel: string | null;
}

/**
 * Gera uma resposta de EXEMPLO usando o mesmo motor do atendimento (persona +
 * catálogo + scripts + cadeia de provedores da empresa), porém SEM enviar
 * WhatsApp e SEM persistir nada. Não conta no teto mensal (meter:false) — é o
 * playground do prompt, usado pelo próprio usuário no app para testar/ajustar.
 */
export async function previewReply(
  input: PreviewReplyInput,
  tenantId: string,
): Promise<PreviewReplyResult> {
  const raw: ChatMessage[] = [...(input.history ?? []), { role: 'user', content: input.userMessage }];
  while (raw.length > 0 && raw[0].role !== 'user') raw.shift();
  const messages: ChatMessage[] = [];
  for (const m of raw) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }

  const system = buildSystemPrompt(input);
  const temperature = clampNumber(input.temperature ?? 0.7, 0, 1.5);
  const maxTokens = clampNumber(Math.round(input.maxTokens ?? 500), 50, 1200);

  const result = await complete({ system, messages, maxTokens, temperature }, tenantId, {
    meter: false,
  });
  return { reply: result?.text || null, providerLabel: result?.providerLabel ?? null };
}

export interface ExtractedClientInfo {
  name: string | null;
  company_name: string | null;
  segment: string | null;
  notes: string | null;
}

/**
 * Extrai dados estruturados do cliente a partir do histórico da conversa
 * (nome, empresa, segmento, necessidade). Usa a corrente de IA da empresa.
 * Não conta no teto (meter:false), mas respeita-o (não roda se já estourou).
 * Retorna null se a IA não estiver configurada ou se não houver nada confiável.
 */
export async function extractClientInfo(
  history: AiHistoryMessage[],
  tenantId: string,
): Promise<ExtractedClientInfo | null> {
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

  const result = await complete(
    {
      system,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 300,
      temperature: 0,
    },
    tenantId,
    { meter: false },
  );
  if (!result) return null;

  try {
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<ExtractedClientInfo>;
    return {
      name: parsed.name ?? null,
      company_name: parsed.company_name ?? null,
      segment: parsed.segment ?? null,
      notes: parsed.notes ?? null,
    };
  } catch (err) {
    logger.warn('Falha ao interpretar JSON de extração de dados do cliente', err);
    return null;
  }
}
