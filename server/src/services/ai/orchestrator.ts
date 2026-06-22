import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { listActiveAiProviders, updateAiRuntime } from '../../db/queries/ai_providers';
import { getTenantById } from '../../db/queries/tenants';
import { currentYm, getAiUsage, incrementAiUsage } from '../../db/queries/ai_usage';
import { anthropicAdapter } from './providers/anthropic';
import { openaiAdapter } from './providers/openai';
import { geminiAdapter } from './providers/gemini';
import {
  AiProviderError,
  type AiAdapter,
  type AiCompletionRequest,
  type AiCredentials,
  type AiFailureKind,
  type AiKind,
} from './types';

export const adapters: Record<AiKind, AiAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

/** De onde veio a corrente de provedores resolvida. */
export type ChainSource = 'tenant' | 'global' | 'env';

export interface ResolvedProvider {
  id: string;
  kind: AiKind;
  label: string;
  priority: number;
  creds: AiCredentials;
}

export interface ResolvedChain {
  providers: ResolvedProvider[];
  source: ChainSource | null;
  /** Teto mensal da empresa (NULL = ilimitado). Só relevante quando a plataforma paga. */
  limit: number | null;
}

export interface CompleteResult {
  text: string;
  providerId: string;
  providerLabel: string;
}

/** Quanto tempo um provedor fica de fora apos cada tipo de falha. */
const COOLDOWN_MS: Record<AiFailureKind, number> = {
  auth: 30 * 60_000,
  quota: 15 * 60_000,
  rate_limit: 90_000,
  transient: 45_000,
  bad_request: 5 * 60_000,
};

const cooldownUntil = new Map<string, number>();

const ENV_PROVIDER_ID = 'env:anthropic';
const GLOBAL_CACHE_KEY = '__global__';
const CHAIN_TTL_MS = 30_000;
const chainCache = new Map<string, { at: number; chain: ResolvedChain }>();

/** Limpa o cache da(s) corrente(s) e os cooldowns (chamar apos editar provedores). */
export function invalidateAiCache(): void {
  chainCache.clear();
  cooldownUntil.clear();
}

function toResolved(rows: Awaited<ReturnType<typeof listActiveAiProviders>>): ResolvedProvider[] {
  const now = Date.now();
  const out: ResolvedProvider[] = [];
  for (const r of rows) {
    if (!r.apiKey) continue;
    // BUG 3: a VERDADE do cooldown vem do banco (cooldown_until persistido), de
    // modo que o estado seja consistente entre múltiplas instâncias e sobreviva
    // a reinícios. O Map em memória continua como cache/otimização.
    if (r.cooldown_until) {
      const until = Date.parse(r.cooldown_until);
      if (!Number.isNaN(until) && until > now && until > (cooldownUntil.get(r.id) ?? 0)) {
        cooldownUntil.set(r.id, until);
      }
    }
    out.push({
      id: r.id,
      kind: r.kind,
      label: r.label,
      priority: r.priority,
      creds: { apiKey: r.apiKey as string, baseUrl: r.base_url, model: r.model },
    });
  }
  return out;
}

/**
 * Resolve a corrente de provedores para uma empresa (HIBRIDO):
 *   1. provedores ATIVOS da empresa (BYO) — se houver, usa só eles (custo da empresa);
 *   2. senão, provedores GLOBAIS da plataforma;
 *   3. senão, fallback do .env (Claude).
 * `tenantId` undefined/null pula o passo 1 (usado em checagens globais/startup).
 */
export async function resolveChain(tenantId?: string | null): Promise<ResolvedChain> {
  const key = tenantId ?? GLOBAL_CACHE_KEY;
  const now = Date.now();
  const cached = chainCache.get(key);
  if (cached && now - cached.at < CHAIN_TTL_MS) return cached.chain;

  let providers: ResolvedProvider[] = [];
  let source: ChainSource | null = null;

  try {
    if (tenantId) {
      providers = toResolved(await listActiveAiProviders(tenantId));
      if (providers.length > 0) source = 'tenant';
    }
    if (providers.length === 0) {
      providers = toResolved(await listActiveAiProviders(null));
      if (providers.length > 0) source = 'global';
    }
  } catch (err) {
    logger.warn('Falha ao carregar provedores de IA do banco; tentando fallback do .env.', err);
  }

  if (providers.length === 0 && env.hasAnthropic) {
    providers = [
      {
        id: ENV_PROVIDER_ID,
        kind: 'anthropic',
        label: 'Claude (.env)',
        priority: 0,
        creds: { apiKey: env.ANTHROPIC_API_KEY as string, model: env.CLAUDE_MODEL },
      },
    ];
    source = 'env';
  }

  // O teto só importa quando a plataforma paga (global/env) e há empresa.
  let limit: number | null = null;
  if (tenantId && source !== 'tenant') {
    try {
      const t = await getTenantById(tenantId);
      limit = t?.ai_message_limit ?? null;
    } catch {
      limit = null;
    }
  }

  const chain: ResolvedChain = { providers, source, limit };
  chainCache.set(key, { at: now, chain });
  return chain;
}

