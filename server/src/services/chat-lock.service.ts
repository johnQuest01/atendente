/**
 * Senha de cadeado de conversas no painel (só afasta olho curioso).
 * Não interfere na IA nem no WhatsApp.
 */

import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { readSetting, writeSetting } from '../db/queries/settings';
import { hashPassword, verifyPassword } from '../utils/password';
import { AppError } from '../utils/errors';

const SETTING_KEY = 'chat_lock_password_hash';
const UNLOCK_TTL = '12h';

export async function isChatLockConfigured(tenantId: string): Promise<boolean> {
  const hash = await readSetting(tenantId, SETTING_KEY);
  return Boolean(hash?.trim());
}

export async function setChatLockPassword(
  tenantId: string,
  password: string,
  currentPassword?: string | null,
): Promise<void> {
  const plain = password.trim();
  if (plain.length < 4 || plain.length > 72) {
    throw new AppError('A senha do cadeado deve ter entre 4 e 72 caracteres.', 400, 'CHAT_LOCK_PASSWORD');
  }
  const existing = await readSetting(tenantId, SETTING_KEY);
  if (existing?.trim()) {
    if (!currentPassword?.trim()) {
      throw new AppError('Informe a senha atual do cadeado.', 400, 'CHAT_LOCK_CURRENT_REQUIRED');
    }
    const ok = await verifyPassword(currentPassword, existing);
    if (!ok) {
      throw new AppError('Senha atual incorreta.', 403, 'CHAT_LOCK_BAD_PASSWORD');
    }
  }
  const hash = await hashPassword(plain);
  await writeSetting(tenantId, SETTING_KEY, hash);
}

export async function verifyChatLockPassword(tenantId: string, password: string): Promise<boolean> {
  const hash = await readSetting(tenantId, SETTING_KEY);
  if (!hash?.trim()) return false;
  return verifyPassword(password, hash);
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
