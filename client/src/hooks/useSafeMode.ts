import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export const SAFE_MODE_QUERY_KEY = ['safe-mode'] as const;

export interface SafeModeStatus {
  enabled: boolean;
  businessInitiatedEnabled: boolean;
}

export function useSafeModeStatus() {
  return useQuery({
    queryKey: SAFE_MODE_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<SafeModeStatus>('/settings/safe-mode');
      return data;
    },
  });
}

export function useSetSafeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await api.put<SafeModeStatus>('/settings/safe-mode', { enabled });
      return data;
    },
    onSuccess: (data) => qc.setQueryData(SAFE_MODE_QUERY_KEY, data),
  });
}
