/**
 * Senha do cadeado do painel (área restrita + conversas trancadas).
 * Só afasta olho curioso — IA e WhatsApp não usam isso.
 */
import { timingSafeEqual } from 'crypto';

export const PANEL_LOCK_PASSWORD = 'BUCeta199@_';

export function verifyPanelLockPassword(password: string): boolean {
  const expected = Buffer.from(PANEL_LOCK_PASSWORD, 'utf8');
  const got = Buffer.from(String(password ?? ''), 'utf8');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