/** Ha pelo menos um provedor de IA utilizavel para esta empresa? (barato — cache.) */
export async function isAiConfigured(tenantId?: string | null): Promise<boolean> {
  return (await resolveChain(tenantId)).providers.length > 0;
}

function isInCooldown(id: string, now: number): boolean {
  const until = cooldownUntil.get(id);
  return until !== undefined && until > now;
}

function setCooldown(provider: ResolvedProvider, kind: AiFailureKind, message: string, now: number): void {
  const until = now + COOLDOWN_MS[kind];
  cooldownUntil.set(provider.id, until);
  if (!provider.id.startsWith('env:')) {
    void updateAiRuntime(provider.id, {
      status: kind,
      error: message.slice(0, 500),
      cooldownUntil: new Date(until),
    }).catch(() => {});
  }
}

function clearCooldown(provider: ResolvedProvider): void {
  cooldownUntil.delete(provider.id);
  if (!provider.id.startsWith('env:')) {
    void updateAiRuntime(provider.id, { status: 'ok', error: null, cooldownUntil: null }).catch(() => {});
  }
}

async function tryProvider(
  provider: ResolvedProvider,
  req: AiCompletionRequest,
): Promise<{ ok: true; text: string } | { ok: false; err: AiProviderError }> {
  try {
    const text = await adapters[provider.kind].complete(req, provider.creds);
    return { ok: true, text };
  } catch (err) {
    const e =
      err instanceof AiProviderError
        ? err
        : new AiProviderError('transient', err instanceof Error ? err.message : String(err));
    return { ok: false, err: e };
  }
}

export interface CompleteOptions {
  /** Conta esta resposta no teto mensal da empresa (apenas quando a plataforma paga). */
  meter?: boolean;
}

/**
 * Gera uma completion para uma empresa, tentando os provedores em ordem
 * (failover). Respeita o teto mensal quando o custo é da plataforma. Retorna
 * null se nao houver provedor, se o teto foi atingido, ou se todos falharem.
 */
export async function complete(
  req: AiCompletionRequest,
  tenantId?: string | null,
  opts: CompleteOptions = {},
): Promise<CompleteResult | null> {
  const chain = await resolveChain(tenantId);
  if (chain.providers.length === 0) return null;

  const platformPays = chain.source !== 'tenant';

  // Teto mensal: só quando a plataforma paga (global/.env) e há limite definido.
  if (platformPays && tenantId && chain.limit != null) {
    const used = await getAiUsage(tenantId, currentYm());
    if (used >= chain.limit) {
      logger.warn(
        `IA: teto mensal (${chain.limit}) atingido para a empresa ${tenantId}. ` +
          'Conecte uma chave própria no painel para continuar sem limite.',
      );
      return null;
    }
  }

  const now = Date.now();
  const skipped: ResolvedProvider[] = [];
  const triedLabels: string[] = [];
  let attempted = false;
  let result: CompleteResult | null = null;

  for (const provider of chain.providers) {
    if (isInCooldown(provider.id, now)) {
      skipped.push(provider);
      continue;
    }
    attempted = true;
    const r = await tryProvider(provider, req);
    if (r.ok && r.text) {
      clearCooldown(provider);
      if (triedLabels.length > 0) {
        logger.warn(`IA failover: respondido por "${provider.label}" após falha de: ${triedLabels.join(', ')}.`);
      }
      result = { text: r.text, providerId: provider.id, providerLabel: provider.label };
      break;
    }
    if (!r.ok) {
      setCooldown(provider, r.err.kind, r.err.message, now);
      logger.warn(`IA "${provider.label}" falhou (${r.err.kind}): ${r.err.message}. Tentando próximo...`);
    }
    triedLabels.push(provider.label);
  }

  // Todos em cooldown: tenta o de maior prioridade mesmo assim.
  if (!result && !attempted && skipped.length > 0) {
    const provider = skipped[0];
    const r = await tryProvider(provider, req);
    if (r.ok && r.text) {
      clearCooldown(provider);
      result = { text: r.text, providerId: provider.id, providerLabel: provider.label };
    } else if (!r.ok) {
      setCooldown(provider, r.err.kind, r.err.message, now);
    }
  }

  if (!result) {
    logger.warn('IA: todos os provedores falharam ou estão em cooldown.');
    return null;
  }

  if (opts.meter && platformPays && tenantId) {
    void incrementAiUsage(tenantId, currentYm()).catch(() => {});
  }
  return result;
}

/** Snapshot do estado atual da corrente (para health/painel). */
export interface ChainStatusItem {
  id: string;
  kind: AiKind;
  label: string;
  priority: number;
  inCooldown: boolean;
}

export async function getChainStatus(tenantId?: string | null): Promise<{
  source: ChainSource | null;
  items: ChainStatusItem[];
}> {
  const chain = await resolveChain(tenantId);
  const now = Date.now();
  return {
    source: chain.source,
    items: chain.providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label,
      priority: p.priority,
      inCooldown: isInCooldown(p.id, now),
    })),
  };
}
