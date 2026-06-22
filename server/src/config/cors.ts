import { env } from './env';
import { logger } from './logger';

/**
 * Allowlist de CORS. Origens permitidas:
 *   1. Entradas exatas em FRONTEND_URL (lista separada por vírgula).
 *   2. localhost (apenas em desenvolvimento).
 *   3. Deploys de PREVIEW do MESMO projeto Vercel (mesmo prefixo do domínio
 *      configurado em FRONTEND_URL) — NUNCA qualquer site *.vercel.app.
 *
 * Fallback de segurança: se nenhum domínio de produção for configurado, ainda
 * liberamos *.vercel.app (com aviso) para não derrubar o app — feche definindo
 * FRONTEND_URL com o seu domínio real.
 */
const allowList = env.FRONTEND_URL.split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// Prefixos de projeto Vercel derivados das entradas configuradas
// (ex.: "https://atendente-client.vercel.app" → "atendente-client").
const vercelProjectPrefixes = allowList
  .map((u) => {
    try {
      const host = new URL(u).hostname;
      if (host.endsWith('.vercel.app')) {
        return host.replace(/\.vercel\.app$/, '').split('-git-')[0];
      }
    } catch {
      /* ignore */
    }
    return null;
  })
  .filter((v): v is string => Boolean(v));

function isSameProjectVercelPreview(hostname: string): boolean {
  if (!hostname.endsWith('.vercel.app')) return false;
  const sub = hostname.replace(/\.vercel\.app$/, '');
  return vercelProjectPrefixes.some((p) => sub === p || sub.startsWith(`${p}-`));
}

export function isAllowedOrigin(origin?: string): boolean {
  // Requisições sem Origin (curl, apps nativas, same-origin) são liberadas.
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, '');
  if (allowList.includes(normalized)) return true;
  try {
    const host = new URL(origin).hostname;
    if (!env.isProd && host === 'localhost') return true;
    if (isSameProjectVercelPreview(host)) return true;
    // Fallback: sem domínio de produção configurado, não fecha a porta (avisa).
    if (host.endsWith('.vercel.app') && vercelProjectPrefixes.length === 0) {
      logger.warn(
        `CORS: liberando ${host} por fallback. Defina FRONTEND_URL com seu domínio Vercel para fechar a allowlist.`,
      );
      return true;
    }
  } catch {
    /* origin malformado — bloqueia abaixo */
  }
  return false;
}

/** Função de origem compatível com o pacote `cors` (Express e Socket.io). */
export function corsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }
  logger.warn(`Origem bloqueada por CORS: ${origin}`);
  callback(null, false);
}
