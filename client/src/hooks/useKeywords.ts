import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { ContentType, Keyword } from '@/types';

export interface KeywordInput {
  keyword: string;
  intent: string;
  content_type: ContentType;
  content_id?: string | null;
  priority: number;
}

export function useKeywords() {
  return useQuery({
    queryKey: ['keywords'],
    queryFn: async () => {
      const { data } = await api.get<{ keywords: Keyword[] }>('/keywords');
      return data.keywords;
    },
  });
}

export function useCreateKeyword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: KeywordInput) => {
      const { data } = await api.post<{ keyword: Keyword }>('/keywords', input);
      return data.keyword;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keywords'] }),
  });
}

export function useUpdateKeyword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Keyword> }) => {
      const { data } = await api.patch<{ keyword: Keyword }>(`/keywords/${id}`, patch);
      return data.keyword;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keywords'] }),
  });
}

export function useDeleteKeyword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/keywords/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['keywords'] }),
  });
}
