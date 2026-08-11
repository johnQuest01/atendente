import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { agentQueryKey, useAgentStatus, useSetAgentStatus } from '@/hooks/useAgent';
import { useSystemStatus, type ServiceCheck } from '@/hooks/useSystemStatus';
import { ManageConnectionPanel } from '@/components/connection/ManageConnectionPanel';
import { WhatsappReconnect } from '@/components/connection/WhatsappReconnect';
import { ContactsHistoryCard } from '@/components/features/ContactsHistoryCard';
import { useSocket } from '@/hooks/useSocket';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { getConnectionStatus } from '@/components/connection/connectionStatus';

function StatusRow({ label, check }: { label: string; check?: ServiceCheck }) {
  const ok = check?.ok ?? false;
  const tone = !check ? 'warning' : ok ? 'success' : check.optional ? 'warning' : 'danger';
  const badgeText = !check ? '...' : ok ? 'OK' : check.optional ? 'Inativo' : 'Falha';

  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm text-text-primary">{label}</span>
          {check?.provider ? (
            <span className="text-sm font-bold text-text-primary">{check.provider}</span>
          ) : (
            check && <span className="text-sm text-text-secondary">não configurado</span>
          )}
        </div>
        {check?.detail && (
          <p className="mt-0.5 truncate text-xs text-text-secondary" title={check.detail}>
            {check.detail}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Badge tone={tone}>{badgeText}</Badge>
        {check?.latencyMs != null && (
          <span className="text-[10px] tabular-nums text-text-secondary">{check.latencyMs}ms</span>
        )}
      </div>
    </li>
  );
}

export function OverviewSection({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { data: agentEnabled } = useAgentStatus(connectionId);
  const setAgent = useSetAgentStatus(connectionId);
  const { data: health, isFetching, refetch } = useSystemStatus(connectionId);
  const { data: connections } = useWhatsappConnections();
  const conn = connections?.connections.find((c) => c.id === connectionId);
  const connStatus = conn ? getConnectionStatus(conn) : null;
  const needsReconnect =
    canEdit && connStatus && connStatus.kind !== 'connected';

  const onAgentStatus = useCallback(
    (payload: unknown) => {
      const p = payload as { enabled?: boolean; connectionId?: string } | undefined;
      if (typeof p?.enabled !== 'boolean') return;
      if (p.connectionId && p.connectionId !== connectionId) return;
      qc.setQueryData(agentQueryKey(connectionId), p.enabled);
    },
    [qc, connectionId],
  );
  useSocket({ 'agent:status': onAgentStatus });

  const isOn = agentEnabled ?? true;

  return (
    <div className="flex flex-col gap-4">
      <Card className={isOn ? 'border-2 border-success/30' : 'border-2 border-danger/40'}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-text-primary">Atendente de IA</h2>
              <Badge tone={isOn ? 'success' : 'danger'}>{isOn ? 'Ligado' : 'Desligado'}</Badge>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {isOn
                ? 'A IA responde automaticamente os clientes neste WhatsApp.'
                : 'A IA está pausada neste número. As mensagens chegam no painel, mas quem responde é você.'}
            </p>
          </div>
          <Toggle
            checked={isOn}
            disabled={setAgent.isPending || !canEdit}
            onChange={(next) => setAgent.mutate(next)}
            label="Ligar ou desligar o atendente de IA"
          />
        </div>
      </Card>

      <Card>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-text-primary">Status do sistema</h2>
          <div className="flex items-center gap-2">
            {health && (
              <Badge tone={health.status === 'ok' ? 'success' : 'warning'}>
                {health.status === 'ok' ? 'Tudo operando' : 'Atenção'}
              </Badge>
            )}
            <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
              Testar
            </Button>
          </div>
        </div>
        <p className="mb-2 text-xs text-text-secondary">
          Cada linha mostra o serviço em uso agora — trocar de provedor troca o nome aqui.
        </p>
        <ul className="flex flex-col divide-y divide-border">
          <StatusRow label="WhatsApp" check={health?.services.whatsapp} />
          <StatusRow label="Inteligência artificial" check={health?.services.ai} />
          <StatusRow label="Banco de dados" check={health?.services.database} />
          <StatusRow label="Transcrição de áudio" check={health?.services.transcription} />
          <StatusRow label="Armazenamento de mídia" check={health?.services.storage} />
        </ul>
        {health && (
          <p className="mt-3 text-xs text-text-secondary">
            Última verificação: {new Date(health.timestamp).toLocaleString('pt-BR')}
          </p>
        )}
      </Card>

      {needsReconnect && (
        <WhatsappReconnect
          connectionId={connectionId}
          onConnected={() => {
            void qc.invalidateQueries({ queryKey: ['whatsapp-connections'] });
            void refetch();
          }}
        />
      )}

      <ManageConnectionPanel connectionId={connectionId} canEdit={canEdit} />

      <ContactsHistoryCard connectionId={connectionId} />
    </div>
  );
}
