/**
 * Cadeado de conversas no painel — mesma senha do cadeado flutuante.
 * Não interfere na IA nem no WhatsApp.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { verifyPanelLockPassword } from '../config/panel-lock';

const UNLOCK_TTL = '12h';

/** Sempre configurado: a senha é a do cadeado do painel. */
export async function isChatLockConfigured(_tenantId: string): Promise<boolean> {
  return true;
}

export async function verifyChatLockPassword(
  _tenantId: string,
  password: string,
): Promise<boolean> {
  return verifyPanelLockPassword(password);
}

export function signChatUnlockToken(tenantId: string, conversationId: string): string {
  return jwt.sign(
    { scope: 'chat_unlock', tenantId, conversationId },
    env.JWT_SECRET,
    { expiresIn: UNLOCK_TTL },
  );
}

export function verifyChatUnlockToken(
  token: string | undefined,
  tenantId: string,
  conversationId: string,
): boolean {
  if (!token?.trim()) return false;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      scope?: string;
      tenantId?: string;
      conversationId?: string;
    };
    return (
      decoded.scope === 'chat_unlock' &&
      decoded.tenantId === tenantId &&
      decoded.conversationId === conversationId
    );
  } catch {
    return false;
  }
}
