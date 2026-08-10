import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { ConversationCard } from '@/components/features/ConversationCard';
import { ListSkeleton, ErrorState, EmptyState } from '@/components/ui/States';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ChatIcon } from '@/components/ui/Icons';
import { useConversations, useDeleteConversation } from '@/hooks/useConversations';
import { useExportContactsVcf } from '@/hooks/useContactsExport';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone } from '@/utils/formatters';
import { cn } from '@/utils/cn';
import type { ConversationStatus } from '@/types';

const FILTERS: { label: string; value: ConversationStatus | undefined }[] = [
  { label: 'Abertas', value: 'open' },
  { label: 'Aguardando', value: 'waiting' },
  { label: 'Fechadas', value: 'closed' },
  { label: 'Todas', value: undefined },
];

const CONN_STORAGE_KEY = 'conversations.selectedConnectionId';

function loadStoredConnectionId(): string | null {
  try {
    return sessionStorage.getItem(CONN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeConnectionId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(CONN_STORAGE_KEY, id);
    else sessionStorage.removeItem(CONN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export default function Conversations() {
  const { data: waData, isLoading: waLoading } = useWhatsappConnections();
  const connections = useMemo(
    () => (waData?.connections ?? []).filter((c) => c.isActive !== false),
    [waData?.connections],
  );
  const multiNumber = connections.length > 1;

  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(() =>
    loadStoredConnectionId(),
  );
  const [pickingNumber, setPickingNumber] = useState(false);

  // Com 2+ números: exige escolha antes da lista. Com 0–1: entra direto.
  useEffect(() => {
    if (waLoading) return;
    if (connections.length <= 1) {
      const only = connections[0]?.id ?? null;
      setSelectedConnectionId(only);
      storeConnectionId(only);
      setPickingNumber(false);
      return;
    }
    const stored = loadStoredConnectionId();
    const valid = stored && connections.some((c) => c.id === stored);
    if (!valid) {
      setSelectedConnectionId(null);
      storeConnectionId(null);
      setPickingNumber(true);
    } else {
      setSelectedConnectionId(stored);
      setPickingNumber(false);
    }
  }, [waLoading, connections]);

  const [filter, setFilter] = useState<ConversationStatus | undefined>(undefined);
  const listReady = !waLoading && !pickingNumber;
  const { data, isLoading, isError, refetch, isRefetching } = useConversations(
    filter,
    selectedConnectionId,
    { enabled: listReady },
  );
  const qc = useQueryClient();
  const deleteConversation = useDeleteConversation();
  const exportVcf = useExportContactsVcf();
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);

  const selectedConn = connections.find((c) => c.id === selectedConnectionId) ?? null;

  function chooseConnection(id: string) {
    setSelectedConnectionId(id);
    storeConnectionId(id);
    setPickingNumber(false);
  }

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

  useSocket(
    useMemo(
      () => ({
        'conversation:updated': () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
        'conversation:new': () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
        'message:new': () => void qc.invalidateQueries({ queryKey: ['conversations'] }),
      }),
      [qc],
    ),
  );

  if (waLoading || (multiNumber && pickingNumber)) {
    return (
      <>
        <PageHeader title="Conversas" subtitle="Escolha o número do atendimento" />
        {waLoading ? (
          <ListSkeleton />
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-text-secondary">
              Você tem mais de um WhatsApp. Qual número quer ver as conversas?
            </p>
            {connections.map((c) => {
              const phone = c.phoneNumber?.replace(/\D/g, '') ?? '';
              const phoneLabel = phone.length >= 10 ? formatPhone(phone) : phone || 'Número não detectado';
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => chooseConnection(c.id)}
                  className="tap-scale rounded-2xl border border-border bg-surface px-4 py-4 text-left shadow-card transition hover:border-primary/40"
                >
                  <p className="text-base font-bold text-text-primary">
                    Exibir chat do {phone || c.label}
                  </p>
                  <p className="mt-0.5 text-sm text-text-secondary">
                    {c.label}
                    {phone ? ` · ${phoneLabel}` : ''}
                    {c.provider === 'zapi' ? ' · Z-API' : ''}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Conversas"
        subtitle={
          isRefetching
            ? 'Atualizando...'
            : selectedConn
              ? `Número: ${selectedConn.phoneNumber || selectedConn.label}`
              : 'Atendimentos ao vivo'
        }
        action={
          multiNumber ? (
            <button
              type="button"
              onClick={() => setPickingNumber(true)}
              className="tap-scale shrink-0 rounded-full bg-primary-light px-3 py-1.5 text-xs font-bold text-primary"
            >
              Trocar nº
            </button>
          ) : undefined
        }
      />

      <div className="sticky top-[68px] z-10 border-b border-border/70 bg-surface/95 px-3 py-2 backdrop-blur-md">
        <div className="mb-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={exportVcf.isPending || !selectedConnectionId}
            onClick={() => {
              if (!selectedConnectionId) {
                toast('Escolha o número WhatsApp antes de baixar a agenda.', 'error');
                setPickingNumber(true);
                return;
              }
              void exportVcf
                .mutateAsync(selectedConnectionId)
                .then((meta) => {
                  const n = meta.count ?? 0;
                  const skip = meta.skipped ?? 0;
                  toast(
                    n === 0
                      ? 'Nenhum número válido (55+DDD) neste WhatsApp.'
                      : `${n} contato(s) deste número${skip ? ` · ${skip} ignorado(s)` : ''}.`,
                    n === 0 ? 'error' : 'success',
                  );
                })
                .catch((err) => toast(getErrorMessage(err, 'Falha ao baixar agenda.'), 'error'));
            }}
            className="tap-scale flex h-10 items-center justify-center rounded-xl bg-primary-light text-sm font-bold text-primary disabled:opacity-50"
          >
            {exportVcf.isPending ? 'Baixando…' : 'Agenda'}
          </button>
          <Link
            to={
              selectedConnectionId
                ? `/colar-conversa?connectionId=${selectedConnectionId}`
                : '/colar-conversa'
            }
            className="tap-scale flex h-10 items-center justify-center rounded-xl bg-primary-gradient text-sm font-bold text-white shadow-glow"
          >
            Colar conversa
          </Link>
        </div>
        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-0.5">
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
      </div>

      {isLoading && <ListSkeleton />}
      {isError && <ErrorState message="Erro ao carregar conversas." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<ChatIcon width={40} height={40} />}
          title="Nenhuma conversa neste número"
          description="As conversas deste WhatsApp aparecerão aqui assim que chegarem."
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
