import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { ConversationCard } from '@/components/features/ConversationCard';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { ChatIcon } from '@/components/ui/Icons';
import { useConversations } from '@/hooks/useConversations';
import { useSocket } from '@/hooks/useSocket';
import { cn } from '@/utils/cn';
import type { ConversationStatus } from '@/types';

const FILTERS: { label: string; value: ConversationStatus | undefined }[] = [
  { label: 'Abertas', value: 'open' },
  { label: 'Aguardando', value: 'waiting' },
  { label: 'Fechadas', value: 'closed' },
  { label: 'Todas', value: undefined },
];

export default function Conversations() {
  const [filter, setFilter] = useState<ConversationStatus | undefined>('open');
  const { data, isLoading, isError, refetch, isRefetching } = useConversations(filter);
  const qc = useQueryClient();

  // Atualização em tempo real: invalida a lista quando chega evento.
  useSocket(
    useMemo(
      () => ({
        'conversation:updated': () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
        'conversation:new': () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
      }),
      [qc],
    ),
  );

  return (
    <>
      <PageHeader title="Conversas" subtitle={isRefetching ? 'Atualizando...' : 'Atendimentos ao vivo'} />

      <div className="no-scrollbar sticky top-[57px] z-10 flex gap-2 overflow-x-auto border-b border-border bg-surface/90 px-4 py-2.5 backdrop-blur-lg">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={cn(
              'tap-scale shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
              filter === f.value ? 'bg-primary text-white' : 'bg-black/5 text-text-secondary',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <Spinner label="Carregando conversas..." />}
      {isError && <ErrorState message="Erro ao carregar conversas." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<ChatIcon width={40} height={40} />}
          title="Nenhuma conversa aqui"
          description="As conversas com clientes aparecerão nesta lista assim que chegarem."
        />
      )}

      {data && data.length > 0 && (
        <ul className="divide-y divide-border bg-surface">
          {data.map((c) => (
            <li key={c.id}>
              <ConversationCard conversation={c} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
