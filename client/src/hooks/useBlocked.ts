import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export interface BlockedNumber {
  id: string;
  phone: string;
  label: string | null;
  is_active: boolean;
  created_at: string;
}

const KEY = ['blocked'] as const;

export function useBlockedNumbers() {
  return useQuery({
    queryKey: KEY,
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
