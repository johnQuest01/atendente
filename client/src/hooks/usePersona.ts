import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export const PERSONA_QUERY_KEY = ['ai-persona'] as const;

export interface PersonaData {
  prompt: string;
  default: string;
  isDefault: boolean;
  temperature: number;
  maxTokens: number;
}

export function usePersona() {
  return useQuery({
    queryKey: PERSONA_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<PersonaData>('/settings/persona');
      return data;
    },
  });
}

export function useSetPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prompt: string; temperature: number; maxTokens?: number }) => {
      const { data } = await api.put<PersonaData>('/settings/persona', input);
      return data;
    },
    onSuccess: (data) => qc.setQueryData(PERSONA_QUERY_KEY, data),
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
      const { data } = await api.post<PersonaPreviewResult>('/settings/persona/preview', input);
      return data;
    },
  });
}

// ---------------------------------------------------------------------------
// Persona do assistente de lembretes (secretária do dono)
// ---------------------------------------------------------------------------

export const REMINDER_PERSONA_QUERY_KEY = ['reminder-persona'] as const;

export interface ReminderPersonaData {
  prompt: string;
  default: string;
  isDefault: boolean;
}

export function useReminderPersona(enabled = true) {
  return useQuery({
    queryKey: REMINDER_PERSONA_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<ReminderPersonaData>('/settings/reminder-persona');
      return data;
    },
    enabled,
  });
}

export function useSetReminderPersona() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { prompt: string }) => {
      const { data } = await api.put<ReminderPersonaData>('/settings/reminder-persona', input);
      return data;
    },
    onSuccess: (data) => qc.setQueryData(REMINDER_PERSONA_QUERY_KEY, data),
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

export const BEHAVIOR_QUERY_KEY = ['behavior-settings'] as const;

export function useBehaviorSettings(enabled = true) {
  return useQuery({
    queryKey: BEHAVIOR_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ settings: BehaviorSetting[] }>('/settings/behavior');
      return data.settings;
    },
    enabled,
  });
}

export function useSetBehavior() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string | number | boolean }) => {
      const { data } = await api.put<{ key: string; value: string }>(
        `/settings/behavior/${key}`,
        { value },
      );
      return data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: BEHAVIOR_QUERY_KEY }),
  });
}
