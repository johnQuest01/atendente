import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';

export const PERSONA_QUERY_KEY = ['ai-persona'] as const;

export interface PersonaData {
  prompt: string;
  default: string;
  isDefault: boolean;
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
    mutationFn: async (prompt: string) => {
      const { data } = await api.put<PersonaData>('/settings/persona', { prompt });
      return data;
    },
    onSuccess: (data) => qc.setQueryData(PERSONA_QUERY_KEY, data),
  });
}
