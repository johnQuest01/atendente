import type { NextFunction, Request, Response } from 'express';
import { getTenantAccess, isTrialExpired } from '../db/queries/tenants';
import { AppError } from '../utils/errors';

/**
 * Corta o acesso da empresa quando o período de teste vence ou quando ela é
 * desativada. Nada é apagado: o cliente volta a ver tudo assim que o prazo for
 * estendido no /admin.
 *
 * O super-admin passa direto (é ele quem administra as empresas), e leitura de
 * status/sessão continua liberada para o painel conseguir explicar o bloqueio
 * em vez de simplesmente quebrar.
 */

interface CachedAccess {
  at: number;
  blocked: { code: string; message: string } | null;
}

const cache = new Map<string, CachedAccess>();
const CACHE_TTL_MS = 60_000;

/** Chamar ao mudar trial/status de uma empresa, para o bloqueio refletir na hora. */
export function invalidateTenantAccess(tenantId: string): void {
  cache.delete(tenantId);
}

async function resolveBlock(tenantId: string): Promise<CachedAccess['blocked']> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.blocked;

  const access = await getTenantAccess(tenantId);
  let blocked: CachedAccess['blocked'] = null;
  if (!access) {
    blocked = { code: 'TENANT_NOT_FOUND', message: 'Empresa não encontrada.' };
  } else if (!access.is_active) {
    blocked = { code: 'TENANT_INACTIVE', message: 'Esta conta está desativada. Fale com o suporte.' };
  } else if (isTrialExpired(access)) {
    blocked = {
      code: 'TRIAL_EXPIRED',
      message: 'Seu período de teste terminou. Fale com o suporte para continuar usando o atendente.',
    };
  }

  cache.set(tenantId, { at: Date.now(), blocked });
  return blocked;
}

export function requireActiveTenant(req: Request, _res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user || user.role === 'superadmin') {
    next();
    return;
  }

  void resolveBlock(user.tenant_id)
    .then((blocked) => {
      if (!blocked) {
        next();
        return;
      }
      // 402: "pagamento necessário" é o código que melhor descreve trial vencido,
      // e permite o front distinguir isso de um 403 comum de permissão.
      next(new AppError(blocked.message, blocked.code === 'TRIAL_EXPIRED' ? 402 : 403, blocked.code));
    })
    .catch(next);
}

/** Mesma checagem, para uso fora do ciclo de request (webhook/agendador). */
export async function isTenantBlocked(tenantId: string): Promise<boolean> {
  return (await resolveBlock(tenantId)) !== null;
}
