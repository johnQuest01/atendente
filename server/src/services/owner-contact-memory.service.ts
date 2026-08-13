import { logger } from '../config/logger';
import {
  findOwnerContactAlias,
  listOwnerContactAliases,
  upsertOwnerContactAlias,
} from '../db/queries/owner_contact_aliases';
import { listActiveWatches } from '../db/queries/contact_watches';
import { listOwnerMemories } from '../db/queries/owner_memories';
import { recordOwnerEvent } from './owner-memory.service';
import type { RelayCandidate } from './owner-relay.service';

const STOP = new Set([
  'o',
  'a',
  'os',
  'as',
  'de',
  'da',
  'do',
  'dos',
  'das',
  'um',
  'uma',
  'pra',
  'para',
  'pro',
  'minha',
  'meu',
  'minhas',
  'meus',
  'te',
  'me',
  'com',
  'ela',
  'ele',
  'eles',
  'elas',
  'final',
  'numero',
  'número',
]);

const RELATION = new Set(['esposa', 'mulher', 'wife', 'marido', 'esposo', 'husband']);

function strip(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function usableKey(k: string): boolean {
  if (RELATION.has(k)) return true;
  return k.length >= 3;
}

/** Chaves estáveis pra achar "Wender" / "minha esposa" depois. */
export function aliasKeysFromQuery(raw: string): string[] {
  const stripped = strip(raw).toLowerCase();
  if (!stripped) return [];
  const tokens = stripped
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
  const keys: string[] = [];
  if (tokens.length) {
    const full = tokens.join(' ');
    if (usableKey(full)) keys.push(full);
    const first = tokens[0]!;
    if (first !== full && usableKey(first)) keys.push(first);
  }
  if (/\b(esposa|mulher|wife)\b/.test(stripped)) keys.push('esposa');
  if (/\b(marido|esposo|husband)\b/.test(stripped)) keys.push('marido');
  return [...new Set(keys)];
}

export async function rememberContactChoice(input: {
  tenantId: string;
  ownerPhone: string;
  query: string;
  clientId: string;
  name?: string | null;
  phone?: string | null;
  connectionId?: string | null;
}): Promise<void> {
  const keys = [
    ...aliasKeysFromQuery(input.query),
    ...aliasKeysFromQuery(input.name ?? ''),
  ];
  if (!keys.length) return;

  for (const aliasKey of keys) {
    await upsertOwnerContactAlias({
      tenantId: input.tenantId,
      ownerPhone: input.ownerPhone,
      aliasKey,
      clientId: input.clientId,
      connectionId: input.connectionId,
    }).catch((err) => logger.warn('Alias de contato: falha ao gravar', err));
  }

  const label = (input.name && input.name.trim()) || input.phone || 'contato';
  void recordOwnerEvent({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    kind: 'fato',
    summary: `Quando o dono diz "${keys[0]}", é ${label}${input.phone ? ` (${input.phone})` : ''}`,
    connectionId: input.connectionId,
    source: 'alias',
  });
}

/**
 * Se o dono já escolheu qual homônimo, devolve só esse.
 * Senão, se só um dos candidatos tem aviso ativo, usa esse.
 */
export async function preferKnownContact(input: {
  tenantId: string;
  ownerPhone: string;
  query: string;
  candidates: RelayCandidate[];
  connectionId?: string | null;
}): Promise<RelayCandidate[] | null> {
  const { candidates } = input;
  if (candidates.length <= 1) return null;

  const keys = aliasKeysFromQuery(input.query);
  if (keys.length) {
    const alias = await findOwnerContactAlias({
      tenantId: input.tenantId,
      ownerPhone: input.ownerPhone,
      aliasKeys: keys,
      connectionId: input.connectionId,
    });
    if (alias) {
      const hit = candidates.find((c) => c.id === alias.client_id);
      if (hit) return [hit];
    }
  }

  const fromMemory = await preferFromOwnerMemories({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    query: input.query,
    candidates,
    connectionId: input.connectionId,
  });
  if (fromMemory) return [fromMemory];

  const watches = await listActiveWatches(
    input.tenantId,
    input.ownerPhone,
    input.connectionId,
  );
  const watched = candidates.filter((c) => watches.some((w) => w.client_id === c.id));
  if (watched.length === 1) return watched;

  return null;
}

async function preferFromOwnerMemories(input: {
  tenantId: string;
  ownerPhone: string;
  query: string;
  candidates: RelayCandidate[];
  connectionId?: string | null;
}): Promise<RelayCandidate | null> {
  const memories = await listOwnerMemories(input.tenantId, input.ownerPhone, {
    connectionId: input.connectionId,
    limit: 40,
  });
  if (!memories.length) return null;
  const keys = aliasKeysFromQuery(input.query);
  if (!keys.length) return null;

  const confirm =
    /confirmou|mesmo contato|chama o|chamad[oa]|quando diz|é o contato|final\s+\d{4}/i;
  const scored = input.candidates.map((c) => {
    const suffix = c.phone.replace(/\D/g, '').slice(-4);
    if (suffix.length < 4) return { c, score: 0 };
    let score = 0;
    for (const m of memories) {
      const s = m.summary.toLowerCase();
      if (!s.includes(suffix)) continue;
      const digits = s.match(/\d{4}/g) ?? [];
      if (digits.length >= 3) continue;
      if (!keys.some((k) => s.includes(k))) continue;
      score += confirm.test(s) ? 4 : 1;
    }
    return { c, score };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]!);
  const tied = scored.filter((x) => x.score === best.score && x.score > 0);
  return tied.length === 1 ? tied[0]!.c : null;
}

export async function buildContactAliasPromptBlock(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<string> {
  const rows = await listOwnerContactAliases(tenantId, ownerPhone, {
    connectionId,
    limit: 20,
  });
  if (!rows.length) return '';
  const lines = rows.map((a) => {
    const name = a.client_name?.trim() || a.client_phone || a.client_id;
    return `- "${a.alias_key}" → ${name} · ${a.client_phone ?? ''} · client_id=${a.client_id}`;
  });
  return [
    'CONTATOS QUE O DONO JÁ ESCOLHEU (memória de identidade — NÃO pergunte de novo):',
    'Se o dono citar esse nome, use o client_id abaixo na hora. Só mostre lista se o nome NÃO estiver aqui.',
    ...lines,
  ].join('\n');
}
