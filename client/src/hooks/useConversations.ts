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

/** `connectionId` definido = só aquele número; null/omitido = todos. */
export function useConversations(
  status?: ConversationStatus,
  connectionId?: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['conversations', status ?? 'all', connectionId ?? 'all'],
    enabled: options?.enabled !== false,
    queryFn: async () => {
      const { data } = await api.get<{ conversations: ConversationListItem[] }>('/conversations', {
        params: {
          ...(status ? { status } : {}),
          ...(connectionId ? { connectionId } : {}),
        },
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
    // Rede de segurança: se o socket falhar, o chat ainda atualiza sozinho.
    refetchInterval: id ? 4_000 : false,
    refetchIntervalInBackground: false,
  });
}

/** Liga/desliga a IA para o contato desta conversa e edita o prompt dele. */
export function useSetClientAi(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { ai_enabled?: boolean; ai_prompt?: string }) => {
      const { data } = await api.patch<{ client: Client }>(
        `/conversations/${conversationId}/client`,
        patch,
      );
      return data.client;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
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
    mutationFn: async (input: string | { productId: string; withPrice?: boolean }) => {
      const productId = typeof input === 'string' ? input : input.productId;
      const withPrice = typeof input === 'string' ? true : (input.withPrice ?? true);
      const { data } = await api.post<{ message: MessageLog }>(
        `/conversations/${conversationId}/product`,
        { product_id: productId, with_price: withPrice },
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
    mutationFn: async (input: string[] | { ids: string[]; forEveryone?: boolean }) => {
      const ids = Array.isArray(input) ? input : input.ids;
      const forEveryone = Array.isArray(input) ? true : (input.forEveryone ?? true);
      const { data } = await api.post<{
        deleted: number;
        whatsappOk?: number;
        whatsappFailed?: number;
        detail?: string;
      }>(`/conversations/${conversationId}/messages/delete`, { ids, forEveryone });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

/** Corrige texto enviado (WhatsApp + painel). */
export function useEditMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ messageId, text }: { messageId: string; text: string }) => {
      const { data } = await api.patch<{ message: MessageLog }>(
        `/conversations/${conversationId}/messages/${messageId}`,
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
