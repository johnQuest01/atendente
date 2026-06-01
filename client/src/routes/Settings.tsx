import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/hooks/useAuth';
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
