import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { createTenant, getTenantById, listTenants, updateTenant } from '../db/queries/tenants';
import { createUser, findUserByEmail } from '../db/queries/users';
import { ConflictError, NotFoundError } from '../utils/errors';

/**
 * Controllers do SUPER-ADMIN (dono da plataforma): gestao de empresas (tenants)
 * e do administrador inicial de cada empresa. Protegido por requireSuperAdmin.
 */

export async function getTenants(_req: Request, res: Response): Promise<void> {
  const tenants = await listTenants();
  res.json({ tenants });
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
  const passwordHash = await bcrypt.hash(input.adminPassword, 10);
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
  })
  .refine((d) => d.name !== undefined || d.is_active !== undefined, {
    message: 'Informe ao menos um campo para atualizar.',
  });

/** Renomeia / ativa / desativa uma empresa. */
export async function patchTenant(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof tenantIdParamSchema>;
  const patch = req.body as z.infer<typeof updateTenantSchema>;

  const existing = await getTenantById(id);
  if (!existing) throw new NotFoundError('Empresa');

  const tenant = await updateTenant(id, patch);
  res.json({ tenant });
}
