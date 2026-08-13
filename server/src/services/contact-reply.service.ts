import { findClientByLid, findClientByPhone, getClientById, updateClient } from '../db/queries/clients';
import { listActiveWatches } from '../db/queries/contact_watches';
import { extractPhoneHint } from '../utils/phone-hint';
import { displayName, resolveRelayContacts } from './owner-relay.service';
import { recordOwnerEvent } from './owner-memory.service';

export type ReplyMuteIntent =
  | { action: 'mute'; contactQuery: string }
  | { action: 'unmute'; contactQuery: string };

const NOT_A_NAME = /^(ela|ele|eles|elas|voce|você|tu|contato|pessoa|esse|essa)$/i;

function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/^(o|a|os|as|com\s+(?:o|a)\s+)/i, '')
    .replace(/\s+(?:agora|mais|por\s+favor)[.!?]*$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

/** Pedido do dono para a secretária PARAR ou VOLTAR a responder um contato. */
export function parseReplyMuteIntent(text: string): ReplyMuteIntent | null {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (/\bavis/i.test(raw)) return null;

  const unmute = raw.match(
    /(?:volta|volte|voltar)(?:\s+a)?\s+(?:responder|falar|atender|conversar)(?:\s+com)?\s+(?:a\s+|o\s+|com\s+(?:a\s+|o\s+)?)?(.+)/i,
  ) || raw.match(
    /(?:responde|atende|fala)\s+(?:com\s+)?(?:a\s+|o\s+)?(.+?)\s+de\s+novo\b/i,
  );
  if (unmute) {
    const contactQuery = cleanName(unmute[1] ?? '');
    if (contactQuery.length >= 2 || NOT_A_NAME.test(contactQuery)) {
      return { action: 'unmute', contactQuery: contactQuery || 'ela' };
    }
  }

  const mute =
    raw.match(
      /(?:pode\s+)?(?:parar|para|pare)\s+de\s+(?:me\s+)?(?:responder|falar|atender|conversar)(?:\s+com)?\s+(?:a\s+|o\s+|com\s+(?:a\s+|o\s+)?)?(.+)/i,
    ) ||
    raw.match(
      /n[aã]o\s+(?:me\s+)?(?:responde|responda|fala|fale|atende|atenda)(?:\s+mais)?\s+(?:com\s+)?(?:a\s+|o\s+)?(.+)/i,
    ) ||
    raw.match(
      /n[aã]o\s+(?:quero\s+que\s+)?(?:voc[eê]|vc)?\s*(?:me\s+)?(?:responda|fale|atenda)\s+(?:mais\s+)?(?:com\s+)?(?:a\s+|o\s+)?(.+)/i,
    ) ||
    raw.match(
      /deixa\s+de\s+(?:responder|falar|atender)\s+(?:a\s+|o\s+|com\s+(?:a\s+|o\s+)?)?(.+)/i,
    );
  if (mute) {
    const contactQuery = cleanName(mute[1] ?? '');
    if (contactQuery.length >= 2 || NOT_A_NAME.test(contactQuery)) {
      return { action: 'mute', contactQuery: contactQuery || 'ela' };
    }
  }

  return null;
}

export async function isContactAutoReplyOff(
  tenantId: string,
  phone: string,
  lid?: string | null,
): Promise<boolean> {
  let client = phone ? await findClientByPhone(tenantId, phone) : null;
  if (!client && lid) client = await findClientByLid(tenantId, lid);
  if (!client && phone) client = await findClientByLid(tenantId, phone);
  return client?.ai_enabled === false;
}

export async function setContactAutoReply(input: {
  tenantId: string;
  clientId: string;
  enabled: boolean;
  ownerPhone: string;
  connectionId?: string | null;
}): Promise<{ name: string; enabled: boolean }> {
  const client = await getClientById(input.tenantId, input.clientId);
  if (!client) throw new Error('Contato não encontrado.');
  await updateClient(input.tenantId, input.clientId, { ai_enabled: input.enabled });
  const name = displayName(client);
  void recordOwnerEvent({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    kind: 'acao',
    summary: input.enabled
      ? `Voltei a responder ${name}`
      : `Parei de responder ${name} (aviso continua, se tiver)`,
    connectionId: input.connectionId,
    source: 'relay',
  });
  return { name, enabled: input.enabled };
}

export async function resolveMuteContact(
  tenantId: string,
  query: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<
  | { ok: true; id: string; name: string }
  | { ok: false; text: string; candidates?: { id: string; name: string | null; phone: string }[] }
> {
  const q = query.trim();
  if (NOT_A_NAME.test(q)) {
    const watches = await listActiveWatches(tenantId, ownerPhone, connectionId);
    const specific = watches.filter((w) => w.client_id);
    if (specific.length === 1 && specific[0]!.client_id) {
      const c = await getClientById(tenantId, specific[0]!.client_id);
      if (c) return { ok: true, id: c.id, name: displayName(c) };
    }
  }

  const hint = extractPhoneHint(q);
  const search = hint && !q.includes(hint) ? `${q} ${hint}` : q;
  const matches = await resolveRelayContacts(tenantId, search, connectionId);
  if (matches.length === 0) {
    return {
      ok: false,
      text: `Não achei *${q}* pra parar/voltar a responder. Manda o nome como no zap.`,
    };
  }
  if (matches.length > 1) {
    const lines = matches.map((c, i) => `${i + 1}. ${displayName(c)} · ${c.phone}`);
    return {
      ok: false,
      text: `Achei mais de um:\n${lines.join('\n')}\n\nManda o *número* da lista.`,
      candidates: matches,
    };
  }
  const only = matches[0]!;
  return { ok: true, id: only.id, name: displayName(only) };
}
