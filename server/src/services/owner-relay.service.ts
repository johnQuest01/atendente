import { logger } from '../config/logger';
import { findClientsByName, getClientById } from '../db/queries/clients';
import {
  clearHumanPause,
  findOrCreateOpenConversation,
} from '../db/queries/conversations';
import { getLastInboundMessage } from '../db/queries/messages';
import type { Client } from '../types';
import { extractPhoneHint, phoneMatchesHint } from '../utils/phone-hint';
import { dispatchText } from './dispatch.service';
import { preferKnownContact, rememberContactChoice } from './owner-contact-memory.service';

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

/** Tira prefixo de áudio / vocativo pra regex de envio casar. */
export function stripOwnerLead(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^\[áudio\]\s*/i, '')
    .replace(/^(paulo|secret[aá]rio)[,.]?\s+/i, '')
    .trim();
}

/** Pedido de FALAR com um contato (manda / diga / se apresente), explícito ou “pra ele”. */
export function looksLikeSendToContact(text: string): boolean {
  const t = stripOwnerLead(text);
  if (!t) return false;
  if (parseRelayIntent(t)) return true;
  const retry =
    /\b(tente|tenta|manda|mande|envia|envie|reenvia|reenvie)\b.{0,40}\b(de novo|denovo|novamente|outra vez)\b/i;
  const failed =
    /\b(n[aã]o (saiu|foi enviado|foi entregue|apareceu|chegou)|n[aã]o est[aá] enviando)\b/i;
  if (retry.test(t) || failed.test(t)) return true;
  const speak =
    /\b(diga|diz|fala|fale|manda|mande|envia|envie|avise|avisa|mostre|mostra|se apresente|apresente-se|apresentar?)\b/i;
  const lastRef = /\b(dele|dela|nele|nela|pra ele|pra ela|para ele|para ela|nesse contato|neste contato)\b/i;
  const payload =
    /\b(boa\s+noite|bom\s+dia|boa\s+tarde|disposi[cç][aã]o|se apresent|apresente|oi\b|ol[aá]\b)\b/i;
  const named =
    /\b(diga|diz|fala|fale|manda|mande|envia|envie|avise|avisa|mostre|mostra)\b.{0,12}\b(para o|para a|para|pro|pra)\b.{0,80}\b[a-zà-ÿ]{3,}/i;
  return (speak.test(t) && (lastRef.test(t) || payload.test(t))) || named.test(t);
}

/** "sim" / "isto" depois do Paulo perguntar se manda. */
export function looksLikeConfirmOutbound(text: string): boolean {
  const t = stripOwnerLead(text).replace(/[.!?]+$/g, '').trim();
  return /^(sim|isso|isto|pode|manda|mande|envia|envie|positivo|ok|okay|blz|beleza|confirmo|confirmar|confirma)(?:\s+paulo)?$/i.test(t);
}

/**
 * Fala do dono tem VERBO DE ENVIO EXPLÍCITO da whitelist fixa e pequena.
 * É o único gatilho que dispensa confirmação (com contato único). Puro, sem efeito.
 */
export function hasClearSendVerb(text: string): boolean {
  const t = stripOwnerLead(text);
  return /\b(manda|mande|envia|envie|diz|diga|fala|fale)\b/i.test(t);
}

/** Fala do dono é negação clara ("não", "cancela", "deixa", "para", "esquece"). */
export function looksLikeDenyOutbound(text: string): boolean {
  const t = stripOwnerLead(text).replace(/[.!?]+$/g, '').trim();
  return /^(n[aã]o|nao|negativo|cancela|cancelar|cancele|deixa(?:\s+pra\s+l[aá])?|para|pare|esquece|esque[cç]a|nem)(?:\s+paulo)?$/i.test(t);
}

export function assistantOfferedToSend(text: string): boolean {
  return /quer que eu mande|mando (essa|isto|isso|a lista)|posso mandar|envio (pra|para) (ele|ela)|mensagem entregue|mandei (a lista|de verdade|agora)/i.test(
    text,
  );
}

export function assistantClaimedSend(text: string): boolean {
  return /\b(mandei|enviei|mensagem entregue)\b/i.test(text);
}

const SEND_TO_LEAD =
  /^(?:me\s+)?(?:avise|avisa|fale|fala|diga|diz|mande|manda|envie|envia)\s+(?:para\s+o\s+|para\s+a\s+|para\s+|pro\s+|pra\s+)(?:contato\s+(?:o|a)\s+)?(.+)$/i;

const NAME_BLOCKLIST =
  /^(me|te|se|ele|ela|aqui|la|lá|salvar|lembrar|criar|mandar|enviar|falar|compromisso|compromissos|novamente|novo|novos|voce|você|paulo|mensagem|msg|texto|hoje|amanha|amanhã|agora)$/i;

function looksLikePersonName(s: string): boolean {
  const t = cleanName(s);
  if (!t || t.length < 3 || t.length > 80) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 6) return false;
  if (words.some((w) => NAME_BLOCKLIST.test(w))) return false;
  return words.every((w) => /^(d[aeo]s?|[A-Za-zÀ-ÿ]{2,})$/i.test(w));
}

function splitNameAndBody(rest: string): { name: string; body: string } | null {
  const avisando = rest.match(/^(.+?)\s*,?\s*avisando\s+que\s+(.+)$/i);
  if (avisando && looksLikePersonName(avisando[1]!)) {
    return { name: avisando[1]!, body: avisando[2]! };
  }
  const que = rest.match(/^(.+?)\s+que\s+(.+)$/i);
  if (que && looksLikePersonName(que[1]!) && que[1]!.split(/\s+/).length <= 6) {
    return { name: que[1]!, body: que[2]! };
  }
  const comma = rest.match(/^(.+?),+\s*(.+)$/);
  if (comma && looksLikePersonName(comma[1]!)) {
    return { name: comma[1]!, body: comma[2]! };
  }
  const period = rest.match(/^(.+?)\.\s+(.+)$/);
  if (period && looksLikePersonName(period[1]!)) {
    return { name: period[1]!, body: period[2]! };
  }
  return null;
}

