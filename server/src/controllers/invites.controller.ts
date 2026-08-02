import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  consumeInvite,
  createInvite,
  getInviteByToken,
  isInviteOpen,
  listInvites,
  revokeInvite,
} from '../db/queries/tenant_invites';
import { createTenant } from '../db/queries/tenants';
import { createUser, findUserByEmail } from '../db/queries/users';
import { hashPassword } from '../utils/password';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';
import type { JwtPayload } from '../types';

/**
 * Convites de acesso. Sem gateway de pagamento, é o caminho de entrada de uma
 * empresa nova: o dono da plataforma gera o link (rotas /api/admin/invites) e o
 * cliente o aceita sem estar logado (rotas públicas /api/invites/:token).
 */

/**
 * O link do convite aponta para o PAINEL (Vercel), não para a API. FRONTEND_URL
 * pode trazer várias origens separadas por vírgula; a primeira é a de produção.
 */
function inviteUrl(token: string): string {
  const base = (env.FRONTEND_URL.split(',')[0] ?? '').trim().replace(/\/+$/, '');
  return `${base || env.PUBLIC_BASE_URL}/convite/${token}`;
}

// ---------------------------------------------------------------------------
// Super-admin
// ---------------------------------------------------------------------------

export const createInviteSchema = z.object({
  email: z.string().email().optional(),
  companyName: z.string().trim().min(2).max(120).optional(),
  trialDays: z.coerce.number().int().min(1).max(365).default(14),
  aiMessageLimit: z.union([z.coerce.number().int().min(0).max(1_000_000), z.null()]).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
});

export async function postInvite(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof createInviteSchema>;

  if (input.email) {
    const existing = await findUserByEmail(input.email);
    if (existing) throw new ConflictError('Já existe um usuário com este e-mail.');
  }

  const invite = await createInvite({
    email: input.email ?? null,
    companyName: input.companyName ?? null,
    trialDays: input.trialDays,
    aiMessageLimit: input.aiMessageLimit ?? null,
    expiresInDays: input.expiresInDays,
    createdBy: req.user?.sub ?? null,
  });

  res.status(201).json({ invite, url: inviteUrl(invite.token) });
}

export async function getInvites(_req: Request, res: Response): Promise<void> {
  const invites = await listInvites();
  res.json({
    invites: invites.map((i) => ({ ...i, url: inviteUrl(i.token) })),
  });
}

export const inviteIdParamSchema = z.object({ id: z.string().uuid() });

export async function deleteInvite(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof inviteIdParamSchema>;
  const ok = await revokeInvite(id);
  if (!ok) throw new NotFoundError('Convite aberto');
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Público (sem autenticação)
// ---------------------------------------------------------------------------

export const inviteTokenParamSchema = z.object({ token: z.string().min(10).max(200) });

/**
 * Prévia do convite, para a tela pública mostrar o que o cliente vai receber.
 * Não revela nada além do necessário: nome sugerido, e-mail travado e prazos.
 */
export async function getInvitePreview(req: Request, res: Response): Promise<void> {
  const { token } = req.params as z.infer<typeof inviteTokenParamSchema>;
  const invite = await getInviteByToken(token);
  if (!invite) throw new NotFoundError('Convite');

  if (!isInviteOpen(invite)) {
    res.json({
      valid: false,
      reason: invite.used_at ? 'used' : 'expired',
    });
    return;
  }

  res.json({
    valid: true,
    companyName: invite.company_name,
    email: invite.email,
    trialDays: invite.trial_days,
    expiresAt: invite.expires_at,
  });
}

export const acceptInviteSchema = z.object({
  companyName: z.string().trim().min(2, 'Nome muito curto.').max(120),
  adminName: z.string().trim().min(2).max(100),
  adminEmail: z.string().email(),
  adminPassword: z
    .string()
    .min(8, 'A senha deve ter ao menos 8 caracteres.')
    .max(100)
    .regex(/[A-Za-z]/, 'A senha deve conter ao menos uma letra.')
    .regex(/[0-9]/, 'A senha deve conter ao menos um número.'),
});

/**
 * Aceite do convite: cria a empresa com o prazo de teste e o admin dela, e já
 * devolve o JWT — o cliente cai direto no painel, sem passar pelo login.
 */
export async function acceptInvite(req: Request, res: Response): Promise<void> {
  const { token } = req.params as z.infer<typeof inviteTokenParamSchema>;
  const input = req.body as z.infer<typeof acceptInviteSchema>;

  const invite = await getInviteByToken(token);
  if (!invite) throw new NotFoundError('Convite');
  if (!isInviteOpen(invite)) {
    throw new AppError(
      invite.used_at ? 'Este convite já foi utilizado.' : 'Este convite expirou.',
      410,
      'INVITE_CLOSED',
    );
  }

  // Convite endereçado: só o e-mail convidado pode aceitar.
  if (invite.email && invite.email.toLowerCase() !== input.adminEmail.toLowerCase()) {
    throw new AppError('Este convite é válido apenas para o e-mail que o recebeu.', 403, 'INVITE_EMAIL_MISMATCH');
  }

  const existing = await findUserByEmail(input.adminEmail);
  if (existing) throw new ConflictError('Já existe um usuário com este e-mail.');

  const tenant = await createTenant(input.companyName, {
    trialDays: invite.trial_days,
    aiMessageLimit: invite.ai_message_limit,
  });

  // Fecha o convite ANTES de criar o usuário: o UPDATE condicional só acerta uma
  // linha, então dois aceites simultâneos não geram duas empresas com acesso.
  const consumed = await consumeInvite(invite.id, tenant.id);
  if (!consumed) {
    throw new AppError('Este convite acabou de ser utilizado.', 409, 'INVITE_CLOSED');
  }

  const passwordHash = await hashPassword(input.adminPassword);
  const admin = await createUser({
    name: input.adminName,
    email: input.adminEmail,
    passwordHash,
    role: 'admin',
    tenantId: tenant.id,
  });

  const payload: JwtPayload = {
    sub: admin.id,
    email: admin.email,
    role: 'admin',
    tenant_id: tenant.id,
  };
  const jwtToken = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions);

  logger.info(`Convite aceito: empresa "${tenant.name}" criada com ${invite.trial_days} dias de teste.`);

  res.status(201).json({
    token: jwtToken,
    user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    tenant: { id: tenant.id, name: tenant.name, trialEndsAt: tenant.trial_ends_at },
  });
}
