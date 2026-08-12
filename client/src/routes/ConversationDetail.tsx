import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { ChatViewport } from '@/components/layout/ChatViewport';
import { MessageBubble } from '@/components/features/MessageBubble';
import { Spinner, ErrorState } from '@/components/ui/States';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import {
  BackIcon,
  SendIcon,
  AudioIcon,
  ProductIcon,
  TrashIcon,
  BlockIcon,
  EditIcon,
  LockIcon,
} from '@/components/ui/Icons';
import {
  useClearConversation,
  useConversationDetail,
  useSetClientAi,
  useDeleteMessages,
  useEditMessage,
  useSendAudioToConversation,
  useSendMessage,
  useSendProductToConversation,
  useUnlockConversation,
  usePatchConversationLock,
  type ConversationDetail,
} from '@/hooks/useConversations';
import { useAudios } from '@/hooks/useAudios';
import { useProducts } from '@/hooks/useProducts';
import { useConversationMemories, useDeleteMemory } from '@/hooks/useMemories';
import { useAddBlocked } from '@/hooks/useBlocked';
import { BlockUnlockModal } from '@/components/features/BlockAccess';
import { useBlockAccess } from '@/store/appStore';
import { joinConversation, leaveConversation, useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone, initials } from '@/utils/formatters';
import type { MessageLog } from '@/types';
import { Input } from '@/components/ui/Input';

