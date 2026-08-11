import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { usePersona, usePersonaPreview, useSetPersona } from '@/hooks/usePersona';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const PROMPT_TEXTAREA_CLASS =
  'mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-sans text-sm font-normal leading-relaxed text-text-primary outline-none focus:border-primary';

export function AiBehaviorSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data, isLoading } = usePersona(connectionId);
  const setPersona = useSetPersona(connectionId);
  const preview = usePersonaPreview();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [temp, setTemp] = useState(0.7);

  useEffect(() => {
    if (data && !touched) {
      setText(data.prompt);
      setTemp(data.temperature ?? 0.7);
    }
  }, [data, touched]);

  const isDefault = data?.isDefault ?? true;
  const dirty =
    touched && data
      ? text !== data.prompt || Math.abs(temp - (data.temperature ?? 0.7)) > 0.001
      : false;

  function save() {
    setPersona.mutate(
      { prompt: text, temperature: temp },
      {
        onSuccess: () => {
          setTouched(false);
          toast('Como a IA atende foi salvo! O agente já segue as novas instruções.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  function restoreDefault() {
    if (!data) return;
    setText(data.default);
    setTouched(true);
  }

  function runPreview() {
    const message = testMsg.trim();
    if (!message) return;
    preview.mutate({ prompt: text, message, temperature: temp, connectionId });
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Como a IA atende</h2>
          <p className="text-sm text-text-secondary">
            Escreva o contexto, o jeito de falar e as regras que a IA deve seguir. É como escrever
            as instruções direto pra IA — ela lê e responde os clientes seguindo isto.
          </p>
        </div>
        <Badge tone={isDefault ? 'primary' : 'success'}>{isDefault ? 'Padrão' : 'Personalizado'}</Badge>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTouched(true);
        }}
        disabled={isLoading || !canEdit}
        rows={16}
        spellCheck
        placeholder="Ex.: Você é a Ana, atendente da Loja X. Fale de forma simpática e curta..."
        className={PROMPT_TEXTAREA_CLASS}
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-text-secondary">{text.length} caracteres</span>
        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={restoreDefault} disabled={setPersona.isPending}>
              Restaurar padrão
            </Button>
            <Button size="sm" onClick={save} loading={setPersona.isPending} disabled={!dirty}>
              Salvar
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-bold text-text-primary">Testar resposta (pré-visualização)</h3>
        <p className="mb-2 text-xs text-text-secondary">
          Simule uma mensagem de cliente e veja como a IA responderia com este prompt — sem enviar
          nada no WhatsApp. Usa o texto acima (mesmo sem salvar), o seu catálogo e o provedor de IA ativo.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Mensagem do cliente"
              value={testMsg}
              onChange={(e) => setTestMsg(e.target.value)}
              placeholder="Ex.: Oi, vocês vendem no atacado? Qual o pedido mínimo?"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runPreview();
                }
              }}
            />
          </div>
          <Button size="sm" onClick={runPreview} loading={preview.isPending} disabled={!testMsg.trim()}>
            Simular resposta
          </Button>
        </div>

        <label className="mt-3 flex items-center gap-3 text-xs text-text-secondary">
          <span className="whitespace-nowrap">Criatividade: {temp.toFixed(1)}</span>
          <input
            type="range"
            min={0}
            max={1.2}
            step={0.1}
            value={temp}
            disabled={!canEdit}
            onChange={(e) => {
              setTemp(Number(e.target.value));
              setTouched(true);
            }}
            className="flex-1 accent-primary"
          />
        </label>
        <p className="mt-1 text-[11px] text-text-secondary">
          Este valor é salvo com a personalidade e vale também para o atendimento real no WhatsApp.
        </p>

        {preview.isError && <p className="mt-2 text-xs text-danger">{getErrorMessage(preview.error)}</p>}

        {preview.data && (
          <div className="mt-3 rounded-xl border border-border bg-bg p-3">
            {preview.data.reply ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone="success">Resposta da IA</Badge>
                  {preview.data.providerLabel && (
                    <span className="text-[11px] text-text-secondary">
                      via {preview.data.providerLabel}
                      {preview.data.model ? ` · ${preview.data.model}` : ''}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-snug text-text-primary">
                  {preview.data.reply}
                </p>
              </>
            ) : (
              <p className="text-xs text-warning">{preview.data.detail ?? 'A IA não respondeu.'}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
