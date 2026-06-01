import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { DashboardData } from '@/types';

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const { data } = await api.get<DashboardData>('/dashboard');
      return data;
    },
    refetchInterval: 30_000,
  });
}
