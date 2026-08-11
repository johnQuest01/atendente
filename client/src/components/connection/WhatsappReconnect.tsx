import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import {
  useConnectStatus,
  useRequestPhoneCode,
  useRestartWhatsappConnect,
  type OnboardingStatus,
} from '@/hooks/useWhatsappOnboarding';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const STATUS_LABEL: Record<OnboardingStatus, string> = {
  PROVISIONING: 'Preparando…',
  AGUARDANDO_LEITURA: 'Aguardando você digitar o código',
  CONECTANDO: 'Conectando…',
  CONECTADO: 'Conectado',
  ERRO: 'Erro',
  EXPIRADO: 'Expirado',
  DESCONECTADO: 'Desconectado',
};

function statusTone(status: OnboardingStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'CONECTADO') return 'success';
  if (status === 'ERRO' || status === 'EXPIRADO') return 'danger';
  if (status === 'AGUARDANDO_LEITURA' || status === 'CONECTANDO') return 'warning';
  return 'neutral';
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Reconexão simples: número → código. */
export function WhatsappReconnect({
  connectionId,
  onConnected,
}: {
  connectionId: string;
  onConnected?: () => void;
}) {
  const restart = useRestartWhatsappConnect();
  const requestCode = useRequestPhoneCode(connectionId);
  const [active, setActive] = useState(false);
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const polling = useConnectStatus(
    connectionId,
    active && status !== 'CONECTADO' && status !== 'ERRO',
  );

  useSocket({
    'whatsapp:status': (payload: unknown) => {
      const p = payload as {
        connectionId?: string;
        status?: OnboardingStatus;
        detail?: string | null;
        phoneCode?: string | null;
      };
      if (!p.connectionId || p.connectionId !== connectionId) return;
      if (p.status) setStatus(p.status);
      if (p.detail != null) setDetail(p.detail);
      if (p.phoneCode) setPhoneCode(p.phoneCode);
      if (p.status === 'CONECTADO') {
        toast('WhatsApp conectado!', 'success');
        setActive(false);
        onConnected?.();
      }
    },
  });

  useEffect(() => {
    if (polling.data?.status) {
      setStatus(polling.data.status);
      if (polling.data.connected) {
        toast('WhatsApp conectado!', 'success');
        setActive(false);
        onConnected?.();
      }
    }
  }, [polling.data, onConnected]);

  async function handleStart() {
    const digits = normalizePhone(phone);
    if (digits.length < 10) {
      toast('Informe o número com DDI, ex.: 5511999999999', 'error');
      return;
    }
    try {
      setActive(true);
      const result = await restart.mutateAsync({ connectionId, phone: digits });
      setPhoneCode(result.phoneCode);
      setStatus(result.status);
      setDetail(result.instructions);
    } catch (err) {
      toast(getErrorMessage(err), 'error');
      setStatus('ERRO');
      setDetail(getErrorMessage(err));
    }
  }

  async function handleRefreshCode() {
    const digits = normalizePhone(phone);
    if (digits.length < 10) return;
    try {
      const r = await requestCode.mutateAsync(digits);
      setPhoneCode(r.code);
      setStatus('AGUARDANDO_LEITURA');
      toast('Novo código gerado.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  if (!active) {
    return (
      <Card className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-bold text-text-primary">Reconectar WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Digite o número para receber um novo código no app.
          </p>
        </div>
        <Input
          label="Número WhatsApp (com DDI)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="5511999999999"
          inputMode="tel"
        />
        <Button
          fullWidth
          loading={restart.isPending}
          disabled={normalizePhone(phone).length < 10}
          onClick={() => void handleStart()}
        >
          Continuar
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-text-primary">Confirme no celular</h2>
          <p className="text-sm text-text-secondary">
            Aparelhos conectados → Conectar com número de telefone
          </p>
        </div>
        {status && <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>}
      </div>

      {detail && <p className="text-xs text-text-secondary">{detail}</p>}

      {phoneCode ? (
        <p className="rounded-2xl bg-primary-light px-4 py-6 text-center text-3xl font-extrabold tracking-[0.35em] text-primary">
          {phoneCode}
        </p>
      ) : restart.isPending || requestCode.isPending ? (
        <Spinner label="Gerando código…" />
      ) : (
        <p className="text-sm text-text-secondary">Código indisponível — gere um novo.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={requestCode.isPending}
          onClick={() => void handleRefreshCode()}
        >
          Gerar novo código
        </Button>
        <Button variant="ghost" onClick={() => setActive(false)}>
          Fechar
        </Button>
      </div>
    </Card>
  );
}
