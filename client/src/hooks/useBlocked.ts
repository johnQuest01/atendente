import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { useBlockAccess } from '@/store/appStore';

export interface BlockedNumber {
  id: string;
  phone: string;
  label: string | null;
  is_active: boolean;
  created_at: string;
}

const KEY = ['blocked'] as const;

/** Login do cadeado: troca email/senha por um token de acesso à área restrita. */
export function useUnlockBlocked() {
  const setToken = useBlockAccess((s) => s.setToken);
  return useMutation({
    mutationFn: async (input: { email: string; password: string }) => {
      const { data } = await api.post<{ token: string }>('/blocked/unlock', input);
      return data.token;
    },
    onSuccess: (token) => setToken(token),
  });
}

export function useBlockedNumbers(enabled = true) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async () => {
      const { data } = await api.get<{ blocked: BlockedNumber[] }>('/blocked');
      return data.blocked;
    },
  });
}

export function useAddBlocked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { phone: string; label?: string | null }) => {
      const { data } = await api.post<{ blocked: BlockedNumber }>('/blocked', input);
      return data.blocked;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSetBlockedActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { data } = await api.patch<{ blocked: BlockedNumber }>(`/blocked/${id}`, { is_active });
      return data.blocked;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteBlocked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/blocked/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
