import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';

export interface ServiceCheck {
  ok: boolean;
  detail: string;
  /** Quem está realmente atendendo agora (ex.: "Meta Cloud", "Groq", "Neon"). */
  provider?: string | null;
  /** Tempo da checagem em ms. */
  latencyMs?: number;
  /** Serviço opcional: falha aqui não derruba o sistema. */
  optional?: boolean;
}

export interface SystemStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  whatsappProvider: 'zapi' | 'evolution' | 'metacloud';
  /** Provedor de IA ativo no momento (ex.: "Claude"), ou "nenhum". */
  aiProvider: string;
  storage: 'remote' | 'local';
  services: {
    database: ServiceCheck;
    ai: ServiceCheck;
    whatsapp: ServiceCheck;
    transcription: ServiceCheck;
    storage: ServiceCheck;
  };
}

export const SYSTEM_STATUS_QUERY_KEY = ['system-status'] as const;

/**
 * Status REAL das integrações. Sempre pede `force=1` (o servidor tem cache curto
 * de ~10s, então não há risco de martelar as APIs externas).
 */
export function useSystemStatus() {
  return useQuery({
    queryKey: SYSTEM_STATUS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get<SystemStatus>('/settings/status?force=1');
      return data;
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
