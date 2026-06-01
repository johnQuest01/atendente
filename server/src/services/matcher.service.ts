import { getActiveKeywords } from '../db/queries/keywords';
import { listAudios } from '../db/queries/audios';
import { normalizeText } from '../utils/text';
import type { MatchResult } from '../types';

/**
 * Classifica a intenção da mensagem do cliente. Procura um gatilho em duas
 * fontes (na ordem):
 *   1. Tabela `keywords` (mapeamentos explícitos, por prioridade)
 *   2. Campo `keywords` cadastrado no próprio áudio (atalho intuitivo no app)
 * Se nada bater, retorna fallback para o Claude.
 */
export async function matchIntent(messageText: string): Promise<MatchResult> {
  const haystack = normalizeForMatch(messageText);

  // 1) Palavras-chave explícitas (tabela keywords), já ordenadas por prioridade.
  const keywords = await getActiveKeywords();
  for (const kw of keywords) {
    const needle = normalizeForMatch(kw.keyword);
    if (needle && matchesKeyword(haystack, needle)) {
      return {
        content_type: kw.content_type,
        content_id: kw.content_id,
        intent: kw.intent,
        keyword: kw.keyword,
      };
    }
  }

  // 2) Palavras-chave cadastradas no próprio áudio (campo "Palavras-chave").
  const audios = await listAudios(true);
  for (const audio of audios) {
    for (const k of audio.keywords ?? []) {
      const needle = normalizeForMatch(k);
      if (needle && matchesKeyword(haystack, needle)) {
        return {
          content_type: 'audio',
          content_id: audio.id,
          intent: 'audio_keyword',
          keyword: k,
        };
      }
    }
  }

  return { content_type: 'claude', content_id: null, intent: 'fallback' };
}

/**
 * Lista todas as frases-gatilho cadastradas (tabela keywords + campo keywords
 * dos áudios). Útil para dar contexto à transcrição de áudio (Whisper prompt),
 * melhorando o reconhecimento exatamente das frases que disparam respostas.
 */
export async function getTriggerPhrases(): Promise<string[]> {
  const set = new Set<string>();
  const keywords = await getActiveKeywords();
  for (const kw of keywords) if (kw.keyword) set.add(kw.keyword.trim());
  const audios = await listAudios(true);
  for (const audio of audios) {
    for (const k of audio.keywords ?? []) if (k) set.add(k.trim());
  }
  return Array.from(set).filter(Boolean);
}

/**
 * Normaliza para comparação: minúsculas, sem acentos e com a pontuação
 * virando espaço (assim "trabalha?" e "promoção!" casam normalmente).
 */
function normalizeForMatch(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match por palavra/frase inteira. Ambos já normalizados (sem pontuação).
 * O padding com espaços garante limite de palavra (evita "ola" em "tabolada").
 */
function matchesKeyword(haystackNorm: string, needleNorm: string): boolean {
  if (!needleNorm) return false;
  return ` ${haystackNorm} `.includes(` ${needleNorm} `);
}
