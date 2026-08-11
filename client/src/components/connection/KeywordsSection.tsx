import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import { useCreateKeyword, useDeleteKeyword, useKeywords } from '@/hooks/useKeywords';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { splitDispatchKeywords } from '@/utils/dispatchKeywords';

/**
 * Palavras que chamam a IA / disparo de compromissos — sempre escopadas
 * nesta conexão (sem picker).
 */
export function KeywordsSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: keywords, isLoading } = useKeywords();
  const create = useCreateKeyword();
  const remove = useDeleteKeyword();
  const [word, setWord] = useState('');
  const [saving, setSaving] = useState(false);

  const words = (keywords ?? []).filter(
    (k) => k.content_type === 'reminders_today' && k.connection_id === connectionId,
  );
  const existing = new Set(words.map((k) => k.keyword.trim().toLowerCase()));

  async function add() {
    if (!connectionId) return toast('Conexão obrigatória para cadastrar a palavra.', 'error');
    const parts = splitDispatchKeywords(word);
    if (parts.length === 0) return;

    const toCreate = parts.filter((p) => !existing.has(p));
    if (toCreate.length === 0) {
      toast('Essas palavras já estão cadastradas nesta conexão.', 'info');
      setWord('');
      return;
    }

    setSaving(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const w of toCreate) {
        try {
          await create.mutateAsync({
            keyword: w,
            intent: 'reminders_today',
            content_type: 'reminders_today',
            content_id: null,
            priority: 1,
            connection_id: connectionId,
          });
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      setWord('');
      if (ok > 0 && fail === 0) {
        toast(
          ok === 1 ? 'Palavra adicionada.' : `${ok} palavras adicionadas.`,
          'success',
        );
      } else if (ok > 0) {
        toast(`${ok} salva(s), ${fail} falhou(aram).`, 'info');
      } else {
        toast('Não foi possível salvar as palavras.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Palavras que chamam a IA</h2>
        <p className="text-sm text-text-secondary">
          Quando um número autorizado mandar uma destas palavras <strong>neste WhatsApp</strong>,
          eu respondo os compromissos de hoje — sem gastar IA. Maiúsculas/minúsculas não importam.
          Separe várias com <strong>ponto</strong> ou <strong>vírgula</strong>. As palavras{' '}
          <strong>HOJE</strong>, <strong>AMANHÃ</strong>, <strong>SEMANA</strong>,{' '}
          <strong>MÊS</strong> e <strong>TODOS</strong> já funcionam sem cadastrar.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando..." />}

      {words.map((k) => (
        <div key={k.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{k.keyword}</p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(k.id, {
                  onSuccess: () => toast('Palavra removida.', 'success'),
                  onError: (err) => toast(getErrorMessage(err), 'error'),
                })
              }
            >
              Remover
            </Button>
          )}
        </div>
      ))}

      {words.length === 0 && !isLoading && (
        <p className="text-xs text-text-secondary">
          Nenhuma palavra extra. Ex.: <em>resumo. agenda do dia</em>
        </p>
      )}

      {canEdit && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
          <Input
            label="Nova palavra"
            placeholder="Ex.: resumo. agenda do dia, e balanço"
            hint="Ponto ou vírgula separa várias. Vale só nesta conexão."
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => void add()}
            loading={saving || create.isPending}
            disabled={!word.trim()}
          >
            Adicionar palavra
          </Button>
        </div>
      )}
    </Card>
  );
}
