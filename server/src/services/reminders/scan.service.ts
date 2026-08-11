import { z } from 'zod';
import { logger } from '../../config/logger';
import { query } from '../../db';
import { complete } from '../ai/orchestrator';
import { isMemoryScanEnabled } from '../../db/queries/settings';
import type { ParsedReminder } from './parse.service';
import { DEFAULT_TZ, formatForOwner, parseLocalIso, toWallClock, weekdayNamePt } from './time';

/**
 * Varredura OPCIONAL de conversas (Parte 3). Lê o histórico recente do PRÓPRIO
 * tenant e pede à IA os compromissos que foram combinados mas talvez não viraram
 * lembrete ("te ligo segunda", "manda o boleto dia 10"). Custa token só quando
 * acionada — nunca roda no hot path nem agendada. Propõe candidatos; quem salva
 * é o dono ao confirmar (fluxo em massa da Parte 1).
 */

export { isMemoryScanEnabled };

export interface ScanCandidate extends ParsedReminder {
  /** Trecho de origem, para o dono reconhecer de onde veio. */
  snippet: string;
}

export interface ScanOptions {
  /** Janela em dias (1–60). Padrão 7. */
  days?: number;
  /** Teto de mensagens lidas (controle de custo). Padrão 200. */
  limit?: number;
  /** Restringe a uma conversa específica (senão, varre a empresa toda). */
  conversationId?: string | null;
}

const scanItemSchema = z.object({
  task: z.string().trim().min(1).max(300),
  due_at: z.string(),
  snippet: z.string().trim().max(300).optional(),
});

interface TranscriptLine {
  who: string;
  content: string;
}

/**
 * Lê mensagens de TEXTO recentes, escopadas por tenant (RLS + filtro explícito).
 * Junta `conversations`/`clients` só para rotular quem falou. Nunca cruza empresa.
 */
async function readTextMessages(
  tenantId: string,
  days: number,
  limit: number,
  conversationId: string | null,
): Promise<TranscriptLine[]> {
  const params: unknown[] = [tenantId, String(days)];
  let sql = `
    SELECT m.direction, m.content, COALESCE(cl.name, cl.phone) AS client
      FROM messages_log m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN clients cl ON cl.id = c.client_id
     WHERE m.tenant_id = $1
       AND m.type = 'text'
       AND m.content IS NOT NULL
       AND m.sent_at >= NOW() - ($2 || ' days')::interval`;
  if (conversationId) {
    params.push(conversationId);
    sql += ` AND m.conversation_id = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY m.sent_at DESC LIMIT $${params.length}`;

  const { rows } = await query<{ direction: string; content: string; client: string | null }>(sql, params);
  // Volta à ordem cronológica para a IA ler a conversa como aconteceu.
  return rows.reverse().map((r) => ({
    who: `[${r.client ?? 'cliente'}] ${r.direction === 'inbound' ? 'cliente' : 'loja'}`,
    content: r.content,
  }));
}

function buildScanPrompt(now: Date, tz: string): string {
  const wc = toWallClock(now, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  const agora = `${wc.year}-${pad(wc.month)}-${pad(wc.day)}T${pad(wc.hour)}:${pad(wc.minute)}`;
  return [
    `Você examina uma conversa de atendimento e extrai COMPROMISSOS combinados que talvez não`,
    `tenham virado lembrete (ex.: "te ligo segunda", "mando o boleto dia 10", "passo aí amanhã às 15h").`,
    `Agora é ${agora} (${weekdayNamePt(now, tz)}), fuso ${tz}.`,
    'Responda APENAS um ARRAY JSON, um objeto por compromisso, no formato:',
    '{ "task": "o que fazer, curto (cite o cliente se ajudar)", "due_at": "YYYY-MM-DDTHH:mm", "snippet": "trecho curto de origem" }',
    'Regras:',
    '- Só inclua compromissos com data/hora razoavelmente clara (relativa ao agora acima).',
    '- Sem horário explícito, use 09:00.',
    '- NUNCA use fuso ou "Z" no due_at.',
    '- Não invente: se não houver compromisso claro, responda [].',
    '- No máximo 20 itens.',
  ].join('\n');
}

function extractArray(text: string): unknown[] | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_CANDIDATES = 20;

/**
 * Varre as conversas e devolve os candidatos a compromisso (resolvidos para o
 * fuso do dono). NÃO grava nada — o chamador propõe e só salva o que o dono
 * aprovar. Vazio quando a IA não achou nada ou está indisponível.
 */
export async function scanForCommitments(
  tenantId: string,
  opts: ScanOptions = {},
): Promise<ScanCandidate[]> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 60);
  const limit = Math.min(Math.max(opts.limit ?? 200, 20), 400);

  const lines = await readTextMessages(tenantId, days, limit, opts.conversationId ?? null);
  if (lines.length === 0) return [];

  const transcript = lines
    .map((l) => `${l.who}: ${l.content}`)
    .join('\n')
    .slice(0, 8000);

  const now = new Date();
  const result = await complete(
    {
      system: buildScanPrompt(now, DEFAULT_TZ),
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 900,
      temperature: 0,
    },
    tenantId,
    { meter: true },
  );
  if (!result) {
    logger.warn('Varredura: nenhuma IA disponível.');
    return [];
  }

  const raw = extractArray(result.text);
  if (!raw) {
    logger.warn(`Varredura: resposta não era array — "${result.text.slice(0, 120)}"`);
    return [];
  }

  const out: ScanCandidate[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const parsed = scanItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const nextFireAt = parseLocalIso(parsed.data.due_at, DEFAULT_TZ);
    if (!nextFireAt || nextFireAt.getTime() <= now.getTime()) continue;
    out.push({
      task: parsed.data.task,
      category: 'data_especifica',
      recurrence: null,
      nextFireAt,
      leadMinutes: null,
      confirmationText: `${parsed.data.task}\nData: ${formatForOwner(nextFireAt, DEFAULT_TZ)}`,
      action: 'create',
      snippet: parsed.data.snippet ?? '',
    });
  }
  return out;
}
