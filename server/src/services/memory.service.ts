import { logger } from '../config/logger';
import {
  insertClientMemory,
  listClientMemories,
  memorySummaryExists,
  type MemoryKind,
} from '../db/queries/client_memories';
import type { AiHistoryMessage, Client } from '../types';
import { complete } from './ai/orchestrator';

const PERSONAL_SIGNAL =
  /\b(m[aã]e|pai|filho|filha|esposa|marido|internad|cirurg|anivers|aniversário|prefiro|n[aã]o gosto|alerg|doente|família|familia|viagem|casamento)\b/i;

interface ExtractedMemory {
  kind: MemoryKind;
  summary: string;
  is_sensitive: boolean;
}

/**
 * Extrai fatos duráveis do histórico e grava em client_memories (append).
 * Só roda quando há sinal de conteúdo pessoal — economiza tokens.
 */
export async function extractAndStoreMemories(
  tenantId: string,
  client: Client,
  history: AiHistoryMessage[],
): Promise<void> {
  const recentInbound = history
    .filter((m) => m.direction === 'inbound' && m.content)
    .slice(-8)
    .map((m) => m.content ?? '')
    .join('\n');
  if (!recentInbound || !PERSONAL_SIGNAL.test(recentInbound)) return;

  const transcript = history
    .filter((m) => m.content && m.content !== '[áudio]')
    .slice(-16)
    .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Atendente'}: ${m.content}`)
    .join('\n')
    .slice(0, 4000);
  if (!transcript) return;

  const system = [
    'Extraia FATOS PESSOAIS DURÁVEIS que o cliente contou espontaneamente.',
    'Responda APENAS JSON: {"memories":[{"kind":"fato|evento|preferencia|sensivel","summary":"...","is_sensitive":bool}]}',
    'Regras: só o que o cliente disse; não invente; máximo 3 itens; summary curto (≤120 chars).',
    'Marque is_sensitive=true para saúde, família ou finanças pessoais.',
    'Se não houver nada digno de memória, devolva {"memories":[]}.',
  ].join('\n');

  const result = await complete(
    {
      system,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 350,
      temperature: 0,
    },
    tenantId,
    { meter: false },
  );
  if (!result) return;

  let memories: ExtractedMemory[] = [];
  try {
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]) as { memories?: ExtractedMemory[] };
    memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  } catch {
    return;
  }

  const expires = new Date(Date.now() + 180 * 24 * 60 * 60_000); // 6 meses
  for (const m of memories.slice(0, 3)) {
    const summary = String(m.summary ?? '').trim();
    if (!summary || summary.length < 8) continue;
    const kind: MemoryKind = ['fato', 'evento', 'preferencia', 'sensivel'].includes(m.kind)
      ? m.kind
      : m.is_sensitive
        ? 'sensivel'
        : 'fato';
    if (await memorySummaryExists(tenantId, client.id, summary)) continue;
    await insertClientMemory(tenantId, {
      clientId: client.id,
      kind,
      summary,
      isSensitive: Boolean(m.is_sensitive) || kind === 'sensivel',
      expiresAt: expires,
    });
    logger.info(`Memória salva para cliente ${client.id}: ${summary.slice(0, 80)}`);
  }
}

/** Bloco de texto para injetar no system prompt da IA. */
export async function buildMemoryPromptBlock(tenantId: string, clientId: string): Promise<string> {
  const memories = await listClientMemories(tenantId, clientId, 10);
  if (memories.length === 0) return '';
  const lines = memories.map((m) => {
    const tag = m.is_sensitive ? ' [sensível]' : '';
    return `- (${m.kind}${tag}) ${m.summary}`;
  });
  return (
    '\n\nMEMÓRIA DE LONGO PRAZO DESTE CLIENTE (use com naturalidade e respeito; ' +
    'NÃO force o assunto se a conversa for só comercial; se for sensível, seja ' +
    `discreto e solidário sem invadir):\n${lines.join('\n')}`
  );
}
