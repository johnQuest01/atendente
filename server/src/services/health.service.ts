import { env } from '../config/env';
import { pool } from '../db';
import { getTenantWhatsapp } from './whatsapp.service';
import { adapters, getChainStatus, resolveChain } from './ai/orchestrator';
import { missingStorageVars, testRemoteStorage } from './storage.service';
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
  /**
   * Quem está REALMENTE atendendo agora (ex.: "Meta Cloud", "Groq", "Neon").
   * É o que a tela mostra — trocar de provedor troca o nome aqui, sem rótulo
   * chumbado no front.
   */
  provider?: string | null;
  /** Quanto a checagem demorou, em ms. Denuncia lentidão antes da queda. */
  latencyMs?: number;
  /** Opcional não derruba o status geral (ex.: transcrição desligada). */
  optional?: boolean;
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
    storage: ServiceCheck;
  };
}

/** Rótulo de exibição de cada provedor de WhatsApp. */
const WHATSAPP_LABEL: Record<WhatsappProviderName, string> = {
  zapi: 'Z-API',
  evolution: 'Evolution API',
  metacloud: 'WhatsApp Oficial (Meta)',
};

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // A connection string do Postgres também é parseável como URL.
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Deduz o nome do banco a partir do host da connection string. Nada de "Neon"
 * chumbado: se você migrar de provedor, a tela acompanha.
 */
function describeDatabase(): string {
  const host = hostOf(env.DATABASE_URL);
  if (!host) return 'PostgreSQL';
  if (host.includes('localhost') || host === '127.0.0.1') return 'PostgreSQL local';
  let name = 'PostgreSQL';
  if (host.endsWith('neon.tech')) name = 'Neon';
  else if (host.includes('supabase')) name = 'Supabase';
  else if (host.includes('rds.amazonaws')) name = 'Amazon RDS';
  else if (host.includes('render.com')) name = 'Render Postgres';
  // Hosts gerenciados costumam trazer a região no próprio nome (sa-east-1).
  const region = host.split('.').find((p) => /^[a-z]{2}-[a-z]+-\d$/.test(p));
  return region ? `${name} · ${region}` : name;
}

/** Mesma ideia para o speech-to-text, que é um endpoint compatível com OpenAI. */
function describeStt(): string {
  const host = hostOf(env.STT_BASE_URL);
  if (!host) return 'STT';
  if (host.includes('groq.com')) return 'Groq';
  if (host.includes('openai.com')) return 'OpenAI';
  if (host.includes('deepgram')) return 'Deepgram';
  return host;
}

/** Mede quanto uma checagem demorou, sem deixar a exceção escapar. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
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
  const provider = describeDatabase();
  try {
    const { ms } = await timed(() => pool.query('SELECT 1'));
    return {
      ok: true,
      provider,
      latencyMs: ms,
      // Acima de ~300ms por ida e volta quase sempre é distância física entre
      // o servidor e o banco — vale dizer, não só mostrar o número.
      detail: ms > 300 ? `Conectado, mas lento (${ms}ms) — servidor e banco em regiões distantes?` : 'Conectado.',
    };
  } catch (err) {
    return { ok: false, provider, detail: errMessage(err, 'Falha ao conectar no banco.') };
  }
}

/**
 * Valida a IA: testa a chave do provedor ATIVO (o primeiro fora de cooldown) e
 * descreve a cadeia de fallback. Com mais de um provedor, a IA é considerada
 * "ok" mesmo se o ativo falhar (o failover cobre).
 */
const SOURCE_LABEL: Record<string, string> = {
  tenant: 'chaves da empresa',
  global: 'padrão da plataforma',
  env: 'padrão da plataforma (.env)',
};

