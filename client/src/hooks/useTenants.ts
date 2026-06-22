import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export interface TenantSummary {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  users_count: number;
  has_whatsapp: boolean;
  whatsapp_status: string | null;
  /** Teto mensal de mensagens de IA no plano base (null = ilimitado). */
  ai_message_limit: number | null;
  /** Mensagens de IA (pagas pela plataforma) usadas no mês atual. */
  ai_used: number;
}

export interface CreateTenantInput {
  name: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
}

export const TENANTS_QUERY_KEY = ['admin-tenants'] as const;

export function useTenants() {
  return useQuery({
    queryKey: TENANTS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ tenants: TenantSummary[] }>('/admin/tenants');
      return data.tenants;
    },
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTenantInput) => {
      const { data } = await api.post('/admin/tenants', input);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TENANTS_QUERY_KEY }),
  });
}

export function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      is_active?: boolean;
      ai_message_limit?: number | null;
    }) => {
      const { data } = await api.patch(`/admin/tenants/${id}`, patch);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: TENANTS_QUERY_KEY }),
  });
}
