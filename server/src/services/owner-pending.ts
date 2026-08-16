/**
 * Plano de envio pendente do dono — aguardando UMA confirmação (sim/não).
 * In-memory, TTL curto, chave por tenant + número do dono + conexão.
 *
 * Regra de ouro: nada aqui carrega texto/raciocínio da IA. Cada PlannedSend
 * guarda só o CORPO literal (`body`) que a IA propôs no campo mensagem/relay,
 * o contato já resolvido e, para agendados, quando disparar.
 */

const TTL_MS = 5 * 60_000;

export interface PlannedSend {
  clientId: string;
  name: string;
  phone: string;
  /** Corpo literal a enviar. NUNCA raciocínio/preâmbulo da IA. */
  body: string;
  /** Epoch ms de quando disparar. null/ausente = enviar agora. */
  fireAtMs?: number | null;
}

const plans = new Map<string, { at: number; sends: PlannedSend[] }>();

export function pendingPlanKey(
  tenantId: string,
  ownerPhone: string,
  connectionId?: string | null,
): string {
  return `${tenantId}:${ownerPhone}:${connectionId ?? ''}`;
}

export function rememberPendingPlan(key: string, sends: PlannedSend[]): void {
  if (!sends.length) {
    plans.delete(key);
    return;
  }
  plans.set(key, { at: Date.now(), sends: sends.map((s) => ({ ...s })) });
}

/** Plano pendente ou null se expirou/não existe. */
export function getPendingPlan(key: string): PlannedSend[] | null {
  const row = plans.get(key);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    plans.delete(key);
    return null;
  }
  return row.sends;
}

export function clearPendingPlan(key: string): void {
  plans.delete(key);
}
