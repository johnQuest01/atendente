import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, Spinner } from '@/components/ui/States';
import { PlusIcon } from '@/components/ui/Icons';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { getConnectionStatus } from '@/components/connection/connectionStatus';
import { formatPhone } from '@/utils/formatters';
import { useSocket } from '@/hooks/useSocket';

export default function Connections() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useWhatsappConnections();
  const connections = data?.connections ?? [];

  const onWhatsappStatus = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['whatsapp-connections'] });
  }, [qc]);
  useSocket({ 'whatsapp:status': onWhatsappStatus });

  return (
    <>
      <PageHeader
        title="Conexões"
        subtitle="Seus números WhatsApp"
        action={
          <Button size="sm" onClick={() => navigate('/conexoes/nova')}>
            <PlusIcon width={16} height={16} />
            Criar conexão
          </Button>
        }
      />

      <div className="flex flex-col gap-3 p-4">
        {isLoading && <Spinner label="Carregando conexões..." />}

        {!isLoading && connections.length === 0 && (
          <EmptyState
            title="Crie sua primeira conexão"
            description="Cadastre um número WhatsApp para a IA começar a atender seus clientes."
            action={
              <Button onClick={() => navigate('/conexoes/nova')}>
                <PlusIcon width={16} height={16} />
                Criar conexão
              </Button>
            }
          />
        )}

        {connections.map((conn) => {
          const status = getConnectionStatus(conn);
          const phone = conn.phoneNumber?.replace(/\D/g, '') ?? '';
          const phoneLabel =
            phone.length >= 10 ? formatPhone(phone) : conn.phoneNumber || 'Número não detectado';

          return (
            <Link key={conn.id} to={`/conexoes/${conn.id}`} className="block">
              <Card className="flex items-center gap-3 transition-colors hover:border-primary/40">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-bold text-text-primary">{conn.label}</p>
                  <p className="truncate text-sm text-text-secondary">{phoneLabel}</p>
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="text-lg text-text-secondary" aria-hidden>
                  ›
                </span>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
