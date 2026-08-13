import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export function personaQueryKey(connectionId?: string) {
  return ['ai-persona', connectionId] as const;
}

/** @deprecated use personaQueryKey(connectionId) */
export const PERSONA_QUERY_KEY = personaQueryKey();

export interface PersonaData {
  prompt: string;
  default: string;
  isDefault: boolean;
  temperature: number;
  maxTokens: number;
}

export function usePersona(connectionId?: string) {
  return useQuery({
    queryKey: personaQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<PersonaData>('/settings/persona', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
  });
}

export function useSetPersona(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prompt: string; temperature: number; maxTokens?: number }) => {
      const { data } = await api.put<PersonaData>('/settings/persona', input, {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
    onSuccess: (data) => qc.setQueryData(personaQueryKey(connectionId), data),
  });
}

export interface PersonaPreviewInput {
  /** Texto do prompt em edição (se ausente, o backend usa o salvo). */
  prompt?: string;
  message: string;
  temperature?: number;
  maxTokens?: number;
  /** 'sales' (padrão) ou 'reminder' (assistente de lembretes). */
  target?: 'sales' | 'reminder';
  history?: { role: 'user' | 'assistant'; content: string }[];
  connectionId?: string;
}

export interface PersonaPreviewResult {
  reply: string | null;
  providerLabel: string | null;
  /** Modelo real que respondeu (ex.: "claude-opus-4-8"). */
  model: string | null;
  detail: string | null;
}

/** Playground: gera uma resposta de exemplo no app, sem enviar WhatsApp. */
export function usePersonaPreview() {
  return useMutation({
    mutationFn: async (input: PersonaPreviewInput) => {
      const { connectionId, ...body } = input;
      const { data } = await api.post<PersonaPreviewResult>('/settings/persona/preview', body, {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
  });
}

// ---------------------------------------------------------------------------
// Persona do assistente de lembretes (secretária do dono)
// ---------------------------------------------------------------------------

export function reminderPersonaQueryKey(connectionId?: string) {
  return ['reminder-persona', connectionId] as const;
}

/** @deprecated use reminderPersonaQueryKey(connectionId) */
export const REMINDER_PERSONA_QUERY_KEY = reminderPersonaQueryKey();

export interface ReminderPersonaData {
  prompt: string;
  default: string;
  isDefault: boolean;
}

export function useReminderPersona(connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: reminderPersonaQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<ReminderPersonaData>('/settings/reminder-persona', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
    enabled,
  });
}

export function useSetReminderPersona(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prompt: string }) => {
      const { data } = await api.put<ReminderPersonaData>('/settings/reminder-persona', input, {
        params: connectionId ? { connectionId } : undefined,
      });
      return data;
    },
    onSuccess: (data) => qc.setQueryData(reminderPersonaQueryKey(connectionId), data),
  });
}

export function secretaryPlaybookQueryKey(connectionId: string) {
  return ['secretary-playbook', connectionId] as const;
}

export interface SecretaryPlaybookData {
  prompt: string;
}

export function useSecretaryPlaybook(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: secretaryPlaybookQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<SecretaryPlaybookData>('/settings/secretary-playbook', {
        params: { connectionId },
      });
      return data;
    },
    enabled: enabled && Boolean(connectionId),
  });
}

export function useSetSecretaryPlaybook(connectionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prompt: string }) => {
      const { data } = await api.put<SecretaryPlaybookData>(
        '/settings/secretary-playbook',
        input,
        { params: { connectionId } },
      );
      return data;
    },
    onSuccess: (data) => qc.setQueryData(secretaryPlaybookQueryKey(connectionId), data),
  });
}

// ---------------------------------------------------------------------------
// Registro de comportamento (config-driven)
// ---------------------------------------------------------------------------

export type BehaviorSettingType = 'text' | 'longtext' | 'number' | 'toggle';

export interface BehaviorSetting {
  key: string;
  label: string;
  description: string;
  type: BehaviorSettingType;
  default: string;
  min?: number;
  max?: number;
  scope: 'sales' | 'reminder' | 'geral';
  value: string;
}

export function behaviorQueryKey(connectionId?: string) {
  return ['behavior-settings', connectionId] as const;
}

/** @deprecated use behaviorQueryKey(connectionId) */
export const BEHAVIOR_QUERY_KEY = behaviorQueryKey();

export function useBehaviorSettings(connectionId?: string, enabled = true) {
  return useQuery({
    queryKey: behaviorQueryKey(connectionId),
    queryFn: async () => {
      const { data } = await api.get<{ settings: BehaviorSetting[] }>('/settings/behavior', {
        params: connectionId ? { connectionId } : undefined,
      });
      return data.settings;
    },
    enabled,
  });
}

export function useSetBehavior(connectionId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string | number | boolean }) => {
      const { data } = await api.put<{ key: string; value: string }>(
        `/settings/behavior/${key}`,
        { value },
        { params: connectionId ? { connectionId } : undefined },
      );
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: behaviorQueryKey(connectionId) }),
  });
}
