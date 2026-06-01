import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type {
  Client,
  Conversation,
  ConversationListItem,
  ConversationStatus,
  MessageLog,
} from '@/types';

export interface ConversationDetail {
  conversation: Conversation;
  client: Client | null;
  messages: MessageLog[];
}

export function useConversations(status?: ConversationStatus) {
  return useQuery({
    queryKey: ['conversations', status ?? 'all'],
    queryFn: async () => {
      const { data } = await api.get<{ conversations: ConversationListItem[] }>('/conversations', {
        params: status ? { status } : undefined,
      });
      return data.conversations;
    },
    refetchOnWindowFocus: true,
  });
}

export function useConversationDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['conversation', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data } = await api.get<ConversationDetail>(`/conversations/${id}`);
      return data;
    },
  });
}

export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const { data } = await api.post<{ message: MessageLog }>(
        `/conversations/${conversationId}/messages`,
        { text },
      );
      return data.message;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useSendAudioToConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (audioId: string) => {
      const { data } = await api.post<{ message: MessageLog }>(
        `/conversations/${conversationId}/audio`,
        { audio_id: audioId },
      );
      return data.message;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });
}

export function useSendProductToConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (productId: string) => {
      const { data } = await api.post<{ message: MessageLog }>(
        `/conversations/${conversationId}/product`,
        { product_id: productId },
      );
      return data.message;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });
}

export function useDeleteMessages(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post<{ deleted: number }>(
        `/conversations/${conversationId}/messages/delete`,
        { ids },
      );
      return data.deleted;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useClearConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.delete<{ deleted: number }>(
        `/conversations/${conversationId}/messages`,
      );
      return data.deleted;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/conversations/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

export function useUpdateConversationStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ConversationStatus }) => {
      const { data } = await api.patch<{ conversation: Conversation }>(
        `/conversations/${id}/status`,
        { status },
      );
      return data.conversation;
    },
    onSuccess: (conversation) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation', conversation.id] });
    },
  });
}
