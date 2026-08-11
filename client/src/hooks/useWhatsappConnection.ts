import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export type WhatsappProvider = 'zapi' | 'evolution' | 'metacloud';

export interface WhatsappConnectionView {
  id: string;
  label: string;
  phoneNumber: string | null;
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
  phoneNumberId: string | null;
  verifyToken: string | null;
  hasAccessToken: boolean;
  aiPersona: string | null;
  aiTemperature: number | null;
  aiMaxTokens: number | null;
  agentEnabled: boolean | null;
  connectionStatus?: string | null;
  providerMode?: 'web' | 'phoneless' | null;
  instanceOrigin?: string | null;
  webhookConfigured?: boolean;
  status: { ok: boolean; detail: string };
}

export interface WhatsappConnectionsResponse {
  encryptionAvailable: boolean;
  connections: WhatsappConnectionView[];
}

export interface WhatsappConnectionInput {
  label?: string;
  phoneNumber?: string | null;
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
  aiPersona?: string | null;
  aiTemperature?: number | null;
  aiMaxTokens?: number | null;
  agentEnabled?: boolean | null;
}

export const WHATSAPP_CONN_QUERY_KEY = ['whatsapp-connections'] as const;

export function useWhatsappConnections() {
  return useQuery({
    queryKey: WHATSAPP_CONN_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<WhatsappConnectionsResponse>('/settings/whatsapp');
      return data;
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** @deprecated use useWhatsappConnections */
export function useWhatsappConnection() {
  const q = useWhatsappConnections();
  return {
    ...q,
    data: q.data?.connections[0],
  };
}

export function useConfigureWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId?: string) => {
      const path = connectionId
        ? `/settings/whatsapp/${connectionId}/webhook`
        : '/settings/whatsapp/webhook';
      const { data } = await api.post<{ ok: boolean; detail: string; webhookUrl: string }>(path);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: WHATSAPP_CONN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
}

export function useCreateWhatsappConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsappConnectionInput) => {
      const { data } = await api.post<WhatsappConnectionView>('/settings/whatsapp', input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: WHATSAPP_CONN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
}

export function useSaveWhatsappConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsappConnectionInput & { id?: string }) => {
      if (input.id) {
        const { id, ...body } = input;
        const { data } = await api.put<WhatsappConnectionView>(`/settings/whatsapp/${id}`, body);
        return data;
      }
      const { data } = await api.post<WhatsappConnectionView>('/settings/whatsapp', input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: WHATSAPP_CONN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
}

export function useDeleteWhatsappConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/settings/whatsapp/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: WHATSAPP_CONN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['system-status'] });
    },
  });
}
