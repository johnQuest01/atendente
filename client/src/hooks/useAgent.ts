import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export const AGENT_QUERY_KEY = ['agent-status'] as const;

export function useAgentStatus() {
  return useQuery({
    queryKey: AGENT_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ enabled: boolean }>('/settings/agent');
      return data.enabled;
    },
  });
}

export function useSetAgentStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await api.put<{ enabled: boolean }>('/settings/agent', { enabled });
      return data.enabled;
    },
    // Atualização otimista: a UI responde na hora; revertemos em caso de erro.
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: AGENT_QUERY_KEY });
      const previous = qc.getQueryData<boolean>(AGENT_QUERY_KEY);
      qc.setQueryData(AGENT_QUERY_KEY, enabled);
      return { previous };
    },
    onError: (_err, _enabled, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(AGENT_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (enabled) => qc.setQueryData(AGENT_QUERY_KEY, enabled),
  });
}
