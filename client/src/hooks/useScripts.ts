import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { TextScript } from '@/types';

export interface ScriptInput {
  title: string;
  category: string;
  content: string;
  keywords: string[];
}

export function useScripts() {
  return useQuery({
    queryKey: ['scripts'],
    queryFn: async () => {
      const { data } = await api.get<{ scripts: TextScript[] }>('/messages');
      return data.scripts;
    },
  });
}

export function useCreateScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScriptInput) => {
      const { data } = await api.post<{ script: TextScript }>('/messages', input);
      return data.script;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useUpdateScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<TextScript> }) => {
      const { data } = await api.patch<{ script: TextScript }>(`/messages/${id}`, patch);
      return data.script;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useDeleteScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/messages/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scripts'] }),
  });
}
