import { logger } from '../config/logger';
import {
  insertOwnerMemory,
  listOwnerMemories,
  ownerMemorySummaryExists,
  OWNER_MEMORY_KINDS,
  type OwnerMemoryKind,
} from '../db/queries/owner_memories';
import { listOwnerChatHistory } from '../db/queries/owner_chat_messages';
import { complete } from './ai/orchestrator';

interface Extracted {
  kind: string;
  summary: string;
  occurred_at?: string | null;
}

const EXTRACT_DEBOUNCE_MS = 900;
const extractTimers = new Map<string, NodeJS.Timeout>();

function normalizeKind(raw: string | undefined): OwnerMemoryKind {
  const k = String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const map: Record<string, OwnerMemoryKind> = {
    fato: 'fato',
    evento: 'evento',
    acontecimento: 'acontecimento',
    historia: 'historia',
    history: 'historia',
    problema: 'problema',
    issue: 'problema',
    preferencia: 'preferencia',
    acao: 'acao',
    action: 'acao',
  };
  return map[k] ?? 'fato';
}

/** Grava um evento/ação estruturado (confirmação de agenda, relay, etc.). */
export async function recordOwnerEvent(input: {
  tenantId: string;
  ownerPhone: string;
  kind: OwnerMemoryKind;
  summary: string;
  connectionId?: string | null;
  occurredAt?: Date | null;
  source?: string;
}): Promise<void> {
  const summary = input.summary.trim();
  if (!summary) return;
  if (await ownerMemorySummaryExists(input.tenantId, input.ownerPhone, summary)) return;
  await insertOwnerMemory({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    kind: input.kind,
    summary,
    connectionId: input.connectionId,
    occurredAt: input.occurredAt,
    source: input.source,
  }).catch((err) => logger.warn('Owner memory: falha ao gravar evento', err));
}

/** Bloco completo para a IA ler (sem depender de keyword). */
export async function buildOwnerMemoryPromptBlock(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<string> {
  const rows = await listOwnerMemories(tenantId, ownerPhone, {
    connectionId,
    limit: 40,
  });
  if (!rows.length) return '';

  const lines = rows.map((m) => {
    const when = m.occurred_at
      ? new Date(m.occurred_at).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : new Date(m.created_at).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit',
          month: '2-digit',
        });
    return `- [${m.kind}] ${when}: ${m.summary}`;
  });

  return [
    'MEMÓRIA INTERPRETADA DO DONO (classificada pela IA — eventos, histórias, acontecimentos, problemas, fatos):',
    'Use isso como contexto contínuo; não peça confirmação do óbvio; não invente o que não está aqui.',
    ...lines,
  ].join('\n');
}

/**
 * Agenda interpretação semântica do fio (debounced).
 * Sem keyword: a própria IA decide o que vale gravar e o tipo.
 */
export function scheduleOwnerMemoryExtract(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): void {
  const key = `${tenantId}:${ownerPhone}:${connectionId ?? ''}`;
  const prev = extractTimers.get(key);
  if (prev) clearTimeout(prev);
  extractTimers.set(
    key,
    setTimeout(() => {
      extractTimers.delete(key);
      void extractOwnerMemoriesFromChat(tenantId, ownerPhone, connectionId);
    }, EXTRACT_DEBOUNCE_MS),
  );
}

/**
 * Interpreta a conversa como uma IA: classifica e grava o que for relevante.
 * Sem lista de palavras-chave — o modelo decide.
 */
export async function extractOwnerMemoriesFromChat(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<void> {
  try {
    const [history, existing] = await Promise.all([
      listOwnerChatHistory(tenantId, ownerPhone, {
        connectionId,
        limit: 20,
      }),
      listOwnerMemories(tenantId, ownerPhone, { connectionId, limit: 25 }),
    ]);

    const transcript = history
      .map((m) => `${m.role === 'user' ? 'Dono' : 'Secretária'}: ${m.content}`)
      .join('\n')
      .slice(0, 8000);
    if (!transcript.trim()) return;

    // Ignora só ping/comandos curtos sem conteúdo narrativo (ainda sem keyword de domínio).
    const ownerBits = history
      .filter((m) => m.role === 'user')
      .slice(-6)
      .map((m) => m.content.trim())
      .join(' ');
    if (ownerBits.length < 12) return;

    const already = existing
      .slice(0, 20)
      .map((m) => `- [${m.kind}] ${m.summary}`)
      .join('\n');

    const kinds = OWNER_MEMORY_KINDS.join('|');
    const result = await complete(
      {
        system: [
          'Você é a memória semântica da secretária do DONO.',
          'Leia a conversa e INTERPRETE o sentido — como uma IA humana faria — sem depender de palavras-chave.',
          'Decida sozinho o que é importante guardar e CLASSIFIQUE cada item:',
          '- evento: compromisso, marco ou algo marcado no tempo (reunião, prazo, data combinada)',
          '- acontecimento: algo que já ocorreu (fechou venda, recebeu, aconteceu X)',
          '- historia: contexto narrativo / enredo contínuo (história do cliente, da empresa, do dia)',
          '- problema: dor, risco, conflito, atraso, reclamação, pendência difícil',
          '- fato: dado estável (nome, relação, preferência factual, dado de negócio)',
          '- preferencia: gosto, estilo, forma de trabalhar que o dono prefere',
          '- acao: algo que a secretária já fez (enviou msg, anotou, cancelou)',
          '',
          `Responda APENAS JSON: {"memories":[{"kind":"${kinds}","summary":"...","occurred_at":null}]}`,
          'Regras:',
          '- Só o que o dono disse ou confirmou; NÃO invente.',
          '- Interprete implicaturas: "o João sumiu de novo" → problema; "ontem fechei com a Maria" → acontecimento.',
          '- Grave IDENTIDADE de contato: se o dono escolheu qual Wender/Maria (número da lista, final do telefone, "é esse"), fato do tipo "quando diz Wender, é o telefone X".',
          '- Grave o que foi pesquisado na internet e o resultado útil (cotação, fato atual) se o dono ou a secretária usou isso na conversa.',
          '- Máximo 5 itens novos; summary claro ≤200 chars.',
          '- NÃO repita o que já está em MEMÓRIA JÁ SALVA (abaixo).',
          '- Se for só cumprimento, comando curto (hoje/ajuda/sim) ou nada novo: {"memories":[]}.',
          already ? `\nMEMÓRIA JÁ SALVA:\n${already}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        messages: [{ role: 'user', content: `CONVERSA:\n${transcript}` }],
        maxTokens: 500,
        temperature: 0,
      },
      tenantId,
      { meter: false, connectionId },
    );
    if (!result?.text) return;

    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]) as { memories?: Extracted[] };
    const memories = Array.isArray(parsed.memories) ? parsed.memories : [];

    for (const m of memories.slice(0, 5)) {
      const summary = String(m.summary ?? '').trim();
      if (summary.length < 8) continue;
      const kind = normalizeKind(m.kind);
      if (await ownerMemorySummaryExists(tenantId, ownerPhone, summary)) continue;
      let occurredAt: Date | null = null;
      if (m.occurred_at) {
        const d = new Date(m.occurred_at);
        if (!Number.isNaN(d.getTime())) occurredAt = d;
      }
      await insertOwnerMemory({
        tenantId,
        ownerPhone,
        kind,
        summary,
        connectionId,
        occurredAt,
        source: 'ai_interpret',
      });
      logger.info(`Owner memory (IA): ${kind} — ${summary.slice(0, 80)}`);
    }
  } catch (err) {
    logger.warn('Owner memory: falha na interpretação', err);
  }
}
