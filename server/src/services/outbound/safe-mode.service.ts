/**
 * SAFE_MODE — alavanca mestre inbound-only.
 * Ligada (padrão): só envio reactive com triggeringInboundId.
 * Desligada: bypass total, sem aviso por mensagem (banner no app).
 */

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import {
  clearSafeModeCacheEntry,
  getSafeModeCacheEntry,
  readSetting,
  SAFE_MODE_SETTING_KEY,
  setSafeModeCacheEntry,
  safeModeCacheTtlMs,
  writeSetting,
} from '../../db/queries/settings';
import { emitSendBlocked } from '../../socket';
import { AppError } from '../../utils/errors';
import type { OutboundMeta } from './types';

export const SAFE_MODE_OPERATOR_MESSAGE =
  'Modo inbound-only: não inicio conversa, só respondo quem me chama.';

export class OutboundBlockedError extends AppError {
  constructor(message = SAFE_MODE_OPERATOR_MESSAGE) {
    super(message, 403, 'SAFE_MODE_BLOCKED');
  }
}

/** Default true (reativo puro). Setting do tenant sobrescreve; senão usa env.SAFE_MODE. */
export async function isSafeModeEnabled(tenantId: string): Promise<boolean> {
  const cached = getSafeModeCacheEntry(tenantId);
  if (cached && Date.now() - cached.at < safeModeCacheTtlMs()) {
    return cached.enabled;
  }
  const value = await readSetting(tenantId, SAFE_MODE_SETTING_KEY);
  const enabled = value === null ? env.SAFE_MODE : value === 'true';
  setSafeModeCacheEntry(tenantId, enabled);
  return enabled;
}

export async function setSafeModeEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
  await writeSetting(tenantId, SAFE_MODE_SETTING_KEY, enabled ? 'true' : 'false');
  setSafeModeCacheEntry(tenantId, enabled);
  return enabled;
}

export function bustSafeModeCache(tenantId: string): void {
  clearSafeModeCacheEntry(tenantId);
}

/**
 * Gate inescapável para envio a CLIENTE.
 * SAFE_MODE off → passa. SAFE_MODE on → só reactive com triggeringInboundId.
 */
export async function assertCustomerOutboundAllowed(
  tenantId: string,
  meta: OutboundMeta,
  contact: { id?: string | null; phone?: string | null } = {},
): Promise<void> {
  if (meta.ownerInitiated) return;

  const safe = await isSafeModeEnabled(tenantId);
  if (!safe) return;

  const reactiveOk =
    meta.sendType === 'reactive' && Boolean(meta.triggeringInboundId?.trim());

  if (reactiveOk) return;

  // Envio autorizado pelo dono (secretária: "manda um boa noite pra X", ou
  // reminder que o dono criou). A decisão de enviar já foi gated no código
  // ANTES daqui; aqui só liberamos e auditamos. proactive continua bloqueado.
  if (meta.sendType === 'owner_authorized') {
    logger.info('Envio owner_authorized liberado sob SAFE_MODE', {
      event: 'owner_authorized_send',
      contactId: contact.id ?? null,
      phone: contact.phone ?? null,
      ts: new Date().toISOString(),
    });
    return;
  }

  const sendType =
    meta.sendType === 'reactive' && !meta.triggeringInboundId ? 'proactive' : meta.sendType;

  logger.warn(SAFE_MODE_OPERATOR_MESSAGE, {
    event: 'safe_mode_blocked',
    sendType,
    contactId: contact.id ?? null,
    phone: contact.phone ?? null,
    triggeringInboundId: meta.triggeringInboundId ?? null,
    ts: new Date().toISOString(),
  });

  emitSendBlocked(tenantId, {
    message: SAFE_MODE_OPERATOR_MESSAGE,
    sendType,
    contactId: contact.id ?? null,
    phone: contact.phone ?? null,
    at: new Date().toISOString(),
  });

  throw new OutboundBlockedError();
}
