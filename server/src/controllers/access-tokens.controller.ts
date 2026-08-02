import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../config/logger';
import {
  generateAccessToken,
  getTenantAccessToken,
  listTenantTokens,
  revokeAccessToken,
} from '../db/queries/access_tokens';
import { getTenantById } from '../db/queries/tenants';
import { hasEncryptionKey } from '../utils/crypto';
import { AppError, NotFoundError } from '../utils/errors';

/**
 * Token de acesso por empresa. Geração/revogação são exclusivas do superadmin
 * (rotas /api/admin, já protegidas por requireSuperAdmin). A leitura do próprio
 * token (card no Settings) é escopada por tenant via runWithTenant.
 */

// ---------------------------------------------------------------------------
// Superadmin — /api/admin/tenants/:tenantId/access-token(s), /api/admin/access-tokens/:id
// ---------------------------------------------------------------------------

export const tenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

export const generateTokenSchema = z.object({
  label: z.string().trim().max(100).optional(),
  expiresInDays: z.union([z.coerce.number().int().min(1).max(3650), z.null()]).optional(),
});

export async function postAccessToken(req: Request, res: Response): Promise<void> {
  if (!hasEncryptionKey()) {
    throw new AppError(
      'ENCRYPTION_KEY não configurada — necessária para guardar o token com segurança.',
      503,
      'NO_ENCRYPTION_KEY',
    );
  }
  const { tenantId } = req.params as z.infer<typeof tenantIdParamSchema>;
  const input = req.body as z.infer<typeof generateTokenSchema>;

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new NotFoundError('Empresa');

  const expiresAt =
    input.expiresInDays != null
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60_000)
      : null;

  const created = await generateAccessToken(tenantId, {
    label: input.label ?? null,
    expiresAt,
    createdBy: req.user?.sub ?? null,
  });

  logger.info(`Token de acesso gerado para a empresa ${tenantId} (${created.token_prefix}…).`);
  // O valor em claro vai UMA vez; a UI avisa "copie agora".
  res.status(201).json({ token: created });
}

export async function getAccessTokens(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params as z.infer<typeof tenantIdParamSchema>;
  const tokens = await listTenantTokens(tenantId);
  // Valor ativo decifrado (o superadmin pode revelar o token da empresa).
  const active = await getTenantAccessToken(tenantId);
  res.json({ tokens, active });
}

export const accessTokenIdParamSchema = z.object({ id: z.string().uuid() });

export async function deleteAccessToken(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof accessTokenIdParamSchema>;
  const ok = await revokeAccessToken(id);
  if (!ok) throw new NotFoundError('Token ativo');
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Usuário — GET /api/settings/access-token (só-leitura do PRÓPRIO tenant)
// ---------------------------------------------------------------------------

/**
 * Token de acesso da empresa do usuário logado. Escopado por RLS/runWithTenant:
 * a query só enxerga o tenant do requisitante, nunca o de outra empresa.
 */
export async function getMyAccessToken(req: Request, res: Response): Promise<void> {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) {
    res.json({ token: null });
    return;
  }
  const active = await getTenantAccessToken(tenantId);
  res.json({ token: active });
}
