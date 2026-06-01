import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { MessageBubble } from '@/components/features/MessageBubble';
import { Spinner, ErrorState } from '@/components/ui/States';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { BackIcon, SendIcon, AudioIcon, ProductIcon, TrashIcon } from '@/components/ui/Icons';
import {
  useClearConversation,
  useConversationDetail,
  useDeleteMessages,
  useSendAudioToConversation,
  useSendMessage,
  useSendProductToConversation,
} from '@/hooks/useConversations';
import { useAudios } from '@/hooks/useAudios';
import { useProducts } from '@/hooks/useProducts';
import { joinConversation, leaveConversation, useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone, initials } from '@/utils/formatters';
import type { MessageLog } from '@/types';

export default function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useConversationDetail(id);
  const sendMessage = useSendMessage(id ?? '');
  const sendAudio = useSendAudioToConversation(id ?? '');
  const sendProduct = useSendProductToConversation(id ?? '');
  const deleteMessages = useDeleteMessages(id ?? '');
  const clearConversation = useClearConversation(id ?? '');

  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<'audio' | 'product' | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [confirm, setConfirm] = useState<'selected' | 'all' | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  function enterSelection(messageId: string) {
    setSelectionMode(true);
    setSelectedIds(new Set([messageId]));
  }

  function toggleSelect(messageId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  async function handleDeleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await deleteMessages.mutateAsync(ids);
      toast(`${ids.length} mensagem(ns) apagada(s).`, 'success');
      exitSelection();
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao apagar.'), 'error');
    } finally {
      setConfirm(null);
    }
  }

  async function handleClearAll() {
    try {
      await clearConversation.mutateAsync();
      toast('Histórico da conversa apagado.', 'success');
      exitSelection();
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao limpar histórico.'), 'error');
    } finally {
      setConfirm(null);
    }
  }

  useEffect(() => {
    if (!id) return;
    joinConversation(id);
    return () => leaveConversation(id);
  }, [id]);

  useSocket(
    useMemo(
      () => ({
        'message:new': (...args: unknown[]) => {
          const msg = args[0] as MessageLog | undefined;
          if (msg?.conversation_id === id) {
            void qc.invalidateQueries({ queryKey: ['conversation', id] });
          }
        },
      }),
      [id, qc],
    ),
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages.length]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    try {
      await sendMessage.mutateAsync(value);
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao enviar.'), 'error');
      setText(value);
    }
  }

  if (isLoading) return <Spinner label="Abrindo conversa..." />;
  if (isError || !data) return <ErrorState message="Conversa não encontrada." onRetry={() => void refetch()} />;

  const clientName = data.client?.name ?? data.client?.company_name ?? data.client?.phone ?? 'Cliente';

  return (
    <div className="flex h-full flex-col">
      {selectionMode ? (
        <PageHeader
          title={`${selectedIds.size} selecionada(s)`}
          subtitle="Toque nas mensagens para marcar"
          leading={
            <button onClick={exitSelection} className="tap-scale -ml-1 rounded-full p-1 text-primary" aria-label="Cancelar">
              <BackIcon width={24} height={24} />
            </button>
          }
          action={
            <button
              onClick={() => setConfirm('selected')}
              disabled={selectedIds.size === 0 || deleteMessages.isPending}
              className="tap-scale rounded-full p-2 text-danger disabled:opacity-40"
              aria-label="Apagar selecionadas"
            >
              <TrashIcon width={22} height={22} />
            </button>
          }
        />
      ) : (
        <PageHeader
          title={clientName}
          subtitle={data.client ? formatPhone(data.client.phone) : undefined}
          leading={
            <button onClick={() => navigate('/conversas')} className="tap-scale -ml-1 rounded-full p-1 text-primary md:hidden">
              <BackIcon width={24} height={24} />
            </button>
          }
          action={
            <div className="flex items-center gap-1">
              <button
                onClick={() => setConfirm('all')}
                className="tap-scale rounded-full p-2 text-text-secondary"
                aria-label="Limpar histórico"
                title="Limpar histórico"
              >
                <TrashIcon width={20} height={20} />
              </button>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
                {initials(data.client?.name ?? null, data.client?.phone)}
              </div>
            </div>
          }
        />
      )}

      <div className="no-scrollbar flex-1 space-y-2 overflow-y-auto bg-bg px-3 py-4">
        {data.messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            selectionMode={selectionMode}
            selected={selectedIds.has(m.id)}
            onLongPress={enterSelection}
            onToggleSelect={toggleSelect}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="safe-bottom border-t border-border bg-surface px-3 py-2">
        <div className="mb-2 flex gap-2">
          <QuickAction icon={<AudioIcon width={18} height={18} />} label="Áudio" onClick={() => setSheet('audio')} />
          <QuickAction icon={<ProductIcon width={18} height={18} />} label="Produto" onClick={() => setSheet('product')} />
        </div>
        <form onSubmit={handleSend} className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e);
              }
            }}
            rows={1}
            placeholder="Mensagem..."
            className="no-scrollbar max-h-28 flex-1 resize-none rounded-2xl border border-border bg-bg px-4 py-2.5 text-[15px] outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={!text.trim() || sendMessage.isPending}
            className="tap-scale flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white disabled:opacity-50"
            aria-label="Enviar"
          >
            <SendIcon width={20} height={20} />
          </button>
        </form>
      </div>

      <AudioPickerSheet
        open={sheet === 'audio'}
        onClose={() => setSheet(null)}
        onPick={async (audioId) => {
          setSheet(null);
          try {
            await sendAudio.mutateAsync(audioId);
            toast('Áudio enviado.', 'success');
          } catch (err) {
            toast(getErrorMessage(err), 'error');
          }
        }}
      />
      <ProductPickerSheet
        open={sheet === 'product'}
        onClose={() => setSheet(null)}
        onPick={async (productId) => {
          setSheet(null);
          try {
            await sendProduct.mutateAsync(productId);
            toast('Produto enviado.', 'success');
          } catch (err) {
            toast(getErrorMessage(err), 'error');
          }
        }}
      />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'all' ? 'Limpar histórico' : 'Apagar mensagens'}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">
            {confirm === 'all'
              ? 'Isso vai apagar TODAS as mensagens desta conversa. Essa ação não pode ser desfeita.'
              : `Apagar ${selectedIds.size} mensagem(ns) selecionada(s)? Essa ação não pode ser desfeita.`}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" fullWidth onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              fullWidth
              loading={deleteMessages.isPending || clearConversation.isPending}
              onClick={confirm === 'all' ? handleClearAll : handleDeleteSelected}
            >
              Apagar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="tap-scale flex items-center gap-1.5 rounded-full bg-primary-light px-3 py-1.5 text-xs font-semibold text-primary"
    >
      {icon}
      {label}
    </button>
  );
}

function AudioPickerSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const { data } = useAudios();
  return (
    <Modal open={open} onClose={onClose} title="Enviar áudio">
      <div className="flex flex-col gap-3">
        {(data ?? [])
          .filter((a) => a.is_active)
          .map((a) => (
            <div key={a.id} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold">{a.title}</p>
                <button onClick={() => onPick(a.id)} className="shrink-0 text-sm font-semibold text-primary">
                  Enviar
                </button>
              </div>
              <AudioPlayer src={a.file_url} durationSeconds={a.duration_seconds} />
            </div>
          ))}
        {(data ?? []).length === 0 && <p className="py-6 text-center text-sm text-text-secondary">Nenhum áudio cadastrado.</p>}
      </div>
    </Modal>
  );
}

function ProductPickerSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const { data } = useProducts();
  return (
    <Modal open={open} onClose={onClose} title="Enviar produto">
      <div className="grid grid-cols-2 gap-3">
        {(data ?? [])
          .filter((p) => p.is_available)
          .map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className="tap-scale overflow-hidden rounded-xl border border-border text-left"
            >
              {p.image_urls[0] ? (
                <img src={p.image_urls[0]} alt={p.name} className="aspect-square w-full object-cover" />
              ) : (
                <div className="aspect-square w-full bg-bg" />
              )}
              <p className="truncate p-2 text-xs font-medium">{p.name}</p>
            </button>
          ))}
        {(data ?? []).length === 0 && <p className="col-span-2 py-6 text-center text-sm text-text-secondary">Nenhum produto cadastrado.</p>}
      </div>
    </Modal>
  );
}
