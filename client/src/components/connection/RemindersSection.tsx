import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import { usePersonaPreview } from '@/hooks/usePersona';
import { useReminderPersona, useSetReminderPersona } from '@/hooks/usePersona';
import {
  useAddReminderOwner,
  useMemoryScan,
  useOwnerModes,
  useReminderOwners,
  useRemoveReminderOwner,
  useSetMemoryScan,
  useSetOwnerModes,
  useSetReminderOwnerSecretary,
} from '@/hooks/useReminderOwners';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const PROMPT_TEXTAREA_CLASS =
  'mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-sans text-sm font-normal leading-relaxed text-text-primary outline-none focus:border-primary';

function OwnerModesCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data, isLoading } = useOwnerModes(connectionId);
  const setModes = useSetOwnerModes(connectionId);

  const secretary = data?.secretary ?? true;
  const agent = data?.agent ?? false;
  const webSearch = data?.webSearch ?? false;
  const openAccess = data?.openAccess ?? false;
  const searchReady = data?.webSearchConfigured ?? false;

  function patch(
    next: { secretary?: boolean; agent?: boolean; webSearch?: boolean; openAccess?: boolean },
    ok: string,
  ) {
    setModes.mutate(next, {
      onSuccess: () => toast(ok, 'success'),
      onError: (err) => toast(getErrorMessage(err), 'error'),
    });
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-bold text-text-primary">Secretária e Agente</h2>
        <p className="text-sm text-text-secondary">
          Alavancas deste WhatsApp. Respostas no modo ligado são otimizadas para{' '}
          <strong>rapidez</strong>. Com acesso livre desligado, só os números cadastrados abaixo
          usam isso — cada um com a própria alavanca.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando..." />}

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-text-primary">Acesso livre</h3>
            <Badge tone={openAccess ? 'success' : 'neutral'}>
              {openAccess ? 'Ligado' : 'Desligado'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Qualquer pessoa neste WhatsApp usa a secretária e a busca na web. Desligado: só os
            números cadastrados abaixo — a lista por pessoa continua valendo.
          </p>
        </div>
        <Toggle
          checked={openAccess}
          disabled={setModes.isPending || !canEdit || isLoading}
          onChange={(next) => {
            if (
              next &&
              !confirm(
                'Qualquer pessoa que mandar mensagem neste WhatsApp vai usar a secretária e a busca, não só os números cadastrados. Continuar?',
              )
            ) {
              return;
            }
            patch(
              { openAccess: next },
              next ? 'Acesso livre ligado.' : 'Acesso livre desligado. Só números cadastrados.',
            );
          }}
          label="Ligar ou desligar o acesso livre da secretária"
        />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-text-primary">Secretária</h3>
            <Badge tone={secretary ? 'success' : 'neutral'}>{secretary ? 'Ligada' : 'Desligada'}</Badge>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Anotar compromissos, consultar agenda e mandar msg a contatos (“mande um boa noite para
            o Wender”). Fale natural no WhatsApp.
          </p>
        </div>
        <Toggle
          checked={secretary}
          disabled={setModes.isPending || !canEdit || isLoading}
          onChange={(next) =>
            patch({ secretary: next }, next ? 'Secretária ligada.' : 'Secretária desligada.')
          }
          label="Ligar ou desligar a secretária"
        />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-text-primary">Agente</h3>
            <Badge tone={agent ? 'success' : 'neutral'}>{agent ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Chat livre no WhatsApp (como no Claude): perguntas, textos, ideias. Respostas curtas e
            rápidas. Lembretes continuam com a Secretária.
          </p>
        </div>
        <Toggle
          checked={agent}
          disabled={setModes.isPending || !canEdit || isLoading}
          onChange={(next) =>
            patch(
              { agent: next, webSearch: next ? webSearch : false },
              next ? 'Agente ligado.' : 'Agente desligado.',
            )
          }
          label="Ligar ou desligar o agente"
        />
      </div>

      <div
        className={`flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3 ${
          agent ? '' : 'opacity-60'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-text-primary">Busca na web</h3>
            <Badge tone={agent && webSearch ? 'success' : 'neutral'}>
              {agent && webSearch ? 'Ligada' : 'Desligada'}
            </Badge>
            {webSearch && (
              <Badge tone={searchReady ? 'success' : 'warning'}>
                {searchReady ? 'Tool OK' : 'Sem chave'}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            No Agente, a IA usa a ferramenta <strong>web_search</strong> (function calling) para
            cotações, notícias e fatos atuais. Precisa de chave Tavily/Brave no servidor
            {searchReady ? ' (configurada).' : ' — ainda sem chave neste ambiente.'}
          </p>
        </div>
        <Toggle
          checked={agent && webSearch}
          disabled={setModes.isPending || !canEdit || isLoading || !agent}
          onChange={(next) =>
            patch({ webSearch: next }, next ? 'Busca na web ligada.' : 'Busca na web desligada.')
          }
          label="Ligar ou desligar a busca na web"
        />
      </div>

      {(secretary || agent) && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-text-secondary">
          Modo rápido ativo: respostas enxutas no WhatsApp. Mande <strong>AJUDA</strong> no zap pra
          ver os comandos.
        </p>
      )}
    </Card>
  );
}

function ReminderOwnersCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: owners, isLoading } = useReminderOwners(connectionId);
  const { data: modes } = useOwnerModes(connectionId);
  const add = useAddReminderOwner(connectionId);
  const remove = useRemoveReminderOwner(connectionId);
  const setSecretary = useSetReminderOwnerSecretary(connectionId);
  const openAccess = modes?.openAccess === true;

  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');

  function submit() {
    if (!phone.trim()) return;
    add.mutate(
      { phone: phone.trim(), label: label.trim() || undefined },
      {
        onSuccess: () => {
          setPhone('');
          setLabel('');
          toast('Número autorizado. Assistente secretário liberado para este usuário.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Lembretes</h2>
        <p className="text-sm text-text-secondary">
          Cadastro por pessoa. Com o acesso livre desligado, só estes números falam com o
          assistente — use a alavanca de cada um para liberar ou pausar. Com o acesso livre
          ligado, qualquer pessoa usa a secretária; esta lista continua aqui para quando você
          desligar.
        </p>
      </div>

      {openAccess && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-text-secondary">
          Acesso livre está <strong>ligado</strong>: qualquer número neste WhatsApp usa a
          secretária e a busca agora. Desligue a alavanca geral para voltar a valer só esta lista.
        </p>
      )}

      {isLoading && <Spinner label="Carregando..." />}

      {owners?.map((o) => (
        <div
          key={o.phone}
          className="flex items-center gap-2 rounded-xl border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{o.label ?? o.phone}</p>
            {o.label && <p className="truncate text-xs text-text-secondary">{o.phone}</p>}
          </div>
          {canEdit && (
            <Toggle
              checked={o.secretary_enabled !== false}
              disabled={setSecretary.isPending}
              onChange={(next) =>
                setSecretary.mutate(
                  { phone: o.phone, secretaryEnabled: next },
                  {
                    onSuccess: () =>
                      toast(
                        next
                          ? `Assistente liberado para ${o.label ?? o.phone}.`
                          : `Assistente pausado para ${o.label ?? o.phone}.`,
                        'success',
                      ),
                    onError: (err) => toast(getErrorMessage(err), 'error'),
                  },
                )
              }
              label={`Liberar assistente secretário para ${o.label ?? o.phone}`}
            />
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(o.phone, {
                  onSuccess: () => toast('Número removido.', 'success'),
                  onError: (err) => toast(getErrorMessage(err), 'error'),
                })
              }
            >
              Remover
            </Button>
          )}
        </div>
      ))}

      {owners && owners.length === 0 && (
        <p className="text-xs text-text-secondary">
          Nenhum número autorizado. Adicione o seu para começar a mandar lembretes por WhatsApp.
        </p>
      )}

      {canEdit && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
          <Input
            label="Número (com DDI e DDD)"
            placeholder="Ex.: 5511999998888"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label="Identificação (opcional)"
            placeholder="Ex.: meu celular"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button size="sm" onClick={submit} loading={add.isPending}>
            Autorizar número
          </Button>
        </div>
      )}

      <p className="text-xs text-text-secondary">
        Depois é só mandar no WhatsApp: <em>“me lembra amanhã às 9h de pagar o fornecedor”</em>.
        Envie <strong>AJUDA</strong> para ver todos os comandos.
      </p>
    </Card>
  );
}

function ReminderPersonaCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data, isLoading } = useReminderPersona(connectionId);
  const setPersona = useSetReminderPersona(connectionId);
  const preview = usePersonaPreview();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    if (data && !touched) setText(data.prompt);
  }, [data, touched]);

  const isDefault = data?.isDefault ?? true;
  const dirty = touched && data ? text !== data.prompt : false;

  function save() {
    setPersona.mutate(
      { prompt: text },
      {
        onSuccess: () => {
          setTouched(false);
          toast('Comportamento do assistente de lembretes salvo!', 'success');
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
    preview.mutate({ prompt: text, message, target: 'reminder', connectionId });
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Assistente de lembretes</h2>
          <p className="text-sm text-text-secondary">
            Defina o tom com que sua secretária confirma e cobra lembretes. Isso muda só o jeito de
            falar — a data e a hora continuam calculadas pelo sistema.
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
        rows={10}
        spellCheck
        placeholder='Ex.: "Você é minha secretária. Confirme com clareza, cite a data por extenso..."'
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
        <h3 className="text-sm font-bold text-text-primary">Testar confirmação</h3>
        <p className="mb-2 text-xs text-text-secondary">
          Escreva como você pediria um lembrete e veja como a secretária confirmaria — sem salvar
          nada nem enviar WhatsApp.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Como você falaria"
              value={testMsg}
              onChange={(e) => setTestMsg(e.target.value)}
              placeholder="Ex.: me lembra sexta às 15h de pagar o fornecedor"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runPreview();
                }
              }}
            />
          </div>
          <Button size="sm" onClick={runPreview} loading={preview.isPending} disabled={!testMsg.trim()}>
            Testar
          </Button>
        </div>

        {preview.isError && <p className="mt-2 text-xs text-danger">{getErrorMessage(preview.error)}</p>}

        {preview.data && (
          <div className="mt-3 rounded-xl border border-border bg-bg p-3">
            {preview.data.reply ? (
              <>
                <Badge tone="success" className="mb-1">
                  Confirmação da secretária
                </Badge>
                <p className="whitespace-pre-wrap text-sm leading-snug text-text-primary">
                  {preview.data.reply}
                </p>
              </>
            ) : (
              <p className="text-xs text-warning">{preview.data.detail ?? 'Não interpretei um lembrete.'}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function MemoryScanCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: enabled } = useMemoryScan(connectionId);
  const setScan = useSetMemoryScan(connectionId);
  const isOn = enabled ?? false;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-text-primary">Recuperar compromissos</h2>
            <Badge tone={isOn ? 'success' : 'neutral'}>{isOn ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Deixa a IA reler as conversas recentes e sugerir compromissos que foram falados mas não
            viraram lembrete. Só roda quando você pede — e consome IA só nessa hora.
          </p>
        </div>
        <Toggle
          checked={isOn}
          disabled={setScan.isPending || !canEdit}
          onChange={(next) =>
            setScan.mutate(next, {
              onSuccess: () =>
                toast(next ? 'Varredura ligada.' : 'Varredura desligada.', 'success'),
              onError: (err) => toast(getErrorMessage(err), 'error'),
            })
          }
          label="Ligar ou desligar a varredura de conversas"
        />
      </div>
      {isOn && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-text-secondary">
          No WhatsApp do dono, mande <strong>RECUPERAR COMPROMISSOS</strong> (ou{' '}
          <strong>VARRER 7 DIAS</strong>). A secretária lista o que encontrou e só salva depois do
          seu <strong>SIM</strong>.
        </p>
      )}
    </Card>
  );
}

export function RemindersSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <OwnerModesCard connectionId={connectionId} canEdit={canEdit} />
      <ReminderOwnersCard connectionId={connectionId} canEdit={canEdit} />
      <ReminderPersonaCard connectionId={connectionId} canEdit={canEdit} />
      <MemoryScanCard connectionId={connectionId} canEdit={canEdit} />
    </div>
  );
}
