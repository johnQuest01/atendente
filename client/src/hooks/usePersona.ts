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
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface PersonaPreviewResult {
  reply: string | null;
  providerLabel: string | null;
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
