import { env } from '../config/env';
import { pool } from '../db';
import * as whatsapp from './whatsapp.service';

/**
 * Health check REAL: cada serviço externo é TESTADO de fato (não apenas "a
 * variável existe"), com timeout curto e sem derrubar a resposta. Cada item
 * retorna { ok, detail } com o motivo legível da falha.
 *
 * Há um cache curto para evitar martelar as APIs externas se a tela de status
 * for atualizada várias vezes seguidas.
 */

export interface ServiceCheck {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  whatsappProvider: 'zapi' | 'evolution';
  storage: 'remote' | 'local';
  services: {
    database: ServiceCheck;
    claude: ServiceCheck;
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

async function checkClaude(): Promise<ServiceCheck> {
  if (!env.hasAnthropic) {
    return { ok: false, detail: 'ANTHROPIC_API_KEY ausente — IA desativada.' };
  }
  try {
    // GET /v1/models valida a chave sem consumir tokens.
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return { ok: true, detail: `Chave válida (modelo ${env.CLAUDE_MODEL}).` };
    if (res.status === 401) return { ok: false, detail: 'Chave inválida ou revogada (401).' };
    return { ok: false, detail: `Anthropic respondeu HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, detail: errMessage(err, 'Falha ao validar o Claude.') };
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

let cache: { at: number; report: HealthReport } | null = null;
const CACHE_MS = 10_000;

/** Monta o relatório completo de saúde (com cache curto). */
export async function getHealthReport(force = false): Promise<HealthReport> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return cache.report;
  }

  const [database, claude, wpp, transcription] = await Promise.all([
    checkDatabase(),
    checkClaude(),
    whatsapp.getConnectionStatus(),
    checkTranscription(),
  ]);

  const report: HealthReport = {
    // "degraded" se o essencial (banco ou WhatsApp) estiver fora.
    status: database.ok && wpp.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    whatsappProvider: env.WHATSAPP_PROVIDER,
    storage: env.hasRemoteStorage ? 'remote' : 'local',
    services: { database, claude, whatsapp: wpp, transcription },
  };

  cache = { at: Date.now(), report };
  return report;
}
