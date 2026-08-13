import { logger } from '../config/logger';
import { findClientByLid, findClientByPhone, getClientById } from '../db/queries/clients';
import {
  cancelContactWatch,
  claimOnceWatch,
  listActiveWatches,
  listActiveWatchesForClient,
  stampWatchNotified,
  touchAlwaysWatch,
  upsertContactWatch,
  type ContactMessageWatch,
  type ContactWatchMode,
} from '../db/queries/contact_watches';
import { isReminderOwner } from '../db/queries/reminders';
import { displayName, resolveRelayContacts, type RelayCandidate } from './owner-relay.service';
import { extractPhoneHint } from '../utils/phone-hint';
import { getTenantWhatsapp, getWhatsappByConnection } from './whatsapp.service';
import { recordOwnerEvent } from './owner-memory.service';

export type WatchIntent =
  | { action: 'create'; scope: 'all'; mode: ContactWatchMode }
  | { action: 'create'; scope: 'one'; contactQuery: string; mode: ContactWatchMode }
  | { action: 'cancel'; scope: 'all' }
  | { action: 'cancel'; scope: 'one'; contactQuery: string }
  | { action: 'list' };

const CONTACT_VERB =
  '(?:mandar|enviar|falar|responder|chamar|ligar|aparecer|escrever|chegar|entrar\\s+em\\s+contato|mandar\\s+(?:mensagem|msg|zap)|dar\\s+(?:um\\s+)?oi)';

/** "te mandar" / "me chamar" — o pronome não faz parte do nome. */
const CLITIC_BEFORE_VERB = '(?:\\s+(?:te|me|lhe|nos|vos|pra\\s+mim|para\\s+mim))?';

const ANYONE_PHRASE =
  /qualquer\s+(?:pessoa|um|uma|contato|gente)|algu[eé]m|todo\s+mundo|todas?\s+(?:as\s+)?pessoas|ningu[eé]m|me\s+avisa\s+de\s+todos/i;

const NOT_A_CONTACT_NAME =
  /^(ela|ele|eles|elas|voce|você|tu|contato|pessoa|esse|essa|isto|isso|alguem|alguém)$/i;

export function looksLikeAnyone(s: string): boolean {
  const t = s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!t) return false;
  return /^(qualquer( pessoa| um| uma| contato| gente)?|alguem|todo mundo|todas?( as)? pessoas|todos|ninguem)$/.test(
    t,
  );
}

