import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

/**
 * Onboarding WhatsApp embutido.
 *
 * Socket.IO (sala `tenant:<id>`):
 * - Evento `whatsapp:status`
 * - Payload: `{ connectionId, status, detail?, phone?, qrBase64?, phoneCode? }`
 * - status: PROVISIONING | AGUARDANDO_LEITURA | CONECTANDO | CONECTADO | ERRO | EXPIRADO | DESCONECTADO
 *
 * REST:
 * - POST /whatsapp/connect
 * - GET  /whatsapp/connect/:id/qr
 * - POST /whatsapp/connect/:id/phone-code
 * - GET  /whatsapp/connect/:id/status
 * - POST /whatsapp/connect/:id/disconnect
 * - POST /whatsapp/connect/:id/reconnect
 * - POST /tenants/:tenantId/whatsapp/activate-paid
 */

export type OnboardingStatus =
  | 'PROVISIONING'
  | 'AGUARDANDO_LEITURA'
  | 'CONECTANDO'
  | 'CONECTADO'
  | 'ERRO'
  | 'EXPIRADO'
  | 'DESCONECTADO';

export interface ConnectStartResult {
  connectionId: string;
  label: string;
  status: OnboardingStatus;
  qrBase64: string | null;
  phoneCode: string | null;
  phone: string | null;
  providerMode: 'web' | 'phoneless';
  phonelessWarning: boolean;
  webhookConfigured: boolean;
  timeoutMinutes: number;
  instructions: string;
}

export interface ConnectStatusResult {
  connectionId: string;
  status: OnboardingStatus;
  phone: string | null;
  connected: boolean;
  webhookConfigured: boolean;
  providerMode: 'web' | 'phoneless';
  instanceOrigin: string;
  expiresAt: string | null;
}

export function useStartWhatsappConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      label?: string;
      providerMode?: 'web' | 'phoneless';
      phone?: string;
    }) => {
      const { data } = await api.post<ConnectStartResult>('/whatsapp/connect', input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whatsapp-connections'] });
    },
  });
}

export function useRefreshQr(connectionId: string | undefined) {
  return useMutation({
    mutationFn: async () => {
      if (!connectionId) throw new Error('Sem conexão');
      const { data } = await api.get<{ qrBase64: string | null; challenge: boolean }>(
        `/whatsapp/connect/${connectionId}/qr`,
      );
      return data;
    },
  });
}

export function useRequestPhoneCode(connectionId: string | undefined) {
  return useMutation({
    mutationFn: async (phone: string) => {
      if (!connectionId) throw new Error('Sem conexão');
      const { data } = await api.post<{ code: string }>(
        `/whatsapp/connect/${connectionId}/phone-code`,
        { phone },
      );
      return data;
    },
  });
}

export function useConnectStatus(connectionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp-connect-status', connectionId],
    enabled: Boolean(connectionId) && enabled,
    refetchInterval: enabled ? 4_000 : false,
    queryFn: async () => {
      const { data } = await api.get<ConnectStatusResult>(
        `/whatsapp/connect/${connectionId}/status`,
      );
      return data;
    },
  });
}

export function useDisconnectWhatsapp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { data } = await api.post<{ ok: boolean }>(
        `/whatsapp/connect/${connectionId}/disconnect`,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whatsapp-connections'] });
    },
  });
}

export function useRestartWhatsappConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      connectionId: string;
      label?: string;
      providerMode?: 'web' | 'phoneless';
      phone?: string;
    }) => {
      const { data } = await api.post<ConnectStartResult>(
        `/whatsapp/connect/${input.connectionId}/reconnect`,
        {
          label: input.label,
          providerMode: input.providerMode,
          phone: input.phone,
        },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whatsapp-connections'] });
    },
  });
}
