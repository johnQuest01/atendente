import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

/**
 * Whitelist do assistente pessoal de lembretes. Um número aqui deixa de ser
 * tratado como cliente: o que ele mandar vira comando de lembrete.
 */

export interface ReminderOwner {
  phone: string;
  label: string | null;
}

export const REMINDER_OWNERS_QUERY_KEY = ['reminder-owners'] as const;

export function useReminderOwners(enabled = true) {
  return useQuery({
    queryKey: REMINDER_OWNERS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ owners: ReminderOwner[] }>('/settings/reminder-owners');
      return data.owners;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useAddReminderOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { phone: string; label?: string }) => {
      const { data } = await api.post<{ owners: ReminderOwner[] }>('/settings/reminder-owners', input);
      return data.owners;
    },
    onSuccess: (owners) => qc.setQueryData(REMINDER_OWNERS_QUERY_KEY, owners),
  });
}

export function useRemoveReminderOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => {
      const { data } = await api.delete<{ owners: ReminderOwner[] }>(
        `/settings/reminder-owners/${phone}`,
      );
      return data.owners;
    },
    onSuccess: (owners) => qc.setQueryData(REMINDER_OWNERS_QUERY_KEY, owners),
  });
}
