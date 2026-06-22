import { env } from '../config/env';
import { pool } from '../db';
import { getTenantWhatsapp } from './whatsapp.service';
import { adapters, getChainStatus, resolveChain } from './ai/orchestrator';
import type { WhatsappProviderName } from '../db/queries/whatsapp_connections';

/**
 * Health check REAL: cada serviço externo é TESTADO de fato (não apenas "a
 * variável existe"), com timeout curto e sem derrubar a resposta. Cada item
 * retorna { ok, detail } com o motivo legível da falha.
 *
 * O check de WhatsApp é POR EMPRESA (tenant): usa a conexão cadastrada do
 * tenant. Banco, IA e STT são globais (config única da plataforma).
 *
 * Há um cache curto, por tenant, para evitar martelar as APIs externas se a
 * tela de status for atualizada várias vezes seguidas.
 */

export interface ServiceCheck {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  whatsappProvider: WhatsappProviderName;
  /** Provedor de IA ativo no momento (ex.: "Claude"), ou "nenhum". */
  aiProvider: string;
  storage: 'remote' | 'local';
  services: {
    database: ServiceCheck;
    ai: ServiceCheck;
    whatsapp: ServiceCheck;
    transcription: ServiceCheck;
  };
}

function errMessage(err: unknown, fallback = 'Erro desconhecido'): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || err.message.toLowerCase().includes('timeout')
      ? 'Tempo esgotado (timeout).'
      : err.message;
  }
  return fallback;
}

async function checkDatabase(): Promise<ServiceCheck> {
  try {
    await pool.query('SELECT 1');
    return { ok: true, detail: 'Conectado ao banco (Neon).' };
  } catch (err) {
    return { ok: false, detail: errMessage(err, 'Falha ao conectar no banco.') };
  }
}

/**
 * Valida a IA: testa a chave do provedor ATIVO (o primeiro fora de cooldown) e
 * descreve a cadeia de fallback. Com mais de um provedor, a IA é considerada
 * "ok" mesmo se o ativo falhar (o failover cobre).
 */
async function checkAi(): Promise<{ check: ServiceCheck; provider: string }> {
  const chain = await resolveChain();
  if (chain.length === 0) {
    return { check: { ok: false, detail: 'Nenhum provedor de IA configurado.' }, provider: 'nenhum' };
  }

  const status = await getChainStatus();
  const isCold = (id: string) => status.find((s) => s.id === id)?.inCooldown ?? false;
  const active = chain.find((p) => !isCold(p.id)) ?? chain[0];
  const others = chain.filter((p) => p.id !== active.id).map((p) => p.label);
  const fallbackTxt = others.length ? ` Fallback: ${others.join(' → ')}.` : ' Sem fallback configurado.';
  const hasFallback = chain.length > 1;

  try {
    const result = await adapters[active.kind].validateKey(active.creds);
    return {
      check: { ok: result.ok || hasFallback, detail: `Ativa: ${active.label}. ${result.detail}${fallbackTxt}` },
      provider: active.label,
    };
  } catch (err) {
    return {
      check: { ok: hasFallback, detail: `${active.label}: ${errMessage(err, 'Falha ao validar.')}${fallbackTxt}` },
      provider: active.label,
    };
  }
}

async function checkTranscription(): Promise<ServiceCheck> {
  if (env.STT_PROVIDER === 'none') {
    return { ok: false, detail: 'Transcrição desativada (opcional).' };
  }
  if (!env.STT_API_KEY) {
    return { ok: false, detail: 'STT_API_KEY ausente.' };
  }
  try {
    const res = await fetch(`${env.STT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return { ok: true, detail: `Endpoint OK (modelo ${env.STT_MODEL}).` };
    if (res.status === 401) return { ok: false, detail: 'Chave inválida (401).' };
    return { ok: false, detail: `STT respondeu HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, detail: errMessage(err, 'Falha ao validar a transcrição.') };
  }
}

const cache = new Map<string, { at: number; report: HealthReport }>();
const CACHE_MS = 10_000;

/** Monta o relatório completo de saúde do tenant (com cache curto por empresa). */
export async function getHealthReport(tenantId: string, force = false): Promise<HealthReport> {
  const cached = cache.get(tenantId);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.report;
  }

  const wa = await getTenantWhatsapp(tenantId);
  const [database, ai, wpp, transcription] = await Promise.all([
    checkDatabase(),
    checkAi(),
    wa.getConnectionStatus(),
    checkTranscription(),
  ]);

  const report: HealthReport = {
    // "degraded" se o essencial (banco ou WhatsApp) estiver fora.
    status: database.ok && wpp.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    whatsappProvider: wa.provider,
    aiProvider: ai.provider,
    storage: env.hasRemoteStorage ? 'remote' : 'local',
    services: { database, ai: ai.check, whatsapp: wpp, transcription },
  };

  cache.set(tenantId, { at: Date.now(), report });
  return report;
}
