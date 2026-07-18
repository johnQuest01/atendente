import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * Token assinado (HMAC-SHA256) para a rota PÚBLICA de mídia (/media/...).
 *
 * A rota precisa ser pública para a Z-API baixar o arquivo, mas num ambiente
 * multi-empresa um id conhecido não pode permitir acesso à mídia de OUTRA
 * empresa. O token amarra o `id` ao `tenant_id` que o emitiu e é assinado com o
 * JWT_SECRET — não dá para forjar nem adivinhar. A consulta ao binário passa a
 * filtrar por esse tenant.
 *
 * Sem expiração: as URLs ficam salvas no banco e são entregues aos clientes,
 * então precisam continuar válidas. A garantia aqui é de AUTENTICIDADE/escopo,
 * não de validade temporal.
 */

function hmac(payload: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
}

/** Gera o token que acompanha a URL pública (?t=...). */
export function signMediaToken(tenantId: string, id: string): string {
  return `${Buffer.from(tenantId, 'utf8').toString('base64url')}.${hmac(`${tenantId}.${id}`)}`;
}

/**
 * Verifica o token para um `id`. Retorna o tenant_id assinado (para filtrar a
 * consulta) ou null se ausente/inválido — sem fallback sem tenant.
 */
export function verifyMediaToken(id: string, token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const tenantB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let tenantId: string;
  try {
    tenantId = Buffer.from(tenantB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!tenantId) return null;
  const expected = hmac(`${tenantId}.${id}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? tenantId : null;
}
