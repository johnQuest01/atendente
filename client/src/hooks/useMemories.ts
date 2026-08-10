import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export interface ClientMemory {
  id: string;
  kind: string;
  summary: string;
  is_sensitive: boolean;
  created_at: string;
}

export function useConversationMemories(conversationId: string | undefined) {
  return useQuery({
    queryKey: ['conversation-memories', conversationId],
    enabled: Boolean(conversationId),
    queryFn: async () => {
      const { data } = await api.get<{ memories: ClientMemory[]; clientId: string }>(
        `/conversations/${conversationId}/memories`,
      );
      return data;
    },
  });
}

export function useDeleteMemory(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (memoryId: string) => {
      await api.delete(`/conversations/${conversationId}/memories/${memoryId}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation-memories', conversationId] });
    },
  });
}
