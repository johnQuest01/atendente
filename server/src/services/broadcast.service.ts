import { logger } from '../config/logger';
import {
  countSentToday,
  countTargets,
  getBroadcast,
  getTargetClient,
  listDueBroadcasts,
  claimNextPendingTarget,
  markTargetFailed,
  markTargetSkipped,
  setBroadcastStatus,
  type Broadcast,
} from '../db/queries/broadcasts';
import { findOpenConversationByClient, findOrCreateOpenConversation } from '../db/queries/conversations';
import { isPhoneBlocked } from '../db/queries/blocked';
import { isTenantBlocked } from '../middleware/tenantAccess.middleware';
import { dispatchAudio, dispatchProduct, dispatchText } from './dispatch.service';
import { getTenantWhatsapp, getWhatsappByConnection } from './whatsapp.service';
import type { Client, Conversation } from '../types';
import { queryOne } from '../db';
import { getConnectionById } from '../db/queries/whatsapp_connections';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs: number, maxMs: number): number {
  const a = Math.max(3000, minMs);
  const b = Math.max(a, maxMs);
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function loadClient(tenantId: string, clientId: string): Promise<Client | null> {
  return queryOne<Client>(`SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    clientId,
  ]);
}

async function sendOne(broadcast: Broadcast, client: Client, conversation: Conversation): Promise<void> {
  const ctx = { conversation, client };
  const proactive = { sendType: 'proactive' as const };
  if (broadcast.content_type === 'audio' && broadcast.content_ref) {
    const msg = await dispatchAudio(ctx, broadcast.content_ref, proactive);
    if (!msg) throw new Error('Áudio indisponível');
    return;
  }
  if (broadcast.content_type === 'product' && broadcast.content_ref) {
    const msg = await dispatchProduct(ctx, broadcast.content_ref, {
      withPrice: broadcast.with_price,
      ...proactive,
    });
    if (!msg) throw new Error('Produto indisponível');
    return;
  }
  const text = broadcast.body_text?.trim();
  if (!text) throw new Error('Texto da campanha vazio');
  // Variação mínima: cumprimenta pelo nome quando houver.
  const personalized = client.name
    ? text.replace(/\{\{client_name\}\}/gi, client.name)
    : text.replace(/\{\{client_name\}\}/gi, 'tudo bem');
  await dispatchText(ctx, personalized, { origin: 'system', ...proactive });
}

/**
 * Processa UMA campanha: envia alvos pendentes com throttle/jitter e teto diário.
 * Idempotente por status do alvo (não reenvia 'sent').
 */
export async function processBroadcast(broadcast: Broadcast): Promise<void> {
  if (await isTenantBlocked(broadcast.tenant_id)) {
    logger.info(`Broadcast ${broadcast.id}: tenant bloqueado — pausando.`);
    await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'paused');
    return;
  }

  await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'running', { started: true });

  // Isolamento: envia SEMPRE pela instância escolhida na campanha.
  let wa;
  if (broadcast.connection_id) {
    const conn = await getConnectionById(broadcast.tenant_id, broadcast.connection_id);
    if (!conn) {
      logger.warn(`Broadcast ${broadcast.id}: connection_id inválido — pausando.`);
      await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'paused');
      return;
    }
    wa = await getWhatsappByConnection(broadcast.tenant_id, broadcast.connection_id);
  } else {
    wa = await getTenantWhatsapp(broadcast.tenant_id);
  }
  if (!wa.configured) {
    logger.warn(`Broadcast ${broadcast.id}: WhatsApp não configurado.`);
    await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'paused');
    return;
  }

  const connectionId = broadcast.connection_id;

  // Loop curto por tick do scheduler — não prende o processo por horas.
  const maxPerTick = 8;
  for (let i = 0; i < maxPerTick; i++) {
    const sentToday = await countSentToday(broadcast.tenant_id);
    if (sentToday >= broadcast.daily_cap) {
      logger.info(`Broadcast ${broadcast.id}: teto diário (${broadcast.daily_cap}) atingido.`);
      break;
    }

    const target = await claimNextPendingTarget(broadcast.id);
    if (!target) {
      await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'done', { finished: true });
      return;
    }

    if (await isPhoneBlocked(broadcast.tenant_id, target.phone)) {
      await markTargetSkipped(target.id, 'Número bloqueado');
      continue;
    }

    const client = await loadClient(broadcast.tenant_id, target.client_id);
    if (!client) {
      await markTargetSkipped(target.id, 'Cliente não encontrado');
      continue;
    }

    try {
      const existing = await findOpenConversationByClient(
        broadcast.tenant_id,
        client.id,
        connectionId,
      );
      const conversation =
        existing ??
        (await findOrCreateOpenConversation(broadcast.tenant_id, client.id, connectionId));
      await sendOne(broadcast, client, conversation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha no envio';
      logger.warn(`Broadcast alvo ${target.id} falhou: ${msg}`);
      await markTargetFailed(target.id, msg);
    }

    await sleep(jitter(broadcast.throttle_min_ms, broadcast.throttle_max_ms));
  }

  const counts = await countTargets(broadcast.tenant_id, broadcast.id);
  if (counts.pending === 0) {
    await setBroadcastStatus(broadcast.tenant_id, broadcast.id, 'done', { finished: true });
  }
}

/** Chamado pelo scheduler a cada minuto. */
export async function tickBroadcasts(): Promise<void> {
  const due = await listDueBroadcasts();
  for (const b of due) {
    try {
      await processBroadcast(b);
    } catch (err) {
      logger.warn(`Broadcast ${b.id}: erro no processamento`, err);
    }
  }
}

export async function getBroadcastProgress(tenantId: string, id: string) {
  const broadcast = await getBroadcast(tenantId, id);
  if (!broadcast) return null;
  const counts = await countTargets(tenantId, id);
  return { broadcast, counts };
}

export { getTargetClient };
