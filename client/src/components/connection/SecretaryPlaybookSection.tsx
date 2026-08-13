import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useSecretaryPlaybook, useSetSecretaryPlaybook } from '@/hooks/usePersona';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const TEXTAREA_CLASS =
  'mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-sans text-sm font-normal leading-relaxed text-text-primary outline-none focus:border-primary';

export function SecretaryPlaybookSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data, isLoading } = useSecretaryPlaybook(connectionId);
  const saveMut = useSetSecretaryPlaybook(connectionId);
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (data && !touched) setText(data.prompt);
  }, [data, touched]);

  const dirty = touched && data ? text !== data.prompt : false;
  const hasRules = Boolean((data?.prompt ?? '').trim());

  function save() {
    saveMut.mutate(
      { prompt: text },
      {
        onSuccess: () => {
          setTouched(false);
          toast('Treino da secretária salvo. Ela já segue essas regras.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-primary">Treino da secretária</h2>
            <p className="text-sm text-text-secondary">
              Escreva em português o que ela deve fazer neste WhatsApp. Salve e vale na hora — sem
              atualizar código. Ela interpreta o sentido e executa (responder, avisar, pesquisar,
              falar com contato…).
            </p>
          </div>
          <Badge tone={hasRules ? 'success' : 'neutral'}>{hasRules ? 'Com treino' : 'Vazio'}</Badge>
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setTouched(true);
          }}
          disabled={isLoading || !canEdit}
          rows={14}
          spellCheck
          placeholder={
            'Exemplos (pode juntar vários):\n\n' +
            '• Só dê bom dia para qualquer pessoa que mandar mensagem. Nada mais.\n' +
            '• Quando o Wender chamar, me avisa e não responde.\n' +
            '• Se alguém pedir preço, manda o catálogo e pergunta o que precisa.\n' +
            '• Fala curto, sem emoji.'
          }
          className={TEXTAREA_CLASS}
        />

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-text-secondary">{text.length} caracteres</span>
          {canEdit && (
            <Button size="sm" onClick={save} disabled={!dirty} loading={saveMut.isPending}>
              Salvar treino
            </Button>
          )}
        </div>

        {!canEdit && (
          <p className="mt-2 text-xs text-text-secondary">Só o administrador desta conta edita o treino.</p>
        )}
      </Card>

      <Card>
        <h3 className="text-sm font-bold text-text-primary">Como usar</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
          <li>Cada conexão (número) tem o próprio caderno.</li>
          <li>Pode ir acrescentando regras; a mais específica ganha se houver conflito.</li>
          <li>
            “Quem te chamar / qualquer pessoa” vale para <strong>contatos</strong>. Você, dono,
            continua mandando comando no WhatsApp.
          </li>
          <li>Para desligar um treino, apague o texto e salve.</li>
        </ul>
      </Card>
    </div>
  );
}
