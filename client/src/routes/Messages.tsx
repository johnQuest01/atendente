import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input, TextArea } from '@/components/ui/Input';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { TextIcon, PlusIcon, TrashIcon } from '@/components/ui/Icons';
import { useCreateScript, useDeleteScript, useScripts } from '@/hooks/useScripts';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import type { TextScript } from '@/types';

export default function Messages() {
  const { data, isLoading, isError, refetch } = useScripts();
  const deleteScript = useDeleteScript();
  const [open, setOpen] = useState(false);

  async function handleDelete(script: TextScript) {
    if (!confirm(`Excluir o script "${script.title}"?`)) return;
    try {
      await deleteScript.mutateAsync(script.id);
      toast('Script excluído.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Scripts"
        subtitle="Mensagens de texto prontas"
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon width={18} height={18} /> Novo
          </Button>
        }
      />

      {isLoading && <Spinner label="Carregando scripts..." />}
      {isError && <ErrorState message="Erro ao carregar scripts." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<TextIcon width={40} height={40} />}
          title="Nenhum script ainda"
          description="Crie textos com variáveis como {{client_name}} para respostas rápidas."
          action={<Button onClick={() => setOpen(true)}>Criar script</Button>}
        />
      )}

      <div className="flex flex-col gap-3 p-4">
        {(data ?? []).map((s) => (
          <Card key={s.id} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-text-primary">{s.title}</h3>
                <Badge tone="primary" className="mt-1">{s.category}</Badge>
              </div>
              <button
                onClick={() => handleDelete(s)}
                className="tap-scale shrink-0 rounded-full p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
                aria-label="Excluir"
              >
                <TrashIcon width={18} height={18} />
              </button>
            </div>
            <p className="whitespace-pre-wrap rounded-xl bg-bg p-3 text-sm text-text-secondary">{s.content}</p>
            {s.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {s.keywords.map((k) => (
                  <Badge key={k} tone="neutral">{k}</Badge>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      <CreateScriptModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateScriptModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateScript();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [keywords, setKeywords] = useState('');

  async function handleSubmit() {
    if (!title.trim() || !category.trim() || !content.trim()) {
      return toast('Preencha título, categoria e conteúdo.', 'error');
    }
    try {
      await create.mutateAsync({
        title: title.trim(),
        category: category.trim(),
        content: content.trim(),
        keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
      });
      toast('Script criado!', 'success');
      setTitle('');
      setCategory('');
      setContent('');
      setKeywords('');
      onClose();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Novo script"
      footer={
        <Button fullWidth loading={create.isPending} onClick={handleSubmit}>
          Salvar
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} />
        <TextArea
          label="Conteúdo"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          hint="Use {{client_name}} e {{company_name}} como variáveis."
          rows={4}
        />
        <Input label="Palavras-chave (vírgula)" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      </div>
    </Modal>
  );
}
