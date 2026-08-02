import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

/**
 * Convites de acesso (super-admin). Enquanto não há gateway de pagamento, é o
 * caminho de entrada: gerar link → cliente cria a conta → teste começa.
 */

export interface Invite {
  id: string;
  token: string;
  email: string | null;
  company_name: string | null;
  trial_days: number;
  ai_message_limit: number | null;
  expires_at: string;
  used_at: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  created_at: string;
  url: string;
}

export interface CreateInviteInput {
  email?: string;
  companyName?: string;
  trialDays: number;
  expiresInDays: number;
  aiMessageLimit?: number | null;
}

export const INVITES_QUERY_KEY = ['admin-invites'] as const;

export function useInvites(enabled = true) {
  return useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ invites: Invite[] }>('/admin/invites');
      return data.invites;
    },
    enabled,
    staleTime: 10_000,
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInviteInput) => {
      const { data } = await api.post<{ invite: Invite; url: string }>('/admin/invites', input);
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: INVITES_QUERY_KEY }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/invites/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: INVITES_QUERY_KEY }),
  });
}

export function inviteStatus(invite: Invite): 'used' | 'expired' | 'open' {
  if (invite.used_at) return 'used';
  return Date.parse(invite.expires_at) <= Date.now() ? 'expired' : 'open';
}