export default function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useConversationDetail(id);
  const { data: memoriesData } = useConversationMemories(id);
  const deleteMemory = useDeleteMemory(id ?? '');
  const sendMessage = useSendMessage(id ?? '');
  const sendAudio = useSendAudioToConversation(id ?? '');
  const sendProduct = useSendProductToConversation(id ?? '');
  const deleteMessages = useDeleteMessages(id ?? '');
  const editMessage = useEditMessage(id ?? '');
  const clearConversation = useClearConversation(id ?? '');
  const addBlocked = useAddBlocked();
  const blockToken = useBlockAccess((s) => s.token);
  const unlockChat = useUnlockConversation(id ?? '');
  const patchLock = usePatchConversationLock(id ?? '');

  const setClientAi = useSetClientAi(id ?? '');

  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<'audio' | 'product' | null>(null);
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiPromptDraft, setAiPromptDraft] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [confirm, setConfirm] = useState<'selected' | 'all' | null>(null);
  const [blockUnlockOpen, setBlockUnlockOpen] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [editTarget, setEditTarget] = useState<MessageLog | null>(null);
  const [chatPassword, setChatPassword] = useState('');
  const [protectOpen, setProtectOpen] = useState(false);
  const [unlockRemoveOpen, setUnlockRemoveOpen] = useState(false);
  const [pendingProtect, setPendingProtect] = useState<'block-number' | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const selectedEditableMessage = useMemo(() => {
    if (!data || selectedIds.size !== 1) return null;
    const onlyId = Array.from(selectedIds)[0];
    const msg = data.messages.find((m) => m.id === onlyId);
    if (!msg) return null;
    if (msg.direction !== 'outbound' || msg.type !== 'text' || !msg.zapi_message_id) return null;
    return msg;
  }, [data, selectedIds]);

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
      const result = await deleteMessages.mutateAsync({ ids, forEveryone: true });
      toast(result.detail ?? `${result.deleted} mensagem(ns) apagada(s).`, 'success');
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
      toast('Histórico apagado só no painel (o WhatsApp do cliente não muda).', 'success');
      exitSelection();
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao limpar histórico.'), 'error');
    } finally {
      setConfirm(null);
    }
  }

  function openEditSelected() {
    if (!selectedEditableMessage) return;
    setEditTarget(selectedEditableMessage);
    setEditDraft(selectedEditableMessage.content ?? '');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    const next = editDraft.trim();
    if (!next) {
      toast('Digite o novo texto.', 'error');
      return;
    }
    try {
      await editMessage.mutateAsync({ messageId: editTarget.id, text: next });
      toast('Mensagem corrigida no WhatsApp e no painel.', 'success');
      setEditTarget(null);
      exitSelection();
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao corrigir no WhatsApp.'), 'error');
    }
  }

  async function performBlock() {
    const phone = data?.client?.phone;
    if (!phone) return;
    try {
      await addBlocked.mutateAsync({ phone, label: data?.client?.name ?? null });
      toast('Número bloqueado. Novas mensagens dele serão ignoradas.', 'success');
      navigate('/conversas');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao bloquear número.'), 'error');
    }
  }

  /** Bloquear número: mesma lógica do cadeado flutuante (senha → token). */
  function requestBlockNumber() {
    setProtectOpen(false);
    setConfirm(null);
    if (blockToken) {
      void performBlock();
    } else {
      setPendingProtect('block-number');
      setBlockUnlockOpen(true);
    }
  }

  async function handleLockChat() {
    setProtectOpen(false);
    try {
      await patchLock.mutateAsync({ locked: true });
      toast('Conversa trancada no painel. A IA continua atendendo.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao trancar.'), 'error');
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
          if (!msg || msg.conversation_id !== id) return;
          // Atualiza na hora (sem esperar o refetch) — bolha aparece ao vivo.
          qc.setQueryData<ConversationDetail>(['conversation', id], (old) => {
            if (!old) return old;
            if (old.messages.some((m) => m.id === msg.id)) return old;
            return { ...old, messages: [...old.messages, msg] };
          });
          void qc.invalidateQueries({ queryKey: ['conversation', id] });
          void qc.invalidateQueries({ queryKey: ['conversations'] });
        },
        'conversation:updated': () => {
          void qc.invalidateQueries({ queryKey: ['conversation', id] });
          void qc.invalidateQueries({ queryKey: ['conversations'] });
        },
        'blocklist:updated': () => {
          // Cadeado flutuante ligou/desligou — senha/preview sem F5.
          void qc.invalidateQueries({ queryKey: ['conversation', id] });
          void qc.invalidateQueries({ queryKey: ['conversations'] });
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

  if (isLoading) {
    return (
      <ChatViewport>
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Abrindo conversa..." />
        </div>
      </ChatViewport>
    );
  }
  if (isError || !data) {
    return (
      <ChatViewport>
        <div className="flex flex-1 flex-col">
          <ErrorState message="Conversa não encontrada." onRetry={() => void refetch()} />
        </div>
      </ChatViewport>
    );
  }

  const clientName = data.client?.name ?? data.client?.company_name ?? data.client?.phone ?? 'Cliente';

  async function handleUnlockChat() {
    if (!chatPassword.trim()) return;
    try {
      await unlockChat.mutateAsync(chatPassword.trim());
      setChatPassword('');
      toast('Conversa desbloqueada.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Senha incorreta.'), 'error');
    }
  }

  async function handleRemoveLock() {
    if (!chatPassword.trim()) return;
    try {
      await patchLock.mutateAsync({ locked: false, password: chatPassword.trim() });
      setChatPassword('');
      setUnlockRemoveOpen(false);
      toast('Cadeado removido desta conversa.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Senha incorreta.'), 'error');
    }
  }

  // Gate: conversa trancada sem token — só o popup de senha.
  if (data.locked) {
    return (
      <ChatViewport>
        <div className="z-30 shrink-0 bg-surface">
          <PageHeader
            sticky={false}
            title={clientName}
            subtitle="Conversa protegida"
            leading={
              <button onClick={() => navigate('/conversas')} className="tap-scale -ml-1 rounded-full p-1 text-primary">
                <BackIcon width={24} height={24} />
              </button>
            }
          />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-primary">
            <LockIcon width={28} height={28} />
          </div>
          <p className="text-center text-sm text-text-secondary">
            {data.locked_by_blocklist
              ? 'Este número está no cadeado. Digite a senha para ver o histórico.'
              : 'Esta conversa está com cadeado. Digite a senha para ver as mensagens.'}
            <br />
            <span className="text-xs">
              {data.locked_by_blocklist
                ? 'Com o bloqueio ligado, novas mensagens são ignoradas e a IA não responde.'
                : 'A IA continua atendendo normalmente.'}
            </span>
          </p>
          <div className="w-full max-w-sm">
            <Input
              label="Senha"
              type="password"
              autoComplete="off"
              autoFocus
              value={chatPassword}
              onChange={(e) => setChatPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleUnlockChat();
                }
              }}
            />
            <Button
              className="mt-3"
              fullWidth
              loading={unlockChat.isPending}
              disabled={!chatPassword.trim()}
              onClick={() => void handleUnlockChat()}
            >
              Desbloquear
            </Button>
          </div>
        </div>
      </ChatViewport>
    );
  }

  return (
    <ChatViewport>
      {/* Topo FIXO: nome + IA/instruções — fora de qualquer scroll. */}
      <div className="z-30 shrink-0 bg-surface">
        {selectionMode ? (
          <PageHeader
            sticky={false}
            title={`${selectedIds.size} selecionada(s)`}
            subtitle="Lixeira = apaga no WhatsApp · lápis = corrigir"
            leading={
              <button onClick={exitSelection} className="tap-scale -ml-1 rounded-full p-1 text-primary" aria-label="Cancelar">
                <BackIcon width={24} height={24} />
              </button>
            }
            action={
              <div className="flex items-center gap-1">
                {selectedEditableMessage && (
                  <button
                    onClick={openEditSelected}
                    className="tap-scale rounded-full p-2 text-primary"
                    aria-label="Corrigir mensagem"
                    title="Corrigir no WhatsApp"
                  >
                    <EditIcon width={22} height={22} />
                  </button>
                )}
                <button
                  onClick={() => setConfirm('selected')}
                  disabled={selectedIds.size === 0 || deleteMessages.isPending}
                  className="tap-scale rounded-full p-2 text-danger disabled:opacity-40"
                  aria-label="Apagar para todos"
                  title="Apagar no WhatsApp (para todos)"
                >
                  <TrashIcon width={22} height={22} />
                </button>
              </div>
            }
          />
        ) : (
          <PageHeader
            sticky={false}
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
                  onClick={() => setProtectOpen(true)}
                  className="tap-scale rounded-full p-2 text-text-secondary"
                  aria-label="Proteger ou bloquear"
                  title="Trancar conversa ou bloquear número"
                >
                  <BlockIcon width={20} height={20} />
                </button>
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

        {!selectionMode && data.client && (
          <div className="border-b border-border bg-surface px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">IA neste contato</span>
              <Toggle
                checked={data.client.ai_enabled !== false}
                disabled={setClientAi.isPending}
                onChange={(next) =>
                  setClientAi.mutate(
                    { ai_enabled: next },
                    {
                      onSuccess: () =>
                        toast(
                          next
                            ? 'IA reativada para este contato.'
                            : 'IA desligada aqui — as mensagens chegam, mas quem responde é você.',
                          'success',
                        ),
                      onError: (err) => toast(getErrorMessage(err), 'error'),
                    },
                  )
                }
                label="Ligar ou desligar a IA para este contato"
              />
              <button
                onClick={() => {
                  setAiPromptDraft(data.client?.ai_prompt ?? '');
                  setAiPromptOpen(true);
                }}
                className="ml-auto rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-secondary transition hover:text-text-primary"
              >
                {data.client.ai_prompt ? 'Instruções ✓' : 'Instruções'}
              </button>
            </div>
            {/* Áudio/Produto no topo — o rodapé fica só com o campo de texto. */}
            <div className="mt-2 flex gap-2">
              <QuickAction
                icon={<AudioIcon width={18} height={18} />}
                label="Áudio"
                onClick={() => setSheet('audio')}
              />
              <QuickAction
                icon={<ProductIcon width={18} height={18} />}
                label="Produto"
                onClick={() => setSheet('product')}
              />
            </div>
          </div>
        )}
      </div>

      {/* ÚNICA área com scroll — header e footer ficam fora. */}
      <div
        data-chat-scroll="1"
        className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain bg-bg px-3 py-4"
      >
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
        {/* Memórias no fim do scroll (não competem com o topo fixo). */}
        {!selectionMode && (memoriesData?.memories.length ?? 0) > 0 && (
          <div className="space-y-1.5 rounded-xl border border-border bg-surface p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Memória (LGPD — apague se precisar)
            </p>
            {memoriesData!.memories.slice(0, 5).map((m) => (
              <div
                key={m.id}
                className="flex items-start justify-between gap-2 rounded-lg bg-bg px-2 py-1.5 text-xs"
              >
                <p className="min-w-0 text-text-secondary">
                  <span className="font-semibold text-text-primary">{m.kind}</span>
                  {m.is_sensitive ? ' · sensível' : ''}: {m.summary}
                </p>
                <button
                  className="shrink-0 font-semibold text-danger"
                  disabled={deleteMemory.isPending}
                  onClick={() =>
                    deleteMemory.mutate(m.id, {
                      onSuccess: () => toast('Memória apagada.', 'success'),
                      onError: (err) => toast(getErrorMessage(err), 'error'),
                    })
                  }
                >
                  Apagar
                </button>
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Rodapé FIXO: só digitação (Áudio/Produto ficam no header). */}
      <div data-chat-composer="1" className="z-30 shrink-0 border-t border-border bg-surface px-3 py-2">
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

      <Modal
        open={aiPromptOpen}
        onClose={() => setAiPromptOpen(false)}
        title={`Instruções da IA — ${clientName}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAiPromptOpen(false)} disabled={setClientAi.isPending}>
              Cancelar
            </Button>
            <Button
              loading={setClientAi.isPending}
              onClick={() =>
                setClientAi.mutate(
                  { ai_prompt: aiPromptDraft.trim() },
                  {
                    onSuccess: () => {
                      setAiPromptOpen(false);
                      toast(
                        aiPromptDraft.trim()
                          ? 'Instruções salvas para este contato.'
                          : 'Instruções removidas — volta a valer só a personalidade geral.',
                        'success',
                      );
                    },
                    onError: (err) => toast(getErrorMessage(err), 'error'),
                  },
                )
              }
            >
              Salvar
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">
            Valem só para <strong>{clientName}</strong> e têm prioridade sobre a personalidade geral
            da IA quando as duas discordarem. Deixe vazio para remover.
          </p>
          <textarea
            value={aiPromptDraft}
            onChange={(e) => setAiPromptDraft(e.target.value)}
            rows={6}
            maxLength={2000}
            placeholder={'Ex.: cliente antigo, tratar por "seu João". Só trabalha com pagamento a prazo — nunca oferecer PIX à vista.'}
            className="no-scrollbar w-full resize-none rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <span className="self-end text-[10px] text-text-secondary">{aiPromptDraft.length}/2000</span>
        </div>
      </Modal>

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
        onPick={async (productId, withPrice) => {
          setSheet(null);
          try {
            await sendProduct.mutateAsync({ productId, withPrice });
            toast(withPrice ? 'Produto enviado.' : 'Produto enviado sem preço.', 'success');
          } catch (err) {
            toast(getErrorMessage(err), 'error');
          }
        }}
      />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'all' ? 'Limpar histórico do painel' : 'Apagar no WhatsApp'}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">
            {confirm === 'all'
              ? 'Apaga o histórico só neste painel. As mensagens continuam no WhatsApp do cliente.'
              : `Apagar ${selectedIds.size} mensagem(ns) para TODOS no WhatsApp e também neste painel? (mensagens antigas ou sem ID podem falhar no WhatsApp)`}
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
              {confirm === 'all' ? 'Limpar painel' : 'Apagar para todos'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={protectOpen} onClose={() => setProtectOpen(false)} title="Proteger conversa">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Escolha o que fazer. A IA não é afetada pelo cadeado do painel.
          </p>
          {data.conversation.is_locked ? (
            data.locked_by_blocklist ? (
              <p className="rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text-secondary">
                Número bloqueado pelo cadeado flutuante. Para liberar de vez, desative lá. Senha libera
                só a visualização agora.
              </p>
            ) : (
              <Button
                variant="secondary"
                fullWidth
                onClick={() => {
                  setProtectOpen(false);
                  setChatPassword('');
                  setUnlockRemoveOpen(true);
                }}
              >
                Remover cadeado desta conversa
              </Button>
            )
          ) : (
            <Button fullWidth loading={patchLock.isPending} onClick={() => void handleLockChat()}>
              Trancar conversa no painel
            </Button>
          )}
          <Button variant="danger" fullWidth onClick={requestBlockNumber}>
            Bloquear número (IA ignora)
          </Button>
          <Button variant="secondary" fullWidth onClick={() => setProtectOpen(false)}>
            Cancelar
          </Button>
        </div>
      </Modal>

      <Modal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Corrigir mensagem"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditTarget(null)} disabled={editMessage.isPending}>
              Cancelar
            </Button>
            <Button loading={editMessage.isPending} onClick={() => void handleSaveEdit()}>
              Salvar correção
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">
            Altera o texto no WhatsApp do cliente e neste painel. Só funciona em mensagens suas
            enviadas há menos de ~7 dias.
          </p>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            rows={5}
            maxLength={4096}
            className="no-scrollbar w-full resize-none rounded-xl border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </div>
      </Modal>

      <Modal
        open={unlockRemoveOpen}
        onClose={() => setUnlockRemoveOpen(false)}
        title="Remover cadeado"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUnlockRemoveOpen(false)}>
              Cancelar
            </Button>
            <Button loading={patchLock.isPending} onClick={() => void handleRemoveLock()}>
              Remover
            </Button>
          </div>
        }
      >
        <Input
          label="Senha do cadeado"
          type="password"
          autoComplete="off"
          value={chatPassword}
          onChange={(e) => setChatPassword(e.target.value)}
        />
      </Modal>

      <BlockUnlockModal
        open={blockUnlockOpen}
        onClose={() => {
          setBlockUnlockOpen(false);
          setPendingProtect(null);
        }}
        onUnlocked={() => {
          setBlockUnlockOpen(false);
          if (pendingProtect === 'block-number') {
            setPendingProtect(null);
            void performBlock();
          }
        }}
      />
    </ChatViewport>
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

function ProductPickerSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string, withPrice: boolean) => void;
}) {
  const { data } = useProducts();
  const [withPrice, setWithPrice] = useState(true);
  return (
    <Modal open={open} onClose={onClose} title="Enviar produto">
      <label className="mb-3 flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-bg px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Incluir preço na legenda</p>
          <p className="text-xs text-text-secondary">
            Desligado: manda foto + nome + mínimo; o valor só aparece se o cliente perguntar.
          </p>
        </div>
        <Toggle checked={withPrice} onChange={setWithPrice} label="Incluir preço na legenda" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        {(data ?? [])
          .filter((p) => p.is_available)
          .map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id, withPrice)}
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
        {(data ?? []).length === 0 && (
          <p className="col-span-2 py-6 text-center text-sm text-text-secondary">Nenhum produto cadastrado.</p>
        )}
      </div>
    </Modal>
  );
}
