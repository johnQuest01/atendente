import type { Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import {
  addBlockedNumber,
  deleteBlockedNumber,
  listBlockedNumbers,
  normalizePhone,
  setBlockedActive,
} from '../db/queries/blocked';
import { AppError, NotFoundError, UnauthorizedError } from '../utils/errors';

export const idParamSchema = z.object({ id: z.string().uuid() });

export const unlockSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Valida o login/senha especial e emite um token (12h) com escopo 'blocklist'
 * que libera o acesso à área de números bloqueados.
 */
export async function unlockBlocked(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as z.infer<typeof unlockSchema>;
  const emailOk = email.trim().toLowerCase() === env.BLOCK_ADMIN_EMAIL.toLowerCase();
  const passOk = emailOk && (await bcrypt.compare(password, env.BLOCK_ADMIN_PASSWORD_HASH));
  if (!emailOk || !passOk) {
    throw new UnauthorizedError('Login ou senha do cadeado incorretos.');
  }
  const token = jwt.sign({ scope: 'blocklist' }, env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
}

export const createBlockedSchema = z.object({
  phone: z.string().min(8).max(30),
  label: z.string().max(120).optional().nullable(),
});

export const updateBlockedSchema = z.object({
  is_active: z.boolean(),
});

export async function getBlocked(_req: Request, res: Response): Promise<void> {
  const blocked = await listBlockedNumbers();
  res.json({ blocked });
}

export async function postBlocked(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createBlockedSchema>;
  const normalized = normalizePhone(body.phone);
  if (normalized.length < 8) {
    throw new AppError('Número inválido. Informe ao menos 8 dígitos (com DDD).', 400, 'INVALID_PHONE');
  }
  const blocked = await addBlockedNumber(normalized, body.label ?? null);
  res.status(201).json({ blocked });
}

export async function patchBlocked(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { is_active } = req.body as z.infer<typeof updateBlockedSchema>;
  const blocked = await setBlockedActive(id, is_active);
  if (!blocked) throw new NotFoundError('Número bloqueado');
  res.json({ blocked });
}

export async function removeBlocked(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteBlockedNumber(id);
  if (!ok) throw new NotFoundError('Número bloqueado');
  res.status(204).send();
}
