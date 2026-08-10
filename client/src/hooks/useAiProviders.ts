import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import { SYSTEM_STATUS_QUERY_KEY } from './useSystemStatus';

export type AiKind = 'anthropic' | 'openai' | 'gemini';

/**
 * Escopo dos provedores de IA (modelo híbrido):
 *   - 'global': padrão da plataforma (super-admin, rotas /admin/ai/...)
 *   - 'tenant': IA da própria empresa (admin, rotas /settings/ai/...)
 */
export type AiScope = 'global' | 'tenant';

const BASE: Record<AiScope, string> = {
  global: '/admin/ai/providers',
  tenant: '/settings/ai/providers',
};

export type ChainSource = 'tenant' | 'global' | 'env' | null;

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
  /** null = atende todas as instâncias WhatsApp. */
  connection_id: string | null;
  connection_label: string | null;
  connection_phone: string | null;
}

export interface AiProvidersResponse {
  providers: AiProviderDto[];
  source: ChainSource;
}

export interface AiUsageInfo {
  used: number;
  limit: number | null;
  source: ChainSource;
  ym: string;
}

export interface CreateAiProviderInput {
  kind: AiKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  priority?: number;
  isActive?: boolean;
  /** null = todas as instâncias. */
  connectionId?: string | null;
}

export interface UpdateAiProviderInput {
  id: string;
  label?: string;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string;
  priority?: number;
  isActive?: boolean;
  connectionId?: string | null;
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

export interface ListAiModelsInput {
  kind: AiKind;
  apiKey: string;
  baseUrl?: string;
}

export interface AiModelsResult {
  /** Conseguiu listar os modelos (endpoint respondeu). */
  ok: boolean;
  /** Chave inválida/sem permissão. */
  authError: boolean;
  /** IDs dos modelos disponíveis no provedor. */
  models: string[];
  error: string | null;
}

export const aiProvidersQueryKey = (scope: AiScope) => ['ai-providers', scope] as const;
export const aiUsageQueryKey = (scope: AiScope) => ['ai-usage', scope] as const;

export function useAiProviders(scope: AiScope) {
  return useQuery({
    queryKey: aiProvidersQueryKey(scope),
    queryFn: async () => {
      const { data } = await api.get<AiProvidersResponse>(BASE[scope]);
      return data;
    },
  });
}

/** Uso/teto de IA da empresa (apenas escopo 'tenant'). */
export function useAiUsage(scope: AiScope, enabled = true) {
  return useQuery({
    queryKey: aiUsageQueryKey(scope),
    enabled: scope === 'tenant' && enabled,
    queryFn: async () => {
      const { data } = await api.get<AiUsageInfo>('/settings/ai/usage');
      return data;
    },
  });
}

function useInvalidate(scope: AiScope) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: aiProvidersQueryKey(scope) });
    void qc.invalidateQueries({ queryKey: aiUsageQueryKey(scope) });
    void qc.invalidateQueries({ queryKey: SYSTEM_STATUS_QUERY_KEY });
  };
}

export function useCreateAiProvider(scope: AiScope) {
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: async (input: CreateAiProviderInput) => {
      const { data } = await api.post(BASE[scope], input);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateAiProvider(scope: AiScope) {
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: async ({ id, ...patch }: UpdateAiProviderInput) => {
      const { data } = await api.patch(`${BASE[scope]}/${id}`, patch);
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteAiProvider(scope: AiScope) {
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`${BASE[scope]}/${id}`);
    },
    onSuccess: invalidate,
  });
}

/** Testa credenciais avulsas (no modal, antes de salvar). */
export function useTestAiCreds(scope: AiScope) {
  return useMutation({
    mutationFn: async (input: TestAiCredsInput) => {
      const { data } = await api.post<TestResult>(`${BASE[scope]}/test`, input);
      return data;
    },
  });
}

/** Lista os modelos disponíveis de um provedor (seletor inteligente / campo "Outro"). */
export function useListAiModels(scope: AiScope) {
  return useMutation({
    mutationFn: async (input: ListAiModelsInput) => {
      const { data } = await api.post<AiModelsResult>(`${BASE[scope]}/models`, input);
      return data;
    },
  });
}

/** Modelos reais de um provedor JÁ salvo (usa a chave guardada; para trocar de modelo). */
export function useListSavedAiModels(scope: AiScope) {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<AiModelsResult>(`${BASE[scope]}/${id}/models`, {});
      return data;
    },
  });
}

/** Testa um provedor já salvo (usa a chave guardada). Atualiza o status na lista. */
export function useTestSavedAiProvider(scope: AiScope) {
  const invalidate = useInvalidate(scope);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<TestResult>(`${BASE[scope]}/${id}/test`, {});
      return data;
    },
    // O teste grava last_status no servidor; refetch pra o selo refletir na hora.
    onSuccess: invalidate,
  });
}