function cleanOutboundBody(s: string): string {
  return s
    .replace(/\s*(?:fale|fala|diga|diz)\s+assim\s+para\s+(?:o|a)\s+.+?$/i, '')
    .replace(/\s*,?\s*por favor[.!]?\s*$/i, '')
    .trim();
}

/** "fale/avise/envie para o NOME, recado" — forma falada, sem "dizendo". */
function parseSendToLead(raw: string): ParsedRelay | null {
  const m = raw.match(SEND_TO_LEAD);
  if (!m) return null;
  const split = splitNameAndBody(m[1]!.trim());
  if (!split) return null;
  const contactQuery = cleanName(split.name);
  const body = cleanOutboundBody(cleanBody(split.body));
  if (!body || !contactQuery || isGenericBody(body) || !looksLikePersonName(contactQuery)) {
    return null;
  }
  return { body, contactQuery };
}

/** Detecta pedido de envio a contato. Retorna null se não for o caso. */
export function parseRelayIntent(text: string): ParsedRelay | null {
  const raw = stripOwnerLead(text);
  if (!raw) return null;

  const spoken = parseSendToLead(raw);
  if (spoken) return spoken;

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

  // "diga um boa noite para o weberson" / "fala pra maria que chego"
  const speakTo = raw.match(
    /^(?:diga|diz|fala|fale)\s+(?:um\s+|uma\s+)?(.+?)\s+(?:para\s+o\s+|para\s+a\s+|para\s+|pro\s+|pra\s+)(.+?)(?:\s+agora)?[.!?]?\s*$/i,
  );
  if (speakTo) {
    const body = cleanBody(speakTo[1]);
    const contactQuery = cleanName(speakTo[2]);
    if (body && contactQuery && !looksLikeReminderOnly(body) && !isGenericBody(body)) {
      return { body, contactQuery };
    }
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
  ownerPhone?: string | null,
): Promise<RelayCandidate[]> {
  const rows = await findClientsByName(tenantId, nameQuery, { connectionId, limit: 8 });
  const mapped = rows.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }));
  const hint = extractPhoneHint(nameQuery);
  let result = mapped;
  if (hint) {
    const narrowed = mapped.filter((c) => phoneMatchesHint(c.phone, hint));
    if (narrowed.length) result = narrowed;
  }

  if (ownerPhone && result.length > 1) {
    const preferred = await preferKnownContact({
      tenantId,
      ownerPhone,
      query: nameQuery,
      candidates: result,
      connectionId,
    });
    if (preferred?.length === 1) result = preferred;
  }

  if (ownerPhone && result.length === 1) {
    const only = result[0]!;
    void rememberContactChoice({
      tenantId,
      ownerPhone,
      query: nameQuery,
      clientId: only.id,
      name: only.name,
      phone: only.phone,
      connectionId,
    });
  }

  return result;
}

/** "1", "o primeiro", "a segunda", "opção 3" — índice 1-based ou null. */
export function parseListChoice(reply: string): number | null {
  const t = stripOwnerLead(reply)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) return Number(t);
  const named: Record<string, number> = {
    primeiro: 1,
    primeira: 1,
    'o primeiro': 1,
    'a primeira': 1,
    'o 1': 1,
    segundo: 2,
    segunda: 2,
    'o segundo': 2,
    'a segunda': 2,
    'o 2': 2,
    terceiro: 3,
    terceira: 3,
    'o terceiro': 3,
    'a terceira': 3,
    quarto: 4,
    quarta: 4,
    'o quarto': 4,
    quinto: 5,
    quinta: 5,
    'o quinto': 5,
  };
  if (named[t] != null) return named[t]!;
  const m = t.match(/^(?:o|a|opcao|numero|nro|item)\s*(\d{1,2})$/);
  if (m) return Number(m[1]);
  return null;
}

/** Escolha na lista: "1"/"2", "o primeiro" ou o final do telefone ("3934"). */
export function pickRelayCandidate(
  candidates: RelayCandidate[],
  reply: string,
): RelayCandidate | null {
  const hint = extractPhoneHint(reply);
  if (hint && hint.length >= 4) {
    const hits = candidates.filter((c) => phoneMatchesHint(c.phone, hint));
    if (hits.length === 1) return hits[0]!;
  }
  const n = parseListChoice(reply);
  if (n == null) return null;
  return candidates[n - 1] ?? null;
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
  const lastIn = await getLastInboundMessage(opts.tenantId, conversation.id).catch(() => null);
  try {
    await dispatchText(
      { conversation, client },
      opts.body,
      {
        origin: 'ai',
        // Todo sendOwnerRelay é envio autorizado pelo dono (direto ou via
        // reminder criado por ele). O gate libera owner_authorized sob
        // SAFE_MODE sem abrir proativo/campanha.
        sendType: 'owner_authorized',
        triggeringInboundId: lastIn?.id,
      },
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

// Removidos de propósito: `fulfillMissingOwnerSend`, `composeSendBody` e
// `extractQuotedOutbound`. Eram o caminho que, quando a IA AFIRMAVA ter
// enviado sem chamar a tool, pegava o TEXTO/RACIOCÍNIO da própria IA e o
// mandava pro contato — vazando comentário do modelo pra terceiros.
// O envio agora só sai pelo caminho gated de plano (owner-pending), nunca
// carregando texto do modelo. NÃO recrie estas funções.
