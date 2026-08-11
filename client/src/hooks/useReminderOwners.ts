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

export function reminderOwnersQueryKey(connectionId?: string) {
  return ['reminder-owners', connectionId] as const;
}

/** @deprecated use reminderOwnersQueryKey(connectionId) */
export const REMINDER_OWNERS_QUERY_KEY = reminderOwnersQueryKey();

export function useReminderOwners(connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: reminderOwnersQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<{ owners: ReminderOwner[] }>('/settings/reminder-owners', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data.owners;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useAddReminderOwner(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { phone: string; label?: string }) => {
      const { data } = await api.post<{ owners: ReminderOwner[] }>(
        '/settings/reminder-owners',
        input,
        { params: connectionId ? { connectionId } : undefined },
      );
      return data.owners;
    },
    onSuccess: (owners) => qc.setQueryData(reminderOwnersQueryKey(connectionId), owners),
  });
}

export function useRemoveReminderOwner(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => {
      const { data } = await api.delete<{ owners: ReminderOwner[] }>(
        `/settings/reminder-owners/${phone}`,
        { params: connectionId ? { connectionId } : undefined },
      );
      return data.owners;
    },
    onSuccess: (owners) => qc.setQueryData(reminderOwnersQueryKey(connectionId), owners),
  });
}

// ---------------------------------------------------------------------------
// Varredura de conversas (recuperar compromissos) — só o liga/desliga
// ---------------------------------------------------------------------------

export function memoryScanQueryKey(connectionId?: string) {
  return ['memory-scan', connectionId] as const;
}

/** @deprecated use memoryScanQueryKey(connectionId) */
export const MEMORY_SCAN_QUERY_KEY = memoryScanQueryKey();

export function useMemoryScan(connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: memoryScanQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<{ enabled: boolean }>('/settings/memory-scan', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data.enabled;
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useSetMemoryScan(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      const { data } = await api.put<{ enabled: boolean }>(
        '/settings/memory-scan',
        { enabled: nextEnabled },
        { params: connectionId ? { connectionId } : undefined },
      );
      return data.enabled;
    },
    onSuccess: (value) => qc.setQueryData(memoryScanQueryKey(connectionId), value),
  });
}

// ---------------------------------------------------------------------------
// Alavancas Secretária + Agente
// ---------------------------------------------------------------------------

export interface OwnerModes {
  secretary: boolean;
  agent: boolean;
  webSearch: boolean;
  webSearchConfigured: boolean;
}

export function ownerModesQueryKey(connectionId?: string) {
  return ['owner-modes', connectionId] as const;
}

export function useOwnerModes(connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: ownerModesQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<OwnerModes>('/settings/owner-modes', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
    enabled: Boolean(connectionId) && enabled,
    staleTime: 15_000,
  });
}

export function useSetOwnerModes(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Pick<OwnerModes, 'secretary' | 'agent' | 'webSearch'>>) => {
      const { data } = await api.put<OwnerModes>(
        '/settings/owner-modes',
        patch,
        { params: connectionId ? { connectionId } : undefined },
      );
      return data;
    },
    onSuccess: (value) => qc.setQueryData(ownerModesQueryKey(connectionId), value),
  });
}
