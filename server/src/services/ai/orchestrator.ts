import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { countAiProviders, listActiveAiProviders, updateAiRuntime } from '../../db/queries/ai_providers';
import { getTenantById } from '../../db/queries/tenants';
import { currentYm, getAiUsage, incrementAiUsage } from '../../db/queries/ai_usage';
import { anthropicAdapter } from './providers/anthropic';
import { openaiAdapter } from './providers/openai';
import { geminiAdapter } from './providers/gemini';
import { modelSupportsVision } from './vision';
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
  /** Modelo REAL que respondeu (ex.: "claude-opus-4-8") — confere a troca de modelo. */
  model: string;
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
 * `connectionId` filtra IAs ligadas àquela instância WhatsApp (+ as de “todas”).
 * `tenantId` undefined/null pula o passo 1 (usado em checagens globais/startup).
 */
export async function resolveChain(
  tenantId?: string | null,
  connectionId?: string | null,
): Promise<ResolvedChain> {
  const key = `${tenantId ?? GLOBAL_CACHE_KEY}|${connectionId ?? ''}`;
  const now = Date.now();
  const cached = chainCache.get(key);
  if (cached && now - cached.at < CHAIN_TTL_MS) return cached.chain;

  let providers: ResolvedProvider[] = [];
  let source: ChainSource | null = null;

  try {
    if (tenantId) {
      providers = toResolved(await listActiveAiProviders(tenantId, connectionId));
      if (providers.length > 0) source = 'tenant';
    }
    if (providers.length === 0) {
      providers = toResolved(await listActiveAiProviders(null));
      if (providers.length > 0) source = 'global';
    }
  } catch (err) {
    logger.warn('Falha ao carregar provedores de IA do banco; tentando fallback do .env.', err);
  }

  // Fallback do .env: SÓ numa instalação nova (nenhum provedor cadastrado). Se o
  // dono já cadastrou provedores e desativou todos, respeitamos a escolha (sem
  // IA) em vez de "ressuscitar" o Claude do .env por baixo dos panos.
  if (providers.length === 0 && env.hasAnthropic) {
    let configured = 0;
    try {
      configured =
        (tenantId ? await countAiProviders(tenantId) : 0) + (await countAiProviders(null));
    } catch {
      configured = 0;
    }
    if (configured === 0) {
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
export async function isAiConfigured(
  tenantId?: string | null,
  connectionId?: string | null,
): Promise<boolean> {
  return (await resolveChain(tenantId, connectionId)).providers.length > 0;
}

/**
 * Ha algum provedor ATIVO na corrente desta empresa cujo modelo "enxergue"
 * imagens? Usado para decidir se vale a pena mandar a foto/vídeo do cliente
 * para a IA ou se respondemos pedindo uma descrição em texto. (barato — cache.)
 */
export async function hasVisionProvider(
  tenantId?: string | null,
  connectionId?: string | null,
): Promise<boolean> {
  const chain = await resolveChain(tenantId, connectionId);
  return chain.providers.some((p) => modelSupportsVision(p.kind, p.creds.model, p.creds.baseUrl));
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
): Promise<
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; err: AiProviderError }
> {
  try {
    const result = await adapters[provider.kind].complete(req, provider.creds);
    return { ok: true, text: result.text, truncated: Boolean(result.truncated) };
  } catch (err) {
    const e =
      err instanceof AiProviderError
        ? err
        : new AiProviderError('transient', err instanceof Error ? err.message : String(err));
    return { ok: false, err: e };
  }
}

const ABSOLUTE_MAX_TOKENS = 1200;

/** Uma retentativa com o dobro do limite se truncou; nunca devolve texto cortado. */
async function completeAvoidingTruncation(
  provider: ResolvedProvider,
  req: AiCompletionRequest,
): Promise<{ ok: true; text: string } | { ok: false; err: AiProviderError } | { ok: false; truncated: true }> {
  let current = { ...req };
  const first = await tryProvider(provider, current);
  if (!first.ok) return first;
  if (!first.truncated) return { ok: true, text: first.text };

  const doubled = Math.min(Math.max(current.maxTokens * 2, current.maxTokens + 1), ABSOLUTE_MAX_TOKENS);
  if (doubled <= current.maxTokens) {
    logger.warn(`IA "${provider.label}": resposta truncada e já no teto ${ABSOLUTE_MAX_TOKENS} — descartada.`);
    return { ok: false, truncated: true };
  }
  logger.warn(
    `IA "${provider.label}": resposta truncada (maxTokens=${current.maxTokens}). Retentando com ${doubled}.`,
  );
  current = { ...current, maxTokens: doubled };
  const second = await tryProvider(provider, current);
  if (!second.ok) return second;
  if (second.truncated) {
    logger.warn(`IA "${provider.label}": ainda truncada após retentativa — não enviando ao cliente.`);
    return { ok: false, truncated: true };
  }
  return { ok: true, text: second.text };
}

export interface CompleteOptions {
  /** Conta esta resposta no teto mensal da empresa (apenas quando a plataforma paga). */
  meter?: boolean;
  /** Instância WhatsApp que está atendendo — escolhe IAs ligadas a ela. */
  connectionId?: string | null;
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
  const chain = await resolveChain(tenantId, opts.connectionId);
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
    const r = await completeAvoidingTruncation(provider, req);
    if (r.ok && r.text) {
      clearCooldown(provider);
      if (triedLabels.length > 0) {
        logger.warn(`IA failover: respondido por "${provider.label}" após falha de: ${triedLabels.join(', ')}.`);
      }
      result = { text: r.text, providerId: provider.id, providerLabel: provider.label, model: provider.creds.model };
      break;
    }
    if (!r.ok && 'err' in r) {
      setCooldown(provider, r.err.kind, r.err.message, now);
      logger.warn(`IA "${provider.label}" falhou (${r.err.kind}): ${r.err.message}. Tentando próximo...`);
    }
    triedLabels.push(provider.label);
  }

  // Todos em cooldown: tenta o de maior prioridade mesmo assim.
  if (!result && !attempted && skipped.length > 0) {
    const provider = skipped[0];
    const r = await completeAvoidingTruncation(provider, req);
    if (r.ok && r.text) {
      clearCooldown(provider);
      result = { text: r.text, providerId: provider.id, providerLabel: provider.label, model: provider.creds.model };
    } else if (!r.ok && 'err' in r) {
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

export async function getChainStatus(
  tenantId?: string | null,
  connectionId?: string | null,
): Promise<{
  source: ChainSource | null;
  items: ChainStatusItem[];
}> {
  const chain = await resolveChain(tenantId, connectionId);
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
