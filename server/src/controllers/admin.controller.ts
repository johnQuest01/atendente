import type { Request, Response } from 'express';
import { z } from 'zod';
import { DEFAULT_TENANT_ID } from '../config/tenant';
import {
  createTenant,
  deleteTenant,
  getTenantById,
  listTenants,
  updateTenant,
} from '../db/queries/tenants';
import { createUser, findUserByEmail } from '../db/queries/users';
import { hashPassword } from '../utils/password';
import { invalidateTenantAccess } from '../middleware/tenantAccess.middleware';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';

/**
 * Controllers do SUPER-ADMIN (dono da plataforma): gestao de empresas (tenants)
 * e do administrador inicial de cada empresa. Protegido por requireSuperAdmin.
 */

function canDeleteTenant(tenantId: string, actorTenantId: string | undefined): boolean {
  if (tenantId === DEFAULT_TENANT_ID) return false;
  if (actorTenantId && tenantId === actorTenantId) return false;
  return true;
}

export async function getTenants(req: Request, res: Response): Promise<void> {
  const tenants = await listTenants();
  const mine = req.user!.tenant_id;
  res.json({
    tenants: tenants.map((t) => ({
      ...t,
      can_delete: canDeleteTenant(t.id, mine),
    })),
  });
}

export const createTenantSchema = z.object({
  name: z.string().min(2, 'Nome muito curto.').max(120),
  adminName: z.string().min(2).max(100),
  adminEmail: z.string().email(),
  // Mesma politica de senha do cadastro de usuarios.
  adminPassword: z
    .string()
    .min(8, 'A senha deve ter ao menos 8 caracteres.')
    .max(100)
    .regex(/[A-Za-z]/, 'A senha deve conter ao menos uma letra.')
    .regex(/[0-9]/, 'A senha deve conter ao menos um número.'),
});

/** Cria uma empresa + o admin inicial dela. */
export async function postTenant(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createTenantSchema>;

  const existing = await findUserByEmail(input.adminEmail);
  if (existing) throw new ConflictError('Já existe um usuário com este e-mail.');

  const tenant = await createTenant(input.name);
  const passwordHash = await hashPassword(input.adminPassword);
  const admin = await createUser({
    name: input.adminName,
    email: input.adminEmail,
    passwordHash,
    role: 'admin',
    tenantId: tenant.id,
  });

  res.status(201).json({ tenant, admin });
}

export const tenantIdParamSchema = z.object({ id: z.string().uuid() });

export const updateTenantSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    is_active: z.boolean().optional(),
    // Teto mensal de mensagens de IA (plano base). null = ilimitado.
    ai_message_limit: z
      .union([z.coerce.number().int().min(0).max(1_000_000), z.null()])
      .optional(),
    // Fim do período de teste. null = sem prazo (acesso liberado).
    trial_ends_at: z.union([z.string().datetime(), z.null()]).optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.is_active !== undefined ||
      d.ai_message_limit !== undefined ||
      d.trial_ends_at !== undefined,
    { message: 'Informe ao menos um campo para atualizar.' },
  );

/** Renomeia / ativa / desativa uma empresa. */
export async function patchTenant(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof tenantIdParamSchema>;
  const patch = req.body as z.infer<typeof updateTenantSchema>;

  const existing = await getTenantById(id);
  if (!existing) throw new NotFoundError('Empresa');

  const tenant = await updateTenant(id, patch);
  // Reativar empresa ou estender o teste tem que valer na hora, não em 60s.
  invalidateTenantAccess(id);
  res.json({ tenant });
}

/**
 * Remove empresa e dados (usuários, WhatsApp, conversas…).
 * Bloqueia a empresa padrão da plataforma e a empresa do próprio superadmin.
 */
export async function removeTenant(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof tenantIdParamSchema>;
  const existing = await getTenantById(id);
  if (!existing) throw new NotFoundError('Empresa');

  if (!canDeleteTenant(id, req.user!.tenant_id)) {
    throw new AppError(
      id === DEFAULT_TENANT_ID
        ? 'A empresa padrão da plataforma não pode ser removida.'
        : 'Você não pode remover a sua própria empresa.',
      403,
      'TENANT_DELETE_FORBIDDEN',
    );
  }

  const ok = await deleteTenant(id);
  if (!ok) throw new NotFoundError('Empresa');
  invalidateTenantAccess(id);
  res.json({ ok: true, id, name: existing.name });
}
