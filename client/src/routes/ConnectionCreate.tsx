import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackIcon } from '@/components/ui/Icons';
import { WhatsappOnboarding } from '@/components/connection/WhatsappOnboarding';
import { WhatsappConnectionForm } from '@/components/connection/ManageConnectionPanel';
import {
  useSaveWhatsappConnection,
  useWhatsappConnections,
} from '@/hooks/useWhatsappConnection';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Cliente: só número + código.
 * Superadmin: ainda pode abrir ?manual=1 (legado).
 */
export default function ConnectionCreate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const isSuper = user?.role === 'superadmin';
  const manual = isSuper && params.get('manual') === '1';
  const { data } = useWhatsappConnections();
  const save = useSaveWhatsappConnection();
  const encryptionOk = data?.encryptionAvailable !== false;

  return (
    <>
      <PageHeader
        title={manual ? 'Credenciais manuais' : 'Nova conexão'}
        subtitle={manual ? 'Avançado (só suporte)' : 'Conecte com seu número WhatsApp'}
        leading={
          <Button
            size="sm"
            variant="ghost"
            aria-label="Voltar"
            onClick={() => navigate(manual ? '/conexoes/nova' : '/')}
          >
            <BackIcon width={20} height={20} />
          </Button>
        }
      />

      <div className="flex flex-col gap-4 p-4">
        {manual ? (
          <Card>
            <WhatsappConnectionForm
              encryptionOk={encryptionOk}
              saving={save.isPending}
              submitLabel="Criar conexão"
              onCancel={() => navigate('/conexoes/nova')}
              onSave={(payload) => {
                save.mutate(payload, {
                  onSuccess: (view) => {
                    toast('Conexão criada.', 'success');
                    navigate(`/conexoes/${view.id}`);
                  },
                  onError: (err) => toast(getErrorMessage(err), 'error'),
                });
              }}
            />
          </Card>
        ) : (
          <WhatsappOnboarding />
        )}
      </div>
    </>
  );
}
