import { logger } from '../config/logger';
import { findClientsByName, getClientById } from '../db/queries/clients';
import {
  clearHumanPause,
  findOrCreateOpenConversation,
} from '../db/queries/conversations';
import type { Client } from '../types';
import { extractPhoneHint, phoneMatchesHint } from '../utils/phone-hint';
import { dispatchText } from './dispatch.service';

/**
 * Secretária envia mensagem a um contato da lista (clients) a pedido do dono.
 * Ex.: "mande um boa noite para o wender agora"
 */

export interface ParsedRelay {
  body: string;
  contactQuery: string;
}

export interface RelayCandidate {
  id: string;
  name: string | null;
  phone: string;
}

/** Corpo genérico demais ("mensagem") — não envia lixo. */
function isGenericBody(body: string): boolean {
  return /^(mensagem|msg|texto|uma mensagem|a mensagem)$/i.test(body.trim());
}

/** Detecta pedido de envio a contato. Retorna null se não for o caso. */
export function parseRelayIntent(text: string): ParsedRelay | null {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  // "manda mensagem pro wender: boa noite" / "manda uma msg pra maria - oi"
  const d = raw.match(
    /^(?:me\s+)?(?:manda|mande|envia|envie)\s+(?:uma?\s+)?(?:mensagem|msg|texto)\s+(?:pro|pra|para\s+o|para\s+a|para)\s+(.+?)\s*[:\-–]\s*(.+)$/i,
  );
  if (d) {
    const contactQuery = cleanName(d[1]);
    const body = cleanBody(d[2]);
    if (body && contactQuery && !isGenericBody(body)) return { body, contactQuery };
  }

  // "manda pro wender dizendo boa noite" / "envia pra maria falando que chego"
  const e = raw.match(
    /^(?:me\s+)?(?:manda|mande|envia|envie)\s+(?:pro|pra|para\s+o|para\s+a|para)\s+(.+?)\s+(?:dizendo|falando)\s+(?:que\s+)?(.+)$/i,
  );
  if (e) {
    const contactQuery = cleanName(e[1]);
    const body = cleanBody(e[2]);
    if (body && contactQuery && !isGenericBody(body)) return { body, contactQuery };
  }

  // "mande um boa noite para o wender agora"
  // "manda oi pro joão"
  // "envie feliz aniversário para a maria"
  const a = raw.match(
    /^(?:me\s+)?(?:manda|mande|envia|envie)\s+(?:um\s+|uma\s+)?(.+?)\s+(?:para\s+o\s+|para\s+a\s+|para\s+|pro\s+|pra\s+)(.+?)(?:\s+agora)?[.!?]?\s*$/i,
  );
  if (a) {
    const body = cleanBody(a[1]);
    const contactQuery = cleanName(a[2]);
    if (
      body &&
      contactQuery &&
      !looksLikeReminderOnly(body) &&
      !isGenericBody(body) &&
      !/^(mensagem|msg|texto)$/i.test(body)
    ) {
      return { body, contactQuery };
    }
  }

  // "manda pro wender: boa noite" / "envia pra maria - tudo bem?"
  const b = raw.match(
    /^(?:me\s+)?(?:manda|mande|envia|envie)\s+(?:pro|pra|para\s+o|para\s+a|para)\s+(.+?)\s*[:\-–]\s*(.+)$/i,
  );
  if (b) {
    const contactQuery = cleanName(b[1]);
    const body = cleanBody(b[2]);
    if (body && contactQuery && !isGenericBody(body)) return { body, contactQuery };
  }

  // "diz pro wender que vou atrasar" / "fala pra maria que chego já"
  const c = raw.match(
    /^(?:diz|diga|fala|fale)\s+(?:pro|pra|para\s+o|para\s+a|para)\s+(.+?)\s+que\s+(.+)$/i,
  );
  if (c) {
    const contactQuery = cleanName(c[1]);
    const body = cleanBody(c[2]);
    if (body && contactQuery && !isGenericBody(body)) return { body, contactQuery };
  }

  return null;
}

function cleanBody(s: string): string {
  const t = s
    .trim()
    .replace(/^(um|uma|o|a)\s+/i, '')
    .replace(/\s+agora$/i, '')
    .trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cleanName(s: string): string {
  return s
    .trim()
    .replace(/^(o|a|os|as)\s+/i, '')
    .replace(/\s+agora$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

/** Evita "mande me lembrar amanhã" ser tratado como relay. */
function looksLikeReminderOnly(body: string): boolean {
  return /\b(lembr|anota|agenda|compromisso)\b/i.test(body);
}

export async function resolveRelayContacts(
  tenantId: string,
  nameQuery: string,
  connectionId?: string | null,
): Promise<RelayCandidate[]> {
  const rows = await findClientsByName(tenantId, nameQuery, { connectionId, limit: 8 });
  const mapped = rows.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }));
  const hint = extractPhoneHint(nameQuery);
  if (!hint) return mapped;
  const narrowed = mapped.filter((c) => phoneMatchesHint(c.phone, hint));
  return narrowed.length ? narrowed : mapped;
}

/** Escolha na lista: "1"/"2" ou o final do telefone ("3934", "final 3934"). */
export function pickRelayCandidate(
  candidates: RelayCandidate[],
  reply: string,
): RelayCandidate | null {
  const hint = extractPhoneHint(reply);
  if (hint && hint.length >= 4) {
    const hits = candidates.filter((c) => phoneMatchesHint(c.phone, hint));
    if (hits.length === 1) return hits[0]!;
  }
  const idx = reply.trim().match(/^(\d{1,2})$/);
  if (!idx) return null;
  return candidates[Number(idx[1]) - 1] ?? null;
}

export function displayName(c: Pick<Client, 'name' | 'phone'> | RelayCandidate): string {
  return (c.name && c.name.trim()) || c.phone;
}

/**
 * Envia ao contato pela mesma conexão WhatsApp e registra na conversa do painel.
 */
export async function sendOwnerRelay(opts: {
  tenantId: string;
  connectionId?: string | null;
  clientId: string;
  body: string;
}): Promise<{ ok: true; name: string; phone: string } | { ok: false; error: string }> {
  const client = await getClientById(opts.tenantId, opts.clientId);
  if (!client) return { ok: false, error: 'Contato não encontrado.' };

  const conversation = await findOrCreateOpenConversation(
    opts.tenantId,
    client.id,
    opts.connectionId ?? null,
  );
  // Libera pausa humana para o atendimento automático poder seguir depois.
  await clearHumanPause(opts.tenantId, conversation.id).catch(() => null);
  try {
    // Pedido do dono sem inbound do contato = proativo (SAFE_MODE bloqueia).
    await dispatchText(
      { conversation, client },
      opts.body,
      { origin: 'ai', sendType: 'proactive' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Falha ao enviar.';
    logger.warn(`Secretária: relay bloqueado/falhou para ${client.phone}: ${msg}`);
    return { ok: false, error: msg };
  }
  logger.info(
    `Secretária: relay para ${client.phone} (${displayName(client)}) via ${opts.connectionId ?? 'default'}.`,
  );
  return { ok: true, name: displayName(client), phone: client.phone };
}
