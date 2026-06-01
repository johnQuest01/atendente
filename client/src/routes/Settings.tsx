import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { useAuth } from '@/hooks/useAuth';
import { useAgentStatus, useSetAgentStatus, AGENT_QUERY_KEY } from '@/hooks/useAgent';
import { useSocket } from '@/hooks/useSocket';
import { initials } from '@/utils/formatters';

interface HealthData {
  status: string;
  db: boolean;
  anthropic: boolean;
  transcription: boolean;
  zapi: boolean;
  whatsappProvider?: 'zapi' | 'evolution';
  timestamp: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  zapi: 'Z-API',
  evolution: 'Evolution API',
};

export default function Settings() {
  const { user, logout } = useAuth();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);

  const qc = useQueryClient();
  const { data: agentEnabled } = useAgentStatus();
  const setAgent = useSetAgentStatus();

  // Sincroniza o status em tempo real se ele for alterado em outro dispositivo.
  const onAgentStatus = useCallback(
    (payload: unknown) => {
      const enabled = (payload as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled === 'boolean') qc.setQueryData(AGENT_QUERY_KEY, enabled);
    },
    [qc],
  );
  useSocket({ 'agent:status': onAgentStatus });

  const isOn = agentEnabled ?? true;

  async function checkHealth() {
    setLoading(true);
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${base}/health`);
      setHealth((await res.json()) as HealthData);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <>
      <PageHeader title="Configurações" subtitle="Perfil e integrações" />

      <div className="flex flex-col gap-4 p-4">
        <Card className={isOn ? 'border-2 border-success/30' : 'border-2 border-danger/40'}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-text-primary">Atendente de IA</h2>
                <Badge tone={isOn ? 'success' : 'danger'}>{isOn ? 'Ligado' : 'Desligado'}</Badge>
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                {isOn
                  ? 'A IA responde automaticamente os clientes no WhatsApp.'
                  : 'A IA está pausada. As mensagens chegam no painel, mas quem responde é você.'}
              </p>
            </div>
            <Toggle
              checked={isOn}
              disabled={setAgent.isPending}
              onChange={(next) => setAgent.mutate(next)}
              label="Ligar ou desligar o atendente de IA"
            />
          </div>
        </Card>

        <Card className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-lg font-bold text-primary">
            {initials(user?.name ?? null)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-text-primary">{user?.name}</p>
            <p className="truncate text-sm text-text-secondary">{user?.email}</p>
            {user && <Badge tone="primary" className="mt-1">{user.role === 'admin' ? 'Administrador' : 'Operador'}</Badge>}
          </div>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">Status do sistema</h2>
            <Button size="sm" variant="secondary" loading={loading} onClick={checkHealth}>
              Testar
            </Button>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            <StatusRow label="Servidor / Banco" ok={Boolean(health?.db)} />
            <StatusRow label="Claude (Anthropic)" ok={Boolean(health?.anthropic)} />
            <StatusRow label="Transcrição de áudio (STT)" ok={Boolean(health?.transcription)} />
            <StatusRow
              label={`WhatsApp (${PROVIDER_LABEL[health?.whatsappProvider ?? 'zapi'] ?? 'Z-API'})`}
              ok={Boolean(health?.zapi)}
            />
          </ul>
          {health && (
            <p className="mt-3 text-xs text-text-secondary">
              Última verificação: {new Date(health.timestamp).toLocaleString('pt-BR')}
            </p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-bold text-text-primary">Webhook do WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Configure na Z-API a URL de mensagens recebidas apontando para o endpoint{' '}
            <code className="rounded bg-bg px-1 py-0.5 text-xs">POST /webhook/whatsapp</code> do servidor.
          </p>
        </Card>

        <Button variant="danger" fullWidth onClick={logout}>
          Sair da conta
        </Button>
      </div>
    </>
  );
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between py-2.5">
      <span className="text-sm text-text-primary">{label}</span>
      <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'OK' : 'Indisponível'}</Badge>
    </li>
  );
}
