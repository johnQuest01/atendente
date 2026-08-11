import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import { AiProvidersManager } from '@/components/ai/AiProvidersManager';
import {
  useBehaviorSettings,
  useSetBehavior,
  type BehaviorSetting,
} from '@/hooks/usePersona';
import { useAiUsage } from '@/hooks/useAiProviders';
import {
  usePatchZapiInstanceSettings,
  useWhatsappConnections,
  useZapiInstanceSettings,
} from '@/hooks/useWhatsappConnection';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

function BehaviorSettingsCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: settings, isLoading } = useBehaviorSettings(connectionId);
  const save = useSetBehavior(connectionId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of settings) if (next[s.key] === undefined) next[s.key] = s.value;
      return next;
    });
  }, [settings]);

  function commit(s: BehaviorSetting, value: string | boolean) {
    save.mutate(
      { key: s.key, value },
      {
        onSuccess: () => toast(`"${s.label}" salvo.`, 'success'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  const scopeLabel: Record<string, string> = { sales: 'Vendas', reminder: 'Lembretes', geral: 'Geral' };

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Ajuste fino</h2>
        <p className="text-sm text-text-secondary">
          Regulagens rápidas da IA. Cada item vale na hora — sem precisar mexer no código.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando ajustes..." />}

      {settings?.map((s) => {
        const draft = drafts[s.key] ?? s.value;
        const dirty = draft !== s.value;
        return (
          <div key={s.key} className="rounded-xl border border-border bg-bg p-3">
            <div className="mb-1 flex items-center gap-2">
              <p className="text-sm font-semibold text-text-primary">{s.label}</p>
              <Badge tone="neutral">{scopeLabel[s.scope] ?? s.scope}</Badge>
            </div>
            <p className="mb-2 text-xs text-text-secondary">{s.description}</p>

            {s.type === 'toggle' ? (
              <Toggle
                checked={draft === 'true'}
                disabled={save.isPending || !canEdit}
                onChange={(next) => commit(s, next)}
                label={s.label}
              />
            ) : s.type === 'number' ? (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={s.min ?? 0}
                  max={s.max ?? 100}
                  step={(s.max ?? 1) <= 2 ? 0.1 : 1}
                  value={Number(draft)}
                  disabled={!canEdit}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  className="flex-1 accent-primary"
                />
                <span className="w-14 text-right text-xs tabular-nums text-text-primary">{draft}</span>
                {canEdit && (
                  <Button size="sm" onClick={() => commit(s, draft)} loading={save.isPending} disabled={!dirty}>
                    Salvar
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  disabled={!canEdit}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder="Deixe vazio para usar o padrão"
                />
                {canEdit && (
                  <Button size="sm" onClick={() => commit(s, draft)} loading={save.isPending} disabled={!dirty}>
                    Salvar
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function AiModelCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: usage } = useAiUsage('tenant');
  const over =
    !!usage && usage.source !== 'tenant' && usage.limit != null && usage.used >= usage.limit;

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-base font-bold text-text-primary">Modelo de IA</h2>
        <p className="text-sm text-text-secondary">
          Conecte suas próprias chaves e defina a ordem de atendimento. Quando os tokens de uma IA
          acabam, o sistema passa automaticamente para a próxima — sem parar a automação.
        </p>
      </div>

      {usage && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-border bg-bg px-3 py-2">
          <span className="text-xs text-text-secondary">
            Uso de IA neste mês{usage.source === 'tenant' ? ' (suas chaves)' : ' (plano)'}
          </span>
          <Badge tone={over ? 'danger' : 'neutral'}>
            {usage.source === 'tenant' || usage.limit == null
              ? `${usage.used} mensagem(ns)`
              : `${usage.used}/${usage.limit}`}
          </Badge>
        </div>
      )}

      {canEdit ? (
        <AiProvidersManager scope="tenant" suggestedConnectionId={connectionId} />
      ) : (
        <p className="text-xs text-text-secondary">Apenas administradores podem alterar o modelo.</p>
      )}
    </Card>
  );
}

function WhatsappInstanceSettingsCard({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const { data: connections } = useWhatsappConnections();
  const conn = connections?.connections.find((c) => c.id === connectionId);
  const isZapi = (conn?.provider ?? 'zapi') === 'zapi';
  const { data, isLoading, isError, refetch } = useZapiInstanceSettings(connectionId, isZapi);
  const patch = usePatchZapiInstanceSettings(connectionId);

  if (!isZapi) return null;

  function setToggle(key: 'autoReadMessage' | 'callRejectAuto', value: boolean) {
    patch.mutate(
      { [key]: value },
      {
        onSuccess: () => toast('Configuração salva na Z-API.', 'success'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Configurações WhatsApp</h2>
        <p className="text-sm text-text-secondary">
          Ajustes na instância pela API — sem abrir o painel da Z-API. Webhooks já apontam para o
          app. Grupos são ignorados no atendimento.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando configurações..." />}
      {isError && (
        <p className="text-sm text-danger">
          Não foi possível ler as opções.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Tentar de novo
          </button>
        </p>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">Ler mensagens automático</p>
              <p className="text-xs text-text-secondary">
                Marca como lida na API ao receber (o cliente vê os checks azuis).
              </p>
            </div>
            <Toggle
              checked={data.autoReadMessage}
              disabled={!canEdit || patch.isPending}
              onChange={(next) => setToggle('autoReadMessage', next)}
              label="Ler mensagens automático"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">Rejeitar chamadas automático</p>
              <p className="text-xs text-text-secondary">
                Recusa ligações de voz no número conectado à API.
              </p>
            </div>
            <Toggle
              checked={data.callRejectAuto}
              disabled={!canEdit || patch.isPending}
              onChange={(next) => setToggle('callRejectAuto', next)}
              label="Rejeitar chamadas automático"
            />
          </div>

          <p className="text-xs text-text-secondary">
            Eco das mensagens enviadas por você no celular:{' '}
            <strong>{data.receiveCallbackSentByMe ? 'ligado' : 'desligado'}</strong> (necessário
            para a IA pausar quando você responde).
          </p>
        </>
      )}
    </Card>
  );
}

export function AdvancedSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <WhatsappInstanceSettingsCard connectionId={connectionId} canEdit={canEdit} />
      <AiModelCard connectionId={connectionId} canEdit={canEdit} />
      <BehaviorSettingsCard connectionId={connectionId} canEdit={canEdit} />
    </div>
  );
}
