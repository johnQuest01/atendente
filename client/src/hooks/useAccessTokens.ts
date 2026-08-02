import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

/**
 * Token de acesso por empresa. O superadmin gera/revoga (rotas /admin); qualquer
 * usuário vê o token da PRÓPRIA empresa no Settings (rota /settings/access-token).
 */

export interface AccessToken {
  id: string;
  tenant_id: string;
  token_prefix: string;
  label: string | null;
  created_by: string | null;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface AccessTokenReveal extends AccessToken {
  token: string;
}

// ---------------------------------------------------------------------------
// Usuário — token da própria empresa (só-leitura)
// ---------------------------------------------------------------------------

export const MY_ACCESS_TOKEN_KEY = ['my-access-token'] as const;

export function useMyAccessToken() {
  return useQuery({
    queryKey: MY_ACCESS_TOKEN_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ token: AccessTokenReveal | null }>('/settings/access-token');
      return data.token;
    },
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Superadmin — tokens por empresa
// ---------------------------------------------------------------------------

export function tenantTokensKey(tenantId: string) {
  return ['admin-access-tokens', tenantId] as const;
}

export function useTenantTokens(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: tenantTokensKey(tenantId),
    queryFn: async () => {
      const { data } = await api.get<{ tokens: AccessToken[]; active: AccessTokenReveal | null }>(
        `/admin/tenants/${tenantId}/access-tokens`,
      );
      return data;
    },
    enabled,
    staleTime: 10_000,
  });
}

export interface GenerateTokenInput {
  tenantId: string;
  label?: string;
  expiresInDays?: number | null;
}

export function useGenerateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ tenantId, label, expiresInDays }: GenerateTokenInput) => {
      const { data } = await api.post<{ token: AccessTokenReveal }>(
        `/admin/tenants/${tenantId}/access-token`,
        { label, expiresInDays },
      );
      return data.token;
    },
    onSuccess: (_t, { tenantId }) =>
      void qc.invalidateQueries({ queryKey: tenantTokensKey(tenantId) }),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; tenantId: string }) => {
      await api.delete(`/admin/access-tokens/${id}`);
    },
    onSuccess: (_v, { tenantId }) =>
      void qc.invalidateQueries({ queryKey: tenantTokensKey(tenantId) }),
  });
}
