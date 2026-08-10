import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, TextArea, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { Modal } from '@/components/ui/Modal';
import { ConnectionNumberPicker } from '@/components/features/ConnectionNumberPicker';
import { useAudios } from '@/hooks/useAudios';
import { useProducts } from '@/hooks/useProducts';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import {
  useBroadcasts,
  useCancelBroadcast,
  useCreateBroadcast,
  type Broadcast,
} from '@/hooks/useBroadcasts';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone } from '@/utils/formatters';

const STATUS_TONE: Record<Broadcast['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  scheduled: 'warning',
  running: 'success',
  paused: 'warning',
  done: 'neutral',
  cancelled: 'danger',
};

export default function Broadcasts() {
  const { data, isLoading, isError, refetch } = useBroadcasts();
  const create = useCreateBroadcast();
  const cancel = useCancelBroadcast();
  const { data: audios } = useAudios();
  const { data: products } = useProducts();
  const { data: waData } = useWhatsappConnections();
  const connections = waData?.connections ?? [];
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [contentType, setContentType] = useState<'text' | 'audio' | 'product'>('text');
  const [body, setBody] = useState('');
  const [contentRef, setContentRef] = useState('');
  const [withPrice, setWithPrice] = useState(true);
  const [dailyCap, setDailyCap] = useState('40');
  const [connectionId, setConnectionId] = useState('');

  function phoneLabel(connId: string | null): string {
    if (!connId) return 'número padrão';
    const c = connections.find((x) => x.id === connId);
    if (!c) return 'número';
    const digits = c.phoneNumber?.replace(/\D/g, '') ?? '';
    return digits.length >= 10 ? formatPhone(digits) : c.label;
  }

  async function submit() {
    if (!title.trim()) return toast('Dê um nome à campanha.', 'error');
    if (!connectionId) return toast('Escolha de qual número enviar.', 'error');
    try {
      const result = await create.mutateAsync({
        title: title.trim(),
        content_type: contentType,
        body_text: contentType === 'text' ? body.trim() : undefined,
        content_ref: contentType !== 'text' ? contentRef || undefined : undefined,
        all_clients: true,
        with_price: withPrice,
        daily_cap: Number(dailyCap) || 40,
        connection_id: connectionId,
      });
      toast(`Campanha criada com ${result.targets_added} destinatários.`, 'success');
      setOpen(false);
      setTitle('');
      setBody('');
      setContentRef('');
      setConnectionId('');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Disparos"
        subtitle="Campanhas com intervalo e teto diário (cuidado com banimento)"
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            Nova campanha
          </Button>
        }
      />

      <div className="space-y-3 px-4 py-4">
        <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
          Envio em massa pode banir o número na Z-API/WhatsApp. Use só para clientes ativos, com
          intervalo automático e teto diário baixo. Para escala, prefira Meta Cloud com templates.
        </p>

        {isLoading && <Spinner label="Carregando campanhas..." />}
        {isError && <ErrorState message="Falha ao carregar." onRetry={() => void refetch()} />}
        {!isLoading && !isError && (data?.length ?? 0) === 0 && (
          <EmptyState title="Nenhuma campanha" description="Crie um disparo de teste para poucos clientes." />
        )}

        {(data ?? []).map((b) => (
          <Card key={b.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-text-primary">{b.title}</p>
                <p className="text-xs text-text-secondary">
                  {phoneLabel(b.connection_id)} · {b.content_type} · teto {b.daily_cap}/dia ·{' '}
                  {new Date(b.created_at).toLocaleString('pt-BR')}
                </p>
              </div>
              <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
            </div>
            {(b.status === 'running' || b.status === 'scheduled' || b.status === 'paused') && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                loading={cancel.isPending}
                onClick={() =>
                  cancel.mutate(b.id, {
                    onSuccess: () => toast('Campanha cancelada.', 'success'),
                    onError: (err) => toast(getErrorMessage(err), 'error'),
                  })
                }
              >
                Cancelar
              </Button>
            )}
          </Card>
        ))}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nova campanha"
        footer={
          <Button fullWidth loading={create.isPending} onClick={() => void submit()}>
            Criar e iniciar
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <ConnectionNumberPicker
            value={connectionId}
            onChange={setConnectionId}
            label="Enviar por qual número?"
            cards={connections.length > 1}
          />
          <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select
            label="Tipo"
            value={contentType}
            onChange={(e) => setContentType(e.target.value as 'text' | 'audio' | 'product')}
          >
            <option value="text">Texto</option>
            <option value="audio">Áudio</option>
            <option value="product">Produto</option>
          </Select>
          {contentType === 'text' && (
            <TextArea
              label="Mensagem"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Oi {{client_name}}, novidade pra você..."
            />
          )}
          {contentType === 'audio' && (
            <Select label="Áudio" value={contentRef} onChange={(e) => setContentRef(e.target.value)}>
              <option value="">Selecione</option>
              {(audios ?? [])
                .filter((a) => a.is_active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </Select>
          )}
          {contentType === 'product' && (
            <>
              <Select label="Produto" value={contentRef} onChange={(e) => setContentRef(e.target.value)}>
                <option value="">Selecione</option>
                {(products ?? [])
                  .filter((p) => p.is_available)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={withPrice}
                  onChange={(e) => setWithPrice(e.target.checked)}
                />
                Incluir preço na legenda
              </label>
            </>
          )}
          <Input
            label="Teto diário de envios"
            inputMode="numeric"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
          />
          <p className="text-xs text-text-secondary">
            Destinatários: todos os clientes ativos (exceto bloqueados). Intervalo aleatório 8–25s entre
            envios.
          </p>
        </div>
      </Modal>
    </div>
  );
}
