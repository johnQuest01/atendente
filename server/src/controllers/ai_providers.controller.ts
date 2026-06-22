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
import { getTenantById } from '../db/queries/tenants';
import { currentYm, getAiUsage } from '../db/queries/ai_usage';
import { adapters, invalidateAiCache, getChainStatus } from '../services/ai/orchestrator';
import type { AiKind } from '../services/ai/types';
import { AppError, NotFoundError } from '../utils/errors';

/**
 * Gestao dos provedores de IA. Funciona em DOIS escopos com o MESMO codigo:
 *   - GLOBAL (super-admin): tenantId = null  -> padrao da plataforma.
 *   - EMPRESA (admin do tenant): tenantId = req.user.tenant_id -> BYO.
 * As chaves nunca voltam em texto puro (mascaradas) e qualquer escrita invalida
 * o cache do orquestrador.
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

export const createAiProviderSchema = z.object({
  kind: kindEnum,
  label: z.string().trim().min(2, 'Nome muito curto.').max(80),
  apiKey: z.string().trim().min(1, 'Informe a chave de API.'),
  baseUrl: optionalUrl,
  model: z.string().trim().min(1, 'Informe o modelo.').max(120),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});

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

export const testAiCredsSchema = z.object({
  kind: kindEnum,
  apiKey: z.string().trim().min(1, 'Informe a chave de API.'),
  baseUrl: optionalUrl,
  model: z.string().trim().min(1, 'Informe o modelo.').max(120),
});

/** Resolve o escopo (empresa ou global) a partir da requisição. */
type ScopeResolver = (req: Request) => string | null;

export interface AiProviderControllers {
  getAiProviders: (req: Request, res: Response) => Promise<void>;
  postAiProvider: (req: Request, res: Response) => Promise<void>;
  patchAiProvider: (req: Request, res: Response) => Promise<void>;
  removeAiProvider: (req: Request, res: Response) => Promise<void>;
  testAiProvider: (req: Request, res: Response) => Promise<void>;
  testAiCreds: (req: Request, res: Response) => Promise<void>;
  getAiUsageInfo: (req: Request, res: Response) => Promise<void>;
}

/** Cria o conjunto de handlers para um escopo (global ou por empresa). */
export function makeAiProviderControllers(scopeOf: ScopeResolver): AiProviderControllers {
  return {
    async getAiProviders(req, res) {
      const tenantId = scopeOf(req);
      const [providers, status] = await Promise.all([
        listAiProviders(tenantId),
        getChainStatus(tenantId),
      ]);
      const coldIds = new Set(status.items.filter((s) => s.inCooldown).map((s) => s.id));
      res.json({
        providers: providers.map((p) => toDto(p, coldIds.has(p.id))),
        source: status.source,
      });
    },

    async postAiProvider(req, res) {
      ensureEncryption();
      const tenantId = scopeOf(req);
      const input = req.body as z.infer<typeof createAiProviderSchema>;
      const provider = await createAiProvider({
        tenantId,
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
    },

    async patchAiProvider(req, res) {
      const tenantId = scopeOf(req);
      const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
      const body = req.body as z.infer<typeof updateAiProviderSchema>;
      if (body.apiKey) ensureEncryption();

      const existing = await getAiProviderById(id, tenantId);
      if (!existing) throw new NotFoundError('Provedor de IA');

      const provider = await updateAiProvider(id, tenantId, {
        label: body.label,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl === undefined ? undefined : body.baseUrl || null,
        model: body.model,
        priority: body.priority,
        isActive: body.isActive,
      });
      invalidateAiCache();
      res.json({ provider: provider ? toDto(provider, false) : null });
    },

    async removeAiProvider(req, res) {
      const tenantId = scopeOf(req);
      const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
      const ok = await deleteAiProvider(id, tenantId);
      if (!ok) throw new NotFoundError('Provedor de IA');
      invalidateAiCache();
      res.status(204).send();
    },

    async testAiProvider(req, res) {
      const tenantId = scopeOf(req);
      const { id } = req.params as z.infer<typeof aiProviderIdParamSchema>;
      const provider = await getAiProviderById(id, tenantId);
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
    },

    /** Testa credenciais AVULSAS (antes de salvar, no modal de cadastro). */
    async testAiCreds(req, res) {
      const input = req.body as z.infer<typeof testAiCredsSchema>;
      const result = await adapters[input.kind as AiKind].validateKey({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl ? input.baseUrl : null,
        model: input.model,
      });
      res.json(result);
    },

    /** Uso de IA do mês + teto + de onde vem a corrente (própria ou plataforma). */
    async getAiUsageInfo(req, res) {
      const tenantId = scopeOf(req);
      if (!tenantId) {
        res.json({ used: 0, limit: null, source: null, ym: currentYm() });
        return;
      }
      const [tenant, status, used] = await Promise.all([
        getTenantById(tenantId),
        getChainStatus(tenantId),
        getAiUsage(tenantId, currentYm()),
      ]);
      res.json({
        used,
        limit: tenant?.ai_message_limit ?? null,
        source: status.source,
        ym: currentYm(),
      });
    },
  };
}

/** Handlers do escopo GLOBAL (super-admin). */
export const adminAiProviders = makeAiProviderControllers(() => null);

/** Handlers do escopo da EMPRESA (admin do tenant logado). */
export const tenantAiProviders = makeAiProviderControllers((req) => req.user?.tenant_id ?? null);
