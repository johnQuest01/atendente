import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Audio } from '@/types';

export function useAudios() {
  return useQuery({
    queryKey: ['audios'],
    queryFn: async () => {
      const { data } = await api.get<{ audios: Audio[] }>('/audios');
      return data.audios;
    },
  });
}

export function useUploadAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (formData: FormData) => {
      const { data } = await api.post<{ audio: Audio }>('/audios', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data.audio;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audios'] }),
  });
}

export function useUpdateAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Audio> }) => {
      const { data } = await api.patch<{ audio: Audio }>(`/audios/${id}`, patch);
      return data.audio;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audios'] }),
  });
}

export function useDeleteAudio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/audios/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audios'] }),
  });
}
