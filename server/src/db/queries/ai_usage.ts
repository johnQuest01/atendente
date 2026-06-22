import { queryOne } from '../index';

/**
 * Uso mensal da IA por empresa. So contamos o uso PAGO PELA PLATAFORMA
 * (provedores globais/.env). Quando a empresa usa as proprias chaves (BYO),
 * o uso nao entra aqui e nao ha teto.
 */

/** Periodo atual no formato 'YYYY-MM' (UTC). */
export function currentYm(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Quantas mensagens de IA (pagas pela plataforma) a empresa usou no mes. */
export async function getAiUsage(tenantId: string, ym = currentYm()): Promise<number> {
  const row = await queryOne<{ used: number }>(
    'SELECT used FROM ai_usage WHERE tenant_id = $1 AND ym = $2',
    [tenantId, ym],
  );
  return row ? Number(row.used) : 0;
}

/** Incrementa (+1) o uso do mes e retorna o novo total (upsert atomico). */
export async function incrementAiUsage(tenantId: string, ym = currentYm()): Promise<number> {
  const row = await queryOne<{ used: number }>(
    `INSERT INTO ai_usage (tenant_id, ym, used, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (tenant_id, ym)
     DO UPDATE SET used = ai_usage.used + 1, updated_at = NOW()
     RETURNING used`,
    [tenantId, ym],
  );
  return row ? Number(row.used) : 0;
}
