import { env } from './env';
import { logger } from './logger';

/**
 * Origens permitidas para CORS. Aceita uma lista separada por vírgula em
 * FRONTEND_URL e, além disso, libera automaticamente qualquer subdomínio
 * *.vercel.app (cobre o domínio de produção e os deploys de preview do Vercel).
 */
const allowList = env.FRONTEND_URL.split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

export function isAllowedOrigin(origin?: string): boolean {
  // Requisições sem Origin (curl, apps nativas, same-origin) são liberadas.
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, '');
  if (allowList.includes(normalized)) return true;
  try {
    const host = new URL(origin).hostname;
    if (host === 'localhost' || host.endsWith('.vercel.app')) return true;
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
