import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { SYSTEM_STATUS_QUERY_KEY } from './useSystemStatus';

export type AiKind = 'anthropic' | 'openai' | 'gemini';

export interface AiProviderDto {
  id: string;
  kind: AiKind;
  label: string;
  model: string;
  base_url: string | null;
  priority: number;
  is_active: boolean;
  has_key: boolean;
  key_masked: string | null;
  last_status: string | null;
  last_error: string | null;
  last_used_at: string | null;
  cooldown_until: string | null;
  in_cooldown: boolean;
}

export interface CreateAiProviderInput {
  kind: AiKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  priority?: number;
  isActive?: boolean;
}

export interface UpdateAiProviderInput {
  id: string;
  label?: string;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  priority?: number;
  isActive?: boolean;
}

export interface TestAiCredsInput {
  kind: AiKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface TestResult {
  ok: boolean;
  detail: string;
}

export const AI_PROVIDERS_QUERY_KEY = ['admin-ai-providers'] as const;

export function useAiProviders() {
  return useQuery({
    queryKey: AI_PROVIDERS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ providers: AiProviderDto[] }>('/admin/ai/providers');
      return data.providers;
    },
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: AI_PROVIDERS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: SYSTEM_STATUS_QUERY_KEY });
  };
}

export function useCreateAiProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: CreateAiProviderInput) => {
      const { data } = await api.post('/admin/ai/providers', input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateAiProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateAiProviderInput) => {
      const { data } = await api.patch(`/admin/ai/providers/${id}`, patch);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteAiProvider() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/admin/ai/providers/${id}`);
    },
    onSuccess: invalidate,
  });
}

/** Testa credenciais avulsas (no modal, antes de salvar). */
export function useTestAiCreds() {
  return useMutation({
    mutationFn: async (input: TestAiCredsInput) => {
      const { data } = await api.post<TestResult>('/admin/ai/providers/test', input);
      return data;
    },
  });
}

/** Testa um provedor já salvo (usa a chave guardada). */
export function useTestSavedAiProvider() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<TestResult>(`/admin/ai/providers/${id}/test`, {});
      return data;
    },
  });
}
