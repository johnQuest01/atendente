import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { KeyIcon, PlusIcon, TrashIcon } from '@/components/ui/Icons';
import { useCreateKeyword, useDeleteKeyword, useKeywords } from '@/hooks/useKeywords';
import { useAudios } from '@/hooks/useAudios';
import { useScripts } from '@/hooks/useScripts';
import { useProducts } from '@/hooks/useProducts';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import type { ContentType, Keyword } from '@/types';

const TYPE_LABELS: Record<ContentType, string> = {
  audio: 'Áudio',
  text: 'Script',
  product: 'Produto',
  claude: 'IA (Claude)',
};

const TYPE_TONE: Record<ContentType, 'primary' | 'success' | 'warning' | 'neutral'> = {
  audio: 'primary',
  text: 'success',
  product: 'warning',
  claude: 'neutral',
};

export default function Keywords() {
  const { data, isLoading, isError, refetch } = useKeywords();
  const deleteKeyword = useDeleteKeyword();
  const [open, setOpen] = useState(false);

  async function handleDelete(kw: Keyword) {
    if (!confirm(`Excluir a palavra-chave "${kw.keyword}"?`)) return;
    try {
      await deleteKeyword.mutateAsync(kw.id);
      toast('Palavra-chave excluída.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Keywords"
        subtitle="Palavra-chave → conteúdo"
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon width={18} height={18} /> Nova
          </Button>
        }
      />

      {isLoading && <Spinner label="Carregando..." />}
      {isError && <ErrorState message="Erro ao carregar keywords." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<KeyIcon width={40} height={40} />}
          title="Nenhuma palavra-chave"
          description="Mapeie palavras a áudios, scripts ou produtos para respostas automáticas."
          action={<Button onClick={() => setOpen(true)}>Criar mapeamento</Button>}
        />
      )}

      <div className="flex flex-col gap-3 p-4">
        {(data ?? []).map((kw) => (
          <Card key={kw.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-text-primary">{kw.keyword}</p>
              <p className="text-xs text-text-secondary">intenção: {kw.intent}</p>
            </div>
            <Badge tone={TYPE_TONE[kw.content_type]}>{TYPE_LABELS[kw.content_type]}</Badge>
            <span className="text-xs text-text-secondary">P{kw.priority}</span>
            <button
              onClick={() => handleDelete(kw)}
              className="tap-scale rounded-full p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
              aria-label="Excluir"
            >
              <TrashIcon width={18} height={18} />
            </button>
          </Card>
        ))}
      </div>

      <CreateKeywordModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateKeywordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateKeyword();
  const { data: audios } = useAudios();
  const { data: scripts } = useScripts();
  const { data: products } = useProducts();

  const [keyword, setKeyword] = useState('');
  const [intent, setIntent] = useState('');
  const [contentType, setContentType] = useState<ContentType>('audio');
  const [contentId, setContentId] = useState('');
  const [priority, setPriority] = useState('1');

  const options =
    contentType === 'audio'
      ? (audios ?? []).map((a) => ({ id: a.id, label: a.title }))
      : contentType === 'text'
        ? (scripts ?? []).map((s) => ({ id: s.id, label: s.title }))
        : contentType === 'product'
          ? (products ?? []).map((p) => ({ id: p.id, label: p.name }))
          : [];

  async function handleSubmit() {
    if (!keyword.trim() || !intent.trim()) return toast('Preencha keyword e intenção.', 'error');
    if (contentType !== 'claude' && !contentId) return toast('Selecione o conteúdo de destino.', 'error');
    try {
      await create.mutateAsync({
        keyword: keyword.trim(),
        intent: intent.trim(),
        content_type: contentType,
        content_id: contentType === 'claude' ? null : contentId,
        priority: Number(priority) || 1,
      });
      toast('Mapeamento criado!', 'success');
      setKeyword('');
      setIntent('');
      setContentId('');
      setPriority('1');
      onClose();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nova palavra-chave"
      footer={
        <Button fullWidth loading={create.isPending} onClick={handleSubmit}>
          Salvar
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Palavra-chave" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="preço" />
        <Input label="Intenção" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="duvida_preco" />
        <Select
          label="Tipo de conteúdo"
          value={contentType}
          onChange={(e) => {
            setContentType(e.target.value as ContentType);
            setContentId('');
          }}
        >
          <option value="audio">Áudio</option>
          <option value="text">Script de texto</option>
          <option value="product">Produto</option>
          <option value="claude">IA (Claude)</option>
        </Select>
        {contentType !== 'claude' && (
          <Select label="Conteúdo de destino" value={contentId} onChange={(e) => setContentId(e.target.value)}>
            <option value="">Selecione...</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
        <Input label="Prioridade" type="number" min={1} value={priority} onChange={(e) => setPriority(e.target.value)} hint="Maior = mais prioritário" />
      </div>
    </Modal>
  );
}
