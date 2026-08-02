import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { SYSTEM_STATUS_QUERY_KEY } from './useSystemStatus';

export type WhatsappProvider = 'zapi' | 'evolution' | 'metacloud';

export interface WhatsappConnectionView {
  provider: WhatsappProvider;
  baseUrl: string | null;
  isActive: boolean;
  configured: boolean;
  encryptionAvailable: boolean;
  webhookUrl: string | null;
  instanceId: string | null;
  instance: string | null;
  hasToken: boolean;
  hasClientToken: boolean;
  hasApiKey: boolean;
  /** Meta Cloud: não são segredos — o cliente precisa vê-los para configurar. */
  phoneNumberId: string | null;
  verifyToken: string | null;
  hasAccessToken: boolean;
  status: { ok: boolean; detail: string };
}

export interface WhatsappConnectionInput {
  provider: WhatsappProvider;
  instanceId?: string;
  token?: string;
  clientToken?: string;
  apiKey?: string;
  instance?: string;
  accessToken?: string;
  phoneNumberId?: string;
  baseUrl?: string;
  isActive?: boolean;
}

export const WHATSAPP_CONN_QUERY_KEY = ['whatsapp-connection'] as const;

export function useWhatsappConnection() {
  return useQuery({
    queryKey: WHATSAPP_CONN_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<WhatsappConnectionView>('/settings/whatsapp');
      return data;
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export function useSaveWhatsappConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsappConnectionInput) => {
      const { data } = await api.put<WhatsappConnectionView>('/settings/whatsapp', input);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(WHATSAPP_CONN_QUERY_KEY, data);
      // O status do sistema também depende da conexão de WhatsApp.
      void qc.invalidateQueries({ queryKey: SYSTEM_STATUS_QUERY_KEY });
    },
  });
}
