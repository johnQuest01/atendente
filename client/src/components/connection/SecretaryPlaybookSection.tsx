import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useSecretaryPlaybook, useSetSecretaryPlaybook } from '@/hooks/usePersona';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const TEXTAREA_CLASS =
  'mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-sans text-sm font-normal leading-relaxed text-text-primary outline-none focus:border-primary';

function countOrders(text: string): number {
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+|,\s*(?=\bex+c?eto\b)|\s*(?=\b(?:ex+c?eto|excepto)\b)/i)
    .map((c) => c.replace(/^(?:ex+c?eto|excepto|menos|tirando)\s+/i, '').trim())
    .filter((c) => c.replace(/[.!?]+$/g, '').trim().length >= 3).length;
}

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
  const orders = countOrders(text);

  function save() {
    saveMut.mutate(
      { prompt: text },
      {
        onSuccess: (saved) => {
          setText(saved.prompt);
          setTouched(false);
          toast('Secretária atualizada agora. Ela já segue esses pedidos.', 'success');
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
              Um pedido por frase, sempre com ponto final. Salve e vale na hora — a mensagem
              seguinte já obedece.
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
            'Separe cada pedido com ponto final. Use "exceto" para abrir exceção.\n\n' +
            'Não use emoji para o Bruno e nenhum contato, exceto minha esposa 5511970198779.\n' +
            'Para a esposa usa o emoji de coração.\n' +
            'Fala curto.\n' +
            'Quando o Wender chamar, me avisa e não responde.'
          }
          className={TEXTAREA_CLASS}
        />

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-text-secondary">
            {text.length} caracteres
            {orders > 0 ? ` · ${orders} pedido${orders === 1 ? '' : 's'}` : ''}
          </span>
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
          <li>
            Ela conhece <strong>todos</strong> os emojis. Peça pelo nome (“emoji de coração”, “de foguete”)
            ou cole. Se pedir só o emoji, ela manda só ele.
          </li>
          <li>Ao salvar, o texto é organizado um pedido por linha e a secretária atualiza na hora.</li>
          <li>Cada conexão (número) tem o próprio caderno.</li>
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
