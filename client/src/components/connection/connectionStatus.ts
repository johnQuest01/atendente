import type { WhatsappConnectionView } from '@/hooks/useWhatsappConnection';

export type ConnectionStatusKind = 'connected' | 'offline' | 'unconfigured';

export type ConnectionStatusTone = 'success' | 'warning' | 'neutral';

export interface ConnectionStatusInfo {
  kind: ConnectionStatusKind;
  label: string;
  tone: ConnectionStatusTone;
}

/**
 * Conectado = success, Offline = warning, Não configurado = neutral.
 * Prefere connectionStatus do onboarding; fallback status.ok / configured.
 */
export function getConnectionStatus(
  conn: Pick<WhatsappConnectionView, 'configured' | 'status' | 'connectionStatus'>,
): ConnectionStatusInfo {
  const lifecycle = (conn.connectionStatus ?? '').toUpperCase();
  if (lifecycle === 'CONECTADO' || conn.status?.ok) {
    return { kind: 'connected', label: 'Conectado', tone: 'success' };
  }
  if (
    lifecycle === 'AGUARDANDO_LEITURA' ||
    lifecycle === 'CONECTANDO' ||
    lifecycle === 'PROVISIONING'
  ) {
    return { kind: 'offline', label: 'Aguardando pareamento', tone: 'warning' };
  }
  if (lifecycle === 'ERRO' || lifecycle === 'EXPIRADO') {
    return { kind: 'offline', label: lifecycle === 'EXPIRADO' ? 'Expirado' : 'Erro', tone: 'warning' };
  }
  if (conn.configured || lifecycle === 'DESCONECTADO') {
    return { kind: 'offline', label: 'Offline', tone: 'warning' };
  }
  return { kind: 'unconfigured', label: 'Não configurado', tone: 'neutral' };
}