function cleanWatchName(raw: string): string {
  return raw
    .trim()
    .replace(/^(o|a|os|as)\s+/i, '')
    .replace(
      new RegExp(
        `\\s+(?:${CONTACT_VERB}|me\\s+avisar|mensagem|msg|zap|whatsapp|no\\s+zap).*$`,
        'i',
      ),
      '',
    )
    .replace(/\s+(?:te|me|lhe|nos|vos|pra\s+mim|para\s+mim|pra\s+voc[eê])\s*$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function extractSpecificName(raw: string): { name: string; always: boolean } | null {
  const always = /\bsempre\s+que\b/i.test(raw);
  const verb = CONTACT_VERB;
  const clitic = CLITIC_BEFORE_VERB;
  const patterns = [
    new RegExp(
      `(?:me\\s+)?avis[ae]\\w*\\s+(?:quando|assim\\s+que|se|caso)\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b`,
      'i',
    ),
    new RegExp(
      `(?:quando|assim\\s+que|se|caso)\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b[\\s\\S]{0,80}\\bavis`,
      'i',
    ),
    new RegExp(
      `quero\\s+que\\s+(?:voc[eê]|vc|tu)?\\s*(?:me\\s+)?avis\\w*\\s+quando\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b`,
      'i',
    ),
    new RegExp(
      `me\\s+(?:chama|toca|notifica)\\s+quando\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b`,
      'i',
    ),
    new RegExp(`sempre\\s+que\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    const name = cleanWatchName(m?.[1] ?? '');
    if (name.length >= 2 && !looksLikeAnyone(name) && !NOT_A_CONTACT_NAME.test(name)) {
      return { name, always };
    }
  }

  // Frase curta: "quando o Wender chamar" / "quando o Jurandir te mandar"
  if (raw.length <= 120 && !ANYONE_PHRASE.test(raw)) {
    const short = raw.match(
      new RegExp(
        `^(?:me\\s+)?(?:avis[ae]\\s+)?(?:quando|assim\\s+que|se)\\s+(?:o\\s+|a\\s+)?(.+?)${clitic}\\s+${verb}\\b`,
        'i',
      ),
    );
    const name = cleanWatchName(short?.[1] ?? '');
    if (name.length >= 2 && !looksLikeAnyone(name) && !NOT_A_CONTACT_NAME.test(name)) {
      return { name, always };
    }
  }

  return null;
}

/** Pedido do dono para ser avisado quando um contato (ou qualquer um) mandar mensagem. */
export function parseWatchIntent(text: string): WatchIntent | null {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  if (
    /^(quais|lista|listar)\s+(os\s+)?avisos\b/i.test(raw) ||
    /^quem\s+(voc[eê]|vc)\s+(est[aá]|t[aá])\s+(vigiando|avisando)/i.test(raw) ||
    /^me\s+avisa\s+de\s+quem/i.test(raw)
  ) {
    return { action: 'list' };
  }

  const cancel = raw.match(
    /^(?:pode\s+)?(?:parar|para|pare|cancela|cancelar|desliga|desligar|n[aã]o\s+(?:precisa|quero)\s+mais)(?:\s+de)?(?:\s+me)?\s+avisar\s+(?:do\s+|da\s+|de\s+|o\s+|a\s+)?(.+)$/i,
  );
  if (cancel) {
    const contactQuery = cleanWatchName(cancel[1] ?? '');
    if (looksLikeAnyone(contactQuery) || (ANYONE_PHRASE.test(raw) && !extractSpecificName(raw))) {
      return { action: 'cancel', scope: 'all' };
    }
    if (contactQuery.length >= 2) return { action: 'cancel', scope: 'one', contactQuery };
  }

  // Contato específico SEMPRE ganha do "qualquer pessoa".
  const specific = extractSpecificName(raw);
  if (specific) {
    const once =
      !specific.always &&
      /\b(pr[oó]xima|dessa vez|s[oó] (?:a |essa )?pr[oó]xima|uma vez)\b/i.test(raw);
    const hint = extractPhoneHint(raw);
    const contactQuery =
      hint && !/\d{4,}/.test(specific.name) ? `${specific.name} ${hint}` : specific.name;
    return {
      action: 'create',
      scope: 'one',
      contactQuery,
      mode: once ? 'once' : 'always',
    };
  }

  if (ANYONE_PHRASE.test(raw) && /avis|notific|me\s+chama|me\s+toca/i.test(raw)) {
    return { action: 'create', scope: 'all', mode: 'always' };
  }

  return null;
}

export async function createWatchForContact(input: {
  tenantId: string;
  ownerPhone: string;
  clientId: string;
  mode: ContactWatchMode;
  connectionId?: string | null;
}): Promise<{ name: string; mode: ContactWatchMode }> {
  const client = await getClientById(input.tenantId, input.clientId);
  if (!client) throw new Error('Contato não encontrado.');
  await upsertContactWatch({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    clientId: input.clientId,
    mode: input.mode,
    connectionId: input.connectionId,
  });
  const name = displayName(client);
  void recordOwnerEvent({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    kind: 'acao',
    summary:
      input.mode === 'always'
        ? `Vou avisar sempre que ${name} mandar mensagem`
        : `Vou avisar quando ${name} mandar mensagem`,
    connectionId: input.connectionId,
    source: 'watch',
  });
  return { name, mode: input.mode };
}

export async function createWatchForAnyone(input: {
  tenantId: string;
  ownerPhone: string;
  connectionId?: string | null;
}): Promise<void> {
  await upsertContactWatch({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    clientId: null,
    mode: 'always',
    connectionId: input.connectionId,
  });
  void recordOwnerEvent({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    kind: 'acao',
    summary: 'Vou avisar quando qualquer pessoa mandar mensagem neste WhatsApp',
    connectionId: input.connectionId,
    source: 'watch',
  });
}

export async function cancelWatchForAnyone(input: {
  tenantId: string;
  ownerPhone: string;
  connectionId?: string | null;
}): Promise<boolean> {
  return cancelContactWatch({
    tenantId: input.tenantId,
    ownerPhone: input.ownerPhone,
    clientId: null,
    connectionId: input.connectionId,
  });
}

export async function cancelWatchForContact(input: {
  tenantId: string;
  ownerPhone: string;
  clientId: string;
  connectionId?: string | null;
}): Promise<{ ok: boolean; name: string }> {
  const client = await getClientById(input.tenantId, input.clientId);
  const name = client ? displayName(client) : 'esse contato';
  const ok = await cancelContactWatch(input);
  return { ok, name };
}

export async function formatWatchList(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<string> {
  const rows = await listActiveWatches(tenantId, ownerPhone, connectionId);
  if (!rows.length) {
    return (
      'Nenhum aviso ativo. Manda _"me avisa quando o Wender mandar mensagem"_ ' +
      'ou _"me avisa quando qualquer pessoa mandar mensagem"_.'
    );
  }
  const lines = rows.map((w) => {
    if (!w.client_id) return '• qualquer pessoa (sempre — um toque por contato)';
    const who = (w.client_name && w.client_name.trim()) || w.client_phone || w.client_id;
    const how = w.mode === 'always' ? 'sempre' : 'próxima msg';
    return `• ${who} (${how})`;
  });
  return `Te aviso destes:\n${lines.join('\n')}`;
}

function previewLine(preview: string | null, type: string): string {
  const t = (preview ?? '').trim();
  if (t) {
    const cut = t.length > 240 ? `${t.slice(0, 237)}…` : t;
    return `"${cut}"`;
  }
  if (type === 'image') return 'uma foto';
  if (type === 'audio') return 'um áudio';
  if (type === 'video') return 'um vídeo';
  return 'uma mensagem';
}

/** Debounce por (aviso global + contato): não silencia os outros. */
const globalPerClientAt = new Map<string, number>();
const GLOBAL_PER_CLIENT_MS = 90_000;

function claimGlobalForClient(watchId: string, clientId: string): boolean {
  const key = `${watchId}:${clientId}`;
  const last = globalPerClientAt.get(key) ?? 0;
  if (Date.now() - last < GLOBAL_PER_CLIENT_MS) return false;
  globalPerClientAt.set(key, Date.now());
  return true;
}

/**
 * Contato com aviso específico ativo (não é o dono). Com acesso livre, essa
 * pessoa continua sendo CONTATO — a secretária não pode engolir a mensagem
 * e deixar de avisar o dono.
 */
export async function senderHasSpecificWatch(
  tenantId: string,
  phone: string,
  lid?: string | null,
  connectionId?: string | null,
): Promise<boolean> {
  let client = phone ? await findClientByPhone(tenantId, phone) : null;
  if (!client && lid) client = await findClientByLid(tenantId, lid);
  if (!client && phone) client = await findClientByLid(tenantId, phone);
  if (!client) return false;
  const watches = await listActiveWatchesForClient(tenantId, client.id, connectionId);
  return watches.some((w) => w.client_id != null && w.owner_phone !== phone);
}

function pickWatchPerOwner(watches: ContactMessageWatch[]): ContactMessageWatch[] {
  const byOwner = new Map<string, ContactMessageWatch>();
  for (const w of watches) {
    const prev = byOwner.get(w.owner_phone);
    if (!prev) {
      byOwner.set(w.owner_phone, w);
      continue;
    }
    // Específico ganha do "qualquer pessoa" (um toque só).
    if (prev.client_id == null && w.client_id) byOwner.set(w.owner_phone, w);
  }
  return [...byOwner.values()];
}

/**
 * Dispara avisos quando um contato manda inbound.
 * Best-effort: falha de um dono não impede os outros nem o atendimento.
 * Aviso global: um toque por pessoa, sem limite de quantos falarem.
 */
export async function notifyContactWatches(input: {
  tenantId: string;
  clientId: string;
  clientName: string;
  clientPhone: string;
  connectionId?: string | null;
  preview: string | null;
  inboundType: string;
}): Promise<void> {
  const watches = pickWatchPerOwner(
    await listActiveWatchesForClient(input.tenantId, input.clientId, input.connectionId),
  );
  if (!watches.length) return;

  const wa = input.connectionId
    ? await getWhatsappByConnection(input.tenantId, input.connectionId)
    : await getTenantWhatsapp(input.tenantId);

  const snippet = previewLine(input.preview, input.inboundType);
  const quoted = snippet.startsWith('"');

  for (const watch of watches) {
    try {
      if (watch.owner_phone === input.clientPhone) continue;

      const isAnyone = watch.client_id == null;
      let claimed = false;
      if (isAnyone) {
        claimed = claimGlobalForClient(watch.id, input.clientId);
        if (claimed) void stampWatchNotified(input.tenantId, watch.id);
      } else if (watch.mode === 'once') {
        claimed = await claimOnceWatch(input.tenantId, watch.id);
      } else {
        claimed = await touchAlwaysWatch(input.tenantId, watch.id);
      }
      if (!claimed) continue;

      const body = quoted
        ? `*${input.clientName}* mandou:\n${snippet}`
        : `*${input.clientName}* mandou ${snippet}.`;
      const footer = isAnyone
        ? '\n\n(aviso de qualquer pessoa — continuo. Manda _"para de me avisar de todo mundo"_ pra parar.)'
        : watch.mode === 'once'
          ? '\n\n(aviso único — já tirei da lista)'
          : '\n\n(continuo te avisando. Manda _"para de me avisar do ' +
            input.clientName +
            '"_ pra parar.)';

      await wa.sendText(watch.owner_phone, `${body}${footer}`);
      logger.info(
        `Aviso de contato: ${input.clientName} → dono ${watch.owner_phone} (${isAnyone ? 'anyone' : watch.mode})`,
      );
    } catch (err) {
      logger.warn(`Falha ao avisar dono ${watch.owner_phone} sobre ${input.clientName}`, err);
    }
  }
}

export async function resolveWatchContact(
  tenantId: string,
  query: string,
  connectionId?: string | null,
): Promise<
  | { ok: true; id: string; name: string; phone: string }
  | { ok: false; text: string; candidates?: RelayCandidate[] }
> {
  const matches = await resolveRelayContacts(tenantId, query, connectionId);
  if (matches.length === 0) {
    return {
      ok: false,
      text:
        `Não achei *${query}* nas conversas nem na agenda deste WhatsApp. ` +
        'Manda o nome como aparece no zap (pode ter emoji). Se for esposa/marido, o nome com a aliança também vale.',
    };
  }
  if (matches.length > 1) {
    const lines = matches.map((c, i) => `${i + 1}. ${displayName(c)} · ${c.phone}`);
    return {
      ok: false,
      text: `Achei mais de um:\n${lines.join('\n')}\n\nManda o *número* pra eu cadastrar o aviso, ou *não* pra cancelar.`,
      candidates: matches,
    };
  }
  const only = matches[0]!;
  return { ok: true, id: only.id, name: displayName(only), phone: only.phone };
}

export async function assertListedOwner(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): Promise<boolean> {
  return isReminderOwner(tenantId, ownerPhone, connectionId);
}
