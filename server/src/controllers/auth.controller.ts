import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import { createUser, findUserByEmail, findUserById } from '../db/queries/users';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import type { JwtPayload } from '../types';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  role: z.enum(['admin', 'operator']).default('operator'),
});

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as z.infer<typeof loginSchema>;

  const user = await findUserByEmail(email);
  if (!user) throw new UnauthorizedError('E-mail ou senha inválidos.');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new UnauthorizedError('E-mail ou senha inválidos.');

  const token = signToken({ sub: user.id, email: user.email, role: user.role });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}

export async function register(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof registerSchema>;

  const existing = await findUserByEmail(input.email);
  if (existing) throw new ConflictError('Já existe um usuário com este e-mail.');

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await createUser({
    name: input.name,
    email: input.email,
    passwordHash,
    role: input.role,
  });

  res.status(201).json({ user });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new UnauthorizedError();
  const user = await findUserById(req.user.sub);
  if (!user) throw new UnauthorizedError();
  res.json({ user });
}