async function checkAi(tenantId: string): Promise<{ check: ServiceCheck; provider: string }> {
  const chain = await resolveChain(tenantId);
  if (chain.providers.length === 0) {
    return { check: { ok: false, detail: 'Nenhum provedor de IA configurado.' }, provider: 'nenhum' };
  }

  const status = await getChainStatus(tenantId);
  const isCold = (id: string) => status.items.find((s) => s.id === id)?.inCooldown ?? false;
  const active = chain.providers.find((p) => !isCold(p.id)) ?? chain.providers[0];
  const others = chain.providers.filter((p) => p.id !== active.id).map((p) => p.label);
  const fallbackTxt = others.length ? ` Fallback: ${others.join(' → ')}.` : ' Sem fallback configurado.';
  const sourceTxt = chain.source ? ` [${SOURCE_LABEL[chain.source] ?? chain.source}]` : '';
  const hasFallback = chain.providers.length > 1;

  try {
    const { value: result, ms } = await timed(() => adapters[active.kind].validateKey(active.creds));
    return {
      check: {
        ok: result.ok || hasFallback,
        provider: active.label,
        latencyMs: ms,
        detail: `${sourceTxt.trim()} ${result.detail}${fallbackTxt}`.trim(),
      },
      provider: active.label,
    };
  } catch (err) {
    return {
      check: {
        ok: hasFallback,
        provider: active.label,
        detail: `${errMessage(err, 'Falha ao validar.')}${fallbackTxt}`,
      },
      provider: active.label,
    };
  }
}

async function checkTranscription(): Promise<ServiceCheck> {
  if (env.STT_PROVIDER === 'none') {
    return { ok: false, optional: true, provider: null, detail: 'Desativada — áudios não são transcritos.' };
  }
  const provider = describeStt();
  if (!env.STT_API_KEY) {
    return { ok: false, optional: true, provider, detail: 'STT_API_KEY ausente.' };
  }
  try {
    const { value: res, ms } = await timed(() =>
      fetch(`${env.STT_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
        signal: AbortSignal.timeout(6000),
      }),
    );
    if (res.ok) return { ok: true, optional: true, provider, latencyMs: ms, detail: `Modelo ${env.STT_MODEL}.` };
    if (res.status === 401) return { ok: false, optional: true, provider, detail: 'Chave inválida (401).' };
    return { ok: false, optional: true, provider, detail: `Respondeu HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, optional: true, provider, detail: errMessage(err, 'Falha ao validar a transcrição.') };
  }
}

/**
 * Onde a mídia é hospedada. Local funciona, mas some a cada deploy sem disco
 * persistente e a URL depende do backend estar no ar — por isso conta como
 * degradado, não como falha.
 */
async function checkStorage(): Promise<ServiceCheck> {
  if (env.hasRemoteStorage) {
    const host = hostOf(env.S3_PUBLIC_URL) ?? '';
    const name = host.includes('r2.dev') || host.includes('cloudflare') ? 'Cloudflare R2' : host || 'S3';
    // Escreve de verdade: ter as variáveis não prova que a chave funciona.
    const { value: result, ms } = await timed(() => testRemoteStorage());
    return { ok: result.ok, provider: name, latencyMs: ms, detail: result.detail };
  }

  const missing = missingStorageVars();
  // Nenhuma variável = escolha consciente (dev). Algumas = engano de config, e
  // é o caso que precisa gritar: parece configurado, mas está gravando no disco.
  if (missing.length < 5) {
    return {
      ok: false,
      provider: 'Disco local',
      detail: `Configuração do R2 incompleta — falta: ${missing.join(', ')}. A mídia está indo para o disco do servidor.`,
    };
  }
  return {
    ok: false,
    optional: true,
    provider: 'Disco local',
    detail: 'Sem CDN: a mídia depende do servidor no ar. Configure o R2 para URL permanente.',
  };
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
  const [database, ai, wppTimed, transcription, storage] = await Promise.all([
    checkDatabase(),
    checkAi(tenantId),
    timed(() => wa.getConnectionStatus()),
    checkTranscription(),
    checkStorage(),
  ]);

  // O nome do provedor de WhatsApp vem daqui pronto: quando a empresa troca de
  // Z-API para Meta, a tela passa a dizer "Meta" sozinha.
  const whatsapp: ServiceCheck = {
    ...wppTimed.value,
    provider: wa.configured ? WHATSAPP_LABEL[wa.provider] : null,
    latencyMs: wppTimed.ms,
  };

  const report: HealthReport = {
    // "degraded" se o essencial (banco ou WhatsApp) estiver fora.
    status: database.ok && whatsapp.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    whatsappProvider: wa.provider,
    aiProvider: ai.provider,
    storage: env.hasRemoteStorage ? 'remote' : 'local',
    services: { database, ai: ai.check, whatsapp, transcription, storage },
  };

  cache.set(tenantId, { at: Date.now(), report });
  return report;
}
