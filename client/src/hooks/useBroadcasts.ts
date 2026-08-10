import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export interface Broadcast {
  id: string;
  title: string;
  content_type: 'text' | 'audio' | 'product';
  content_ref: string | null;
  body_text: string | null;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'done' | 'cancelled';
  scheduled_at: string | null;
  with_price: boolean;
  daily_cap: number;
  connection_id: string | null;
  created_at: string;
}

export interface BroadcastCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export function useBroadcasts() {
  return useQuery({
    queryKey: ['broadcasts'],
    queryFn: async () => {
      const { data } = await api.get<{ broadcasts: Broadcast[] }>('/broadcasts');
      return data.broadcasts;
    },
    refetchInterval: 15_000,
  });
}

export function useBroadcastDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['broadcast', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<{ broadcast: Broadcast; counts: BroadcastCounts }>(
        `/broadcasts/${id}`,
      );
      return data;
    },
    refetchInterval: 8_000,
  });
}

export function useCreateBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      title: string;
      content_type: 'text' | 'audio' | 'product';
      body_text?: string;
      content_ref?: string;
      all_clients?: boolean;
      with_price?: boolean;
      daily_cap?: number;
      connection_id: string;
    }) => {
      const { data } = await api.post<{ broadcast: Broadcast; targets_added: number }>(
        '/broadcasts',
        body,
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
}

export function useCancelBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<{ broadcast: Broadcast }>(`/broadcasts/${id}/cancel`);
      return data.broadcast;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
}
