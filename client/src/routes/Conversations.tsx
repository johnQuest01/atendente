import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { ConversationCard } from '@/components/features/ConversationCard';
import { ListSkeleton, ErrorState, EmptyState } from '@/components/ui/States';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ChatIcon } from '@/components/ui/Icons';
import { useConversations, useDeleteConversation } from '@/hooks/useConversations';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
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
  const deleteConversation = useDeleteConversation();
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);

  async function handleDelete() {
    if (!toDelete) return;
    try {
      await deleteConversation.mutateAsync(toDelete.id);
      toast('Conversa apagada.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao apagar conversa.'), 'error');
    } finally {
      setToDelete(null);
    }
  }

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

      <div className="no-scrollbar glass sticky top-[68px] z-10 flex gap-2 overflow-x-auto border-x-0 border-t-0 border-b border-border/70 px-4 py-2.5">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={cn(
              'tap-scale shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all duration-200',
              filter === f.value
                ? 'bg-primary-gradient text-white shadow-glow'
                : 'bg-black/[0.04] text-text-secondary hover:bg-black/[0.07]',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <ListSkeleton />}
      {isError && <ErrorState message="Erro ao carregar conversas." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<ChatIcon width={40} height={40} />}
          title="Nenhuma conversa aqui"
          description="As conversas com clientes aparecerão nesta lista assim que chegarem."
        />
      )}

      {data && data.length > 0 && (
        <div className="p-3 sm:p-4">
          <p className="px-1 pb-2 text-center text-xs text-text-secondary">
            Dica: segure em uma conversa para apagá-la.
          </p>
          <ul className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-card">
            {data.map((c, i) => (
              <li
                key={c.id}
                className="animate-rise"
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
              >
                <ConversationCard
                  conversation={c}
                  onLongPress={() =>
                    setToDelete({
                      id: c.id,
                      name: c.client_name ?? c.company_name ?? c.client_phone,
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal open={toDelete !== null} onClose={() => setToDelete(null)} title="Apagar conversa">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">
            Apagar a conversa com <strong className="text-text-primary">{toDelete?.name}</strong>? Todas
            as mensagens dela serão removidas. Essa ação não pode ser desfeita.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={() => setToDelete(null)}>
              Cancelar
            </Button>
            <Button variant="danger" fullWidth loading={deleteConversation.isPending} onClick={handleDelete}>
              Apagar
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
