import { logger } from '../config/logger';
import { getClientById } from '../db/queries/clients';
import {
  cancelContactWatch,
  claimOnceWatch,
  listActiveWatches,
  listActiveWatchesForClient,
  touchAlwaysWatch,
  upsertContactWatch,
  type ContactWatchMode,
} from '../db/queries/contact_watches';
import { isReminderOwner } from '../db/queries/reminders';
import { displayName, resolveRelayContacts, type RelayCandidate } from './owner-relay.service';
import { getTenantWhatsapp, getWhatsappByConnection } from './whatsapp.service';
import { recordOwnerEvent } from './owner-memory.service';

export type WatchIntent =
  | { action: 'create'; contactQuery: string; mode: ContactWatchMode }
  | { action: 'cancel'; contactQuery: string }
  | { action: 'list' };

function cleanWatchName(raw: string): string {
  return raw
    .trim()
    .replace(/^(o|a|os|as)\s+/i, '')
    .replace(/\s+(?:mandar|enviar|falar|responder|me\s+avisar).*$/i, '')
    .replace(/\s+(?:mensagem|msg|zap|whatsapp|no\s+zap).*$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

/** Pedido do dono para ser avisado quando um contato mandar mensagem. */
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
    /^(?:pode\s+)?(?:parar|para|pare|cancela|cancelar|desliga|desligar)(?:\s+de)?(?:\s+me)?\s+avisar\s+(?:do\s+|da\s+|de\s+|o\s+|a\s+)?(.+)$/i,
  );
  if (cancel) {
    const contactQuery = cleanWatchName(cancel[1] ?? '');
    if (contactQuery.length >= 2) return { action: 'cancel', contactQuery };
  }

  const always = raw.match(
    /sempre\s+que\s+(?:o\s+|a\s+)?(.+?)\s+(?:mandar|enviar|falar|responder)\b/i,
  );
  if (always) {
    const contactQuery = cleanWatchName(always[1] ?? '');
    if (contactQuery.length >= 2) return { action: 'create', contactQuery, mode: 'always' };
  }

  const create =
    raw.match(
      /(?:me\s+)?avis[ae](?:\s+quando|\s+assim\s+que)\s+(?:o\s+|a\s+)?(.+?)\s+(?:mandar|enviar|falar|responder)\b/i,
    ) ||
    raw.match(
      /quando\s+(?:o\s+|a\s+)?(.+?)\s+(?:mandar|enviar|falar|responder)\b.+\bavis/i,
    );
  if (create) {
    const contactQuery = cleanWatchName(create[1] ?? '');
    if (contactQuery.length >= 2) return { action: 'create', contactQuery, mode: 'once' };
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
  if (!rows.length) return 'Nenhum aviso ativo. Manda _"me avisa quando o Wender mandar mensagem"_.';
  const lines = rows.map((w) => {
    const who = (w.client_name && w.client_name.trim()) || w.client_phone || w.client_id;
    const how = w.mode === 'always' ? 'sempre' : 'próxima msg';
    return `• ${who} (${how})`;
  });
  return `Te aviso destes contatos:\n${lines.join('\n')}`;
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

/**
 * Dispara avisos quando um contato manda inbound.
 * Best-effort: falha de um dono não impede os outros nem o atendimento.
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
  const watches = await listActiveWatchesForClient(
    input.tenantId,
    input.clientId,
    input.connectionId,
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

      let claimed = false;
      if (watch.mode === 'once') {
        claimed = await claimOnceWatch(input.tenantId, watch.id);
      } else {
        claimed = await touchAlwaysWatch(input.tenantId, watch.id);
      }
      if (!claimed) continue;

      const body = quoted
        ? `*${input.clientName}* mandou:\n${snippet}`
        : `*${input.clientName}* mandou ${snippet}.`;
      const footer =
        watch.mode === 'once'
          ? '\n\n(aviso único — já tirei da lista)'
          : '\n\n(continuo te avisando. Manda _"para de me avisar do ' +
            input.clientName +
            '"_ pra parar.)';

      await wa.sendText(watch.owner_phone, `${body}${footer}`);
      logger.info(
        `Aviso de contato: ${input.clientName} → dono ${watch.owner_phone} (${watch.mode})`,
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
      text: `Não achei *${query}* nos contatos. O nome precisa estar na agenda (quem já conversou ou foi importado).`,
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
