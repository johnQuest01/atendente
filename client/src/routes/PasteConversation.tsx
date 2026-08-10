import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { ChatViewport } from '@/components/layout/ChatViewport';
import { MessageBubble } from '@/components/features/MessageBubble';
import { ConnectionNumberPicker } from '@/components/features/ConnectionNumberPicker';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BackIcon, SendIcon, SettingsIcon, TrashIcon } from '@/components/ui/Icons';
import { cn } from '@/utils/cn';
import { usePasteImport } from '@/hooks/useContactsExport';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone, initials } from '@/utils/formatters';
import type { MessageLog } from '@/types';

interface DraftMsg {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  sent_at: string;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Converte rascunho no mesmo formato que o chat real usa nas bolhas. */
function toMessageLog(m: DraftMsg): MessageLog {
  return {
    id: m.id,
    conversation_id: 'paste-draft',
    direction: m.direction,
    type: 'text',
    content: m.text,
    audio_id: null,
    product_id: null,
    zapi_message_id: null,
    sent_at: m.sent_at,
    delivered_at: m.direction === 'outbound' ? m.sent_at : null,
    read_at: null,
    media_url: null,
    media_mime: null,
    transcription: null,
    origin: m.direction === 'outbound' ? 'human' : 'client',
  };
}

/**
 * Mesma cara do chat de atendimento:
 * header + faixa + bolhas; engrenagem = nome/telefone.
 */
export default function PasteConversation() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const paste = usePasteImport();
  const { data: wa } = useWhatsappConnections();
  const connections = (wa?.connections ?? []).filter((c) => c.isActive !== false);
  const [connectionId, setConnectionId] = useState(
    () => searchParams.get('connectionId') ?? '',
  );
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [text, setText] = useState('');
  /** Último botão usado — o enviar do teclado/ícone segue o mesmo lado. */
  const [lastSender, setLastSender] = useState<'inbound' | 'outbound'>('inbound');
  const [messages, setMessages] = useState<DraftMsg[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fromUrl = searchParams.get('connectionId');
    if (fromUrl) setConnectionId(fromUrl);
  }, [searchParams]);

  useEffect(() => {
    if (!connectionId && connections.length === 1) {
      setConnectionId(connections[0].id);
    }
  }, [connections, connectionId]);

  // Novas bolhas empilham embaixo e a tela acompanha (conversa real).
  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const waLabel =
    connections.find((c) => c.id === connectionId)?.phoneNumber ||
    connections.find((c) => c.id === connectionId)?.label ||
    null;

  function openSettings() {
    setDraftName(name);
    setDraftPhone(phone);
    setSettingsOpen(true);
  }

  function saveSettings() {
    if (!connectionId) {
      toast('Escolha em qual número WhatsApp salvar esta conversa.', 'error');
      return;
    }
    const digits = draftPhone.replace(/\D/g, '');
    if (digits.length > 0 && digits.length < 10) {
      toast('Telefone incompleto. Use DDI+DDD, ex.: 5511915287476.', 'error');
      return;
    }
    setName(draftName.trim());
    setPhone(digits);
    setSettingsOpen(false);
  }

  function addMessage(direction: 'inbound' | 'outbound', value?: string) {
    const content = (value ?? text).trim();
    if (!content) {
      toast('Digite ou cole a mensagem.', 'error');
      return;
    }
    setMessages((prev) => [
      ...prev,
      { id: newId(), direction, text: content, sent_at: new Date().toISOString() },
    ]);
    setText('');
  }

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

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    exitSelection();
  }

  function clearAll() {
    setMessages([]);
    exitSelection();
    setConfirmClear(false);
  }

  function pushAs(direction: 'inbound' | 'outbound') {
    setLastSender(direction);
    addMessage(direction);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    addMessage(lastSender);
  }

  async function handleSave() {
    if (!connectionId) {
      openSettings();
      toast('Escolha o número WhatsApp (instância) onde gravar.', 'error');
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      openSettings();
      toast('Informe o telefone do contato na engrenagem.', 'error');
      return;
    }
    if (messages.length === 0) {
      toast('Adicione pelo menos uma mensagem no chat.', 'error');
      return;
    }
    try {
      const result = await paste.mutateAsync({
        connectionId,
        phone: digits,
        name: name.trim() || null,
        messages: messages.map((m) => ({ direction: m.direction, text: m.text })),
      });
      toast(result.detail, 'success');
      navigate(`/conversas/${result.conversationId}`);
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao salvar conversa.'), 'error');
    }
  }

  const clientName = name.trim() || (phone ? 'Contato' : 'Novo contato');
  const subtitle = [
    phone ? formatPhone(phone) : 'Engrenagem → dados',
    waLabel ? `via ${waLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <ChatViewport label="Colar conversa">
      {/* Topo FIXO — igual conversa real */}
      <div className="z-30 shrink-0 bg-surface">
        {selectionMode ? (
          <PageHeader
            sticky={false}
            title={`${selectedIds.size} selecionada(s)`}
            subtitle="Apaga só desta prévia"
            leading={
              <button
                onClick={exitSelection}
                className="tap-scale -ml-1 rounded-full p-1 text-primary"
                aria-label="Cancelar"
              >
                <BackIcon width={24} height={24} />
              </button>
            }
            action={
              <button
                onClick={deleteSelected}
                disabled={selectedIds.size === 0}
                className="tap-scale rounded-full p-2 text-danger disabled:opacity-40"
                aria-label="Apagar selecionadas"
              >
                <TrashIcon width={22} height={22} />
              </button>
            }
          />
        ) : (
          <PageHeader
            sticky={false}
            title={clientName}
            subtitle={subtitle}
            leading={
              <button
                onClick={() => navigate('/conversas')}
                className="tap-scale -ml-1 rounded-full p-1 text-primary md:hidden"
                aria-label="Voltar"
              >
                <BackIcon width={24} height={24} />
              </button>
            }
            action={
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  disabled={messages.length === 0}
                  className="tap-scale rounded-full p-2 text-text-secondary disabled:opacity-40"
                  aria-label="Limpar prévia"
                  title="Limpar prévia"
                >
                  <TrashIcon width={20} height={20} />
                </button>
                <button
                  type="button"
                  onClick={openSettings}
                  className="tap-scale rounded-full p-2 text-text-secondary"
                  aria-label="Dados do contato"
                  title="Nome e telefone"
                >
                  <SettingsIcon width={20} height={20} />
                </button>
                <button
                  type="button"
                  onClick={openSettings}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary"
                  aria-label="Abrir dados do contato"
                >
                  {initials(name || null, phone || '??')}
                </button>
              </div>
            }
          />
        )}

        {/* Botões de simulação no topo — rodapé fica só com o campo de texto. */}
        {!selectionMode && (
          <div className="space-y-2 border-b border-border bg-surface px-3 py-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => pushAs('inbound')}
                className={cn(
                  'tap-scale flex flex-1 items-center justify-center rounded-full px-3 py-2 text-xs font-bold',
                  lastSender === 'inbound'
                    ? 'bg-surface text-text-primary ring-2 ring-primary'
                    : 'bg-surface text-text-primary ring-1 ring-border',
                )}
              >
                Cliente enviou
              </button>
              <button
                type="button"
                onClick={() => pushAs('outbound')}
                className={cn(
                  'tap-scale flex flex-1 items-center justify-center rounded-full px-3 py-2 text-xs font-bold',
                  lastSender === 'outbound'
                    ? 'bg-primary-gradient text-white shadow-glow'
                    : 'bg-primary-light text-primary',
                )}
              >
                Eu enviei
              </button>
            </div>
            <Button
              fullWidth
              size="sm"
              loading={paste.isPending}
              disabled={messages.length === 0 || paste.isPending}
              onClick={() => void handleSave()}
            >
              Enviar para IA (banco de dados)
            </Button>
          </div>
        )}
      </div>

      {/* ÚNICA área com scroll — bolhas antigas em cima, novas descendo */}
      <div
        ref={scrollRef}
        data-chat-scroll="1"
        className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain bg-bg px-3 py-4"
      >
        {messages.length === 0 && (
          <div className="mx-auto mt-16 max-w-xs text-center text-sm text-text-secondary">
            <p className="mb-1 font-semibold text-text-primary">Como no atendimento</p>
            <p>
              Engrenagem = nome/telefone. Cole o texto e toque em{' '}
              <strong>Cliente enviou</strong> ou <strong>Eu enviei</strong> — as bolhas descem como
              no chat.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={toMessageLog(m)}
            selectionMode={selectionMode}
            selected={selectedIds.has(m.id)}
            onLongPress={enterSelection}
            onToggleSelect={toggleSelect}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Rodapé: só digitação (botões ficam no header). */}
      <div data-chat-composer="1" className="z-30 shrink-0 border-t border-border bg-surface px-3 py-2">
        <form onSubmit={(e) => void handleSend(e)} className="flex items-end gap-2">
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
            placeholder="Cole ou digite a mensagem…"
            className="no-scrollbar max-h-28 flex-1 resize-none rounded-2xl border border-border bg-bg px-4 py-2.5 text-[15px] outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="tap-scale flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white disabled:opacity-50"
            aria-label="Enviar com o último lado escolhido"
            title={lastSender === 'inbound' ? 'Enviar como cliente' : 'Enviar como você'}
          >
            <SendIcon width={20} height={20} />
          </button>
        </form>
      </div>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Dados do contato"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSettingsOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveSettings}>Salvar</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Escolha o WhatsApp (instância) onde gravar. A conversa fica isolada desse número — não
            mistura com outras contas.
          </p>
          <ConnectionNumberPicker
            value={connectionId}
            onChange={setConnectionId}
            label="Salvar no WhatsApp"
            cards={connections.length > 1}
          />
          <Input
            label="Nome do contato"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Ex.: Maria Silva"
          />
          <Input
            label="Telefone do contato (DDI + DDD + número)"
            value={draftPhone}
            onChange={(e) => setDraftPhone(e.target.value)}
            placeholder="5511993304368"
            hint="Só números. Ex.: 5511993304368"
          />
        </div>
      </Modal>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Limpar prévia?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={clearAll}>
              Limpar
            </Button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          Apaga todas as bolhas desta tela. Nada é gravado no banco até você tocar em Salvar.
        </p>
      </Modal>
    </ChatViewport>
  );
}
