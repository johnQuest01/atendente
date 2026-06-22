import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { listActiveAiProviders, updateAiRuntime } from '../../db/queries/ai_providers';
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

export interface ResolvedProvider {
  id: string;
  kind: AiKind;
  label: string;
  priority: number;
  creds: AiCredentials;
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

// Cooldown em memoria (fonte de verdade no caminho quente). Tambem persistimos
// no banco (best-effort) para o painel e para sobreviver a reinicios.
const cooldownUntil = new Map<string, number>();

const ENV_PROVIDER_ID = 'env:anthropic';
const CHAIN_TTL_MS = 30_000;
let chainCache: { at: number; chain: ResolvedProvider[] } | null = null;

/**
 * Limpa o cache da corrente (chamar apos editar provedores no painel). Tambem
 * zera os cooldowns em memoria: se o admin acabou de corrigir uma chave ou
 * reativar um provedor, ele deve voltar a ser tentado imediatamente.
 */
export function invalidateAiCache(): void {
  chainCache = null;
  cooldownUntil.clear();
}

/**
 * Resolve a corrente de provedores ATIVOS, em ordem de prioridade. Usa o banco
 * (config global) e, se estiver vazio, cai para o Claude do .env (continuidade).
 */
export async function resolveChain(force = false): Promise<ResolvedProvider[]> {
  const now = Date.now();
  if (!force && chainCache && now - chainCache.at < CHAIN_TTL_MS) return chainCache.chain;

  let chain: ResolvedProvider[] = [];
  try {
    const rows = await listActiveAiProviders();
    chain = rows
      .filter((r) => r.apiKey)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        priority: r.priority,
        creds: { apiKey: r.apiKey as string, baseUrl: r.base_url, model: r.model },
      }));
  } catch (err) {
    logger.warn('Falha ao carregar provedores de IA do banco; usando fallback do .env.', err);
  }

  if (chain.length === 0 && env.hasAnthropic) {
    chain = [
      {
        id: ENV_PROVIDER_ID,
        kind: 'anthropic',
        label: 'Claude (.env)',
        priority: 0,
        creds: { apiKey: env.ANTHROPIC_API_KEY as string, model: env.CLAUDE_MODEL },
      },
    ];
  }

  chainCache = { at: now, chain };
  return chain;
}

/** Ha pelo menos um provedor de IA utilizavel? (barato — usa cache.) */
export async function isAiConfigured(): Promise<boolean> {
  return (await resolveChain()).length > 0;
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
      err instanceof AiProviderError ? err : new AiProviderError('transient', err instanceof Error ? err.message : String(err));
    return { ok: false, err: e };
  }
}

/**
 * Gera uma completion tentando os provedores em ordem. Em falha classificada,
 * coloca o provedor em cooldown e passa para o proximo (failover). Retorna null
 * apenas se NENHUM provedor estiver configurado ou todos falharem.
 */
export async function complete(req: AiCompletionRequest): Promise<CompleteResult | null> {
  const chain = await resolveChain();
  if (chain.length === 0) return null;

  const now = Date.now();
  const skipped: ResolvedProvider[] = [];
  const triedLabels: string[] = [];
  let attempted = false;

  for (const provider of chain) {
    if (isInCooldown(provider.id, now)) {
      skipped.push(provider);
      continue;
    }
    attempted = true;
    const result = await tryProvider(provider, req);
    if (result.ok && result.text) {
      clearCooldown(provider);
      if (triedLabels.length > 0) {
        logger.warn(`IA failover: respondido por "${provider.label}" após falha de: ${triedLabels.join(', ')}.`);
      }
      return { text: result.text, providerId: provider.id, providerLabel: provider.label };
    }
    if (!result.ok) {
      setCooldown(provider, result.err.kind, result.err.message, now);
      logger.warn(`IA "${provider.label}" falhou (${result.err.kind}): ${result.err.message}. Tentando próximo...`);
    }
    triedLabels.push(provider.label);
  }

  // Todos estavam em cooldown: tenta o de maior prioridade mesmo assim, para
  // nunca ficar 100% sem resposta enquanto houver chave configurada.
  if (!attempted && skipped.length > 0) {
    const provider = skipped[0];
    const result = await tryProvider(provider, req);
    if (result.ok && result.text) {
      clearCooldown(provider);
      return { text: result.text, providerId: provider.id, providerLabel: provider.label };
    }
    if (!result.ok) setCooldown(provider, result.err.kind, result.err.message, now);
  }

  logger.warn('IA: todos os provedores falharam ou estão em cooldown.');
  return null;
}

/** Snapshot do estado atual da corrente (para health/painel). */
export interface ChainStatusItem {
  id: string;
  kind: AiKind;
  label: string;
  priority: number;
  inCooldown: boolean;
}

export async function getChainStatus(): Promise<ChainStatusItem[]> {
  const chain = await resolveChain();
  const now = Date.now();
  return chain.map((p) => ({
    id: p.id,
    kind: p.kind,
    label: p.label,
    priority: p.priority,
    inCooldown: isInCooldown(p.id, now),
  }));
}
