import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export function agentQueryKey(connectionId?: string) {
  return ['agent-status', connectionId] as const;
}

/** @deprecated use agentQueryKey(connectionId) */
export const AGENT_QUERY_KEY = agentQueryKey();

export function useAgentStatus(connectionId?: string) {
  return useQuery({
    queryKey: agentQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<{ enabled: boolean }>('/settings/agent', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data.enabled;
    },
  });
}

export function useSetAgentStatus(connectionId?: string) {
  const qc = useQueryClient();
  const key = agentQueryKey(connectionId);
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await api.put<{ enabled: boolean }>(
        '/settings/agent',
        { enabled },
        { params: connectionId ? { connectionId } : undefined },
      );
      return data.enabled;
    },
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<boolean>(key);
      qc.setQueryData(key, enabled);
      return { previous };
    },
    onError: (_err, _enabled, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(key, context.previous);
      }
    },
    onSuccess: (enabled) => qc.setQueryData(key, enabled),
  });
}
