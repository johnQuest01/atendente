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
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Fase 2: onboarding embutido (QR/código via nosso backend).
 * Credenciais manuais Z-API ficam em ?manual=1 (legado/avançado).
 */
export default function ConnectionCreate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const manual = params.get('manual') === '1';
  const { data } = useWhatsappConnections();
  const save = useSaveWhatsappConnection();
  const encryptionOk = data?.encryptionAvailable !== false;

  return (
    <>
      <PageHeader
        title={manual ? 'Credenciais manuais' : 'Nova conexão'}
        subtitle={
          manual
            ? 'Cole Instance ID e Token da Z-API (avançado)'
            : 'Conecte o WhatsApp sem sair do app'
        }
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
          <>
            <WhatsappOnboarding />
            <p className="rounded-xl border border-border bg-bg px-3 py-3 text-center text-xs text-text-secondary">
              Sem Partner Token da Z-API ainda? Cole Instance ID e Token em{' '}
              <button
                type="button"
                className="font-semibold text-primary underline-offset-2 hover:underline"
                onClick={() => navigate('/conexoes/nova?manual=1')}
              >
                Credenciais manuais
              </button>
              , ou abasteça o pool em Empresas (superadmin).
            </p>
          </>
        )}
      </div>
    </>
  );
}
