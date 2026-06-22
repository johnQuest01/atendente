import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import {
  createAiProvider,
  deleteAiProvider,
  getAiProviderById,
  listAiProviders,
  updateAiProvider,
  type AiProvider,
} from '../db/queries/ai_providers';
import { adapters, invalidateAiCache, getChainStatus } from '../services/ai/orchestrator';
import type { AiKind } from '../services/ai/types';
import { AppError, NotFoundError } from '../utils/errors';

/**
 * Gestao dos provedores de IA da plataforma (super-admin). Permite TROCAR de
 * agente e montar a CADEIA de failover. As chaves nunca voltam em texto puro
 * (sao mascaradas) e qualquer escrita invalida o cache do orquestrador.
 */

const kindEnum = z.enum(['anthropic', 'openai', 'gemini']);
const optionalUrl = z.union([z.string().trim().url('URL inválida.'), z.literal('')]).optional();

function maskKey(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 6 ? '••••' : `••••${key.slice(-4)}`;
}

function toDto(p: AiProvider, cooldownActive: boolean) {
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    model: p.model,
    base_url: p.base_url,
    priority: p.priority,
    is_active: p.is_active,
    has_key: Boolean(p.apiKey),
    key_masked: maskKey(p.apiKey),
    last_status: p.last_status,
    last_error: p.last_error,
    last_used_at: p.last_used_at,
    cooldown_until: p.cooldown_until,
    in_cooldown: cooldownActive,
  };
}

function ensureEncryption(): void {
  if (!env.hasEncryption) {
    throw new AppError(
      'Defina ENCRYPTION_KEY para cadastrar chaves de IA com segurança.',
      400,
      'NO_ENCRYPTION_KEY',
    );
  }
}

export async function getAiProviders(_req: Request, res: Response): Promise<void> {
  const [providers, status] = await Promise.all([listAiProviders(), getChainStatus()]);
  const coldIds = new Set(status.filter((s) => s.inCooldown).map((s) => s.id));
  res.json({ providers: providers.map((p) => toDto(p, coldIds.has(p.id))) });
}

export const createAiProviderSchema = z.object({
  kind: kindEnum,
  label: z.string().trim().min(2, 'Nome muito curto.').max(80),
  apiKey: z.string().trim().min(1, 'Informe a chave de API.'),
  baseUrl: optionalUrl,
  model: z.string().trim().min(1, 'Informe o modelo.').max(120),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});

export async function postAiProvider(req: Request, res: Response): Promise<void> {
  ensureEncryption();
  const input = req.body as z.infer<typeof createAiProviderSchema>;
  const provider = await createAiProvider({
    kind: input.kind as AiKind,
    label: input.label,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl ? input.baseUrl : null,
    model: input.model,
    priority: input.priority,
    isActive: input.isActive,
  });
  invalidateAiCache();
  res.status(201).json({ provider: toDto(provider, false) });
}

export const aiProviderIdParamSchema = z.object({ id: z.string().uuid() });

export const updateAiProviderSchema = z
  .object({
    label: z.string().trim().min(2).max(80).optional(),
    // Vazio/ausente = mantém a chave atual.
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: optionalUrl,
    model: z.string().trim().min(1).max(120).optional(),
    priority: z.coerce.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'Informe ao menos um campo para atualizar.',
  });

export async function patchAiProvider(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
  const body = req.body as z.infer<typeof updateAiProviderSchema>;
  if (body.apiKey) ensureEncryption();

  const existing = await getAiProviderById(id);
  if (!existing) throw new NotFoundError('Provedor de IA');

  const provider = await updateAiProvider(id, {
    label: body.label,
    apiKey: body.apiKey,
    baseUrl: body.baseUrl === undefined ? undefined : body.baseUrl || null,
    model: body.model,
    priority: body.priority,
    isActive: body.isActive,
  });
  invalidateAiCache();
  res.json({ provider: provider ? toDto(provider, false) : null });
}

export async function removeAiProvider(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
  const ok = await deleteAiProvider(id);
  if (!ok) throw new NotFoundError('Provedor de IA');
  invalidateAiCache();
  res.status(204).send();
}

/** Testa um provedor JA salvo (usa a chave guardada). */
export async function testAiProvider(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
  const provider = await getAiProviderById(id);
  if (!provider) throw new NotFoundError('Provedor de IA');
  if (!provider.apiKey) {
    res.json({ ok: false, detail: 'Sem chave configurada para este provedor.' });
    return;
  }
  const result = await adapters[provider.kind].validateKey({
    apiKey: provider.apiKey,
    baseUrl: provider.base_url,
    model: provider.model,
  });
  res.json(result);
}

export const testAiCredsSchema = z.object({
  kind: kindEnum,
  apiKey: z.string().trim().min(1, 'Informe a chave de API.'),
  baseUrl: optionalUrl,
  model: z.string().trim().min(1, 'Informe o modelo.').max(120),
});

/** Testa credenciais AVULSAS (antes de salvar, no modal de cadastro). */
export async function testAiCreds(req: Request, res: Response): Promise<void> {
  const input = req.body as z.infer<typeof testAiCredsSchema>;
  const result = await adapters[input.kind as AiKind].validateKey({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl ? input.baseUrl : null,
    model: input.model,
  });
  res.json(result);
}
