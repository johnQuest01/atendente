import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { JwtPayload, UserRole } from '../types';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

/** Exige um JWT válido. Popula req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next(new UnauthorizedError('Token não fornecido.'));
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.user = decoded;
    next();
  } catch {
    next(new UnauthorizedError('Token inválido ou expirado.'));
  }
}

/**
 * Exige um token de acesso à área restrita de "Números bloqueados".
 * O token é emitido pelo endpoint /blocked/unlock após validar o login/senha
 * especial. Vem no header `x-block-token`.
 */
export function requireBlockAccess(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.headers['x-block-token'] as string | undefined) ?? null;
  if (!token) {
    next(new ForbiddenError('Área restrita. Desbloqueie com seu login do cadeado.'));
    return;
  }
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { scope?: string };
    if (decoded.scope !== 'blocklist') throw new Error('scope inválido');
    next();
  } catch {
    next(new ForbiddenError('Sessão do cadeado expirada. Desbloqueie novamente.'));
  }
}

/** Exige que o usuário autenticado tenha um dos papéis informados. */
export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      next(new ForbiddenError('Você não tem permissão para esta ação.'));
      return;
    }
    next();
  };
}
