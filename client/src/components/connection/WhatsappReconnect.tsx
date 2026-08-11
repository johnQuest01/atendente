import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import {
  useConnectStatus,
  useRefreshQr,
  useRequestPhoneCode,
  useRestartWhatsappConnect,
  type OnboardingStatus,
} from '@/hooks/useWhatsappOnboarding';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const STATUS_LABEL: Record<OnboardingStatus, string> = {
  PROVISIONING: 'Preparando…',
  AGUARDANDO_LEITURA: 'Aguardando código',
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

/**
 * Reconexão: número → código (fluxo principal). QR opcional.
 */
export function WhatsappReconnect({
  connectionId,
  onConnected,
}: {
  connectionId: string;
  onConnected?: () => void;
}) {
  const restart = useRestartWhatsappConnect();
  const refreshQr = useRefreshQr(connectionId);
  const requestCode = useRequestPhoneCode(connectionId);
  const [active, setActive] = useState(false);
  const [phone, setPhone] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [qrBase64, setQrBase64] = useState<string | null>(null);
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
        qrBase64?: string | null;
        phoneCode?: string | null;
      };
      if (!p.connectionId || p.connectionId !== connectionId) return;
      if (p.status) setStatus(p.status);
      if (p.detail != null) setDetail(p.detail);
      if (p.qrBase64) setQrBase64(p.qrBase64);
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
      setQrBase64(result.qrBase64);
      setStatus(result.status);
      setDetail(result.instructions);
      if (!result.phoneCode && result.qrBase64) setShowQr(true);
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

  async function handleShowQr() {
    setShowQr(true);
    try {
      const r = await refreshQr.mutateAsync();
      if (r.qrBase64) setQrBase64(r.qrBase64);
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
            Informe o número — geramos um código para digitar no celular.
          </p>
        </div>
        <Input
          label="Número do WhatsApp (com DDI)"
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
          Gerar código de reconexão
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-text-primary">Digite o código no WhatsApp</h2>
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

        <Button
          variant="secondary"
          loading={requestCode.isPending}
          onClick={() => void handleRefreshCode()}
        >
          Gerar novo código
        </Button>
      </Card>

      <Card className="flex flex-col gap-3">
        {!showQr ? (
          <Button variant="ghost" size="sm" onClick={() => void handleShowQr()}>
            Prefiro escanear QR Code
          </Button>
        ) : (
          <>
            <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-border bg-bg p-4">
              {qrBase64 ? (
                <img
                  src={qrBase64}
                  alt="QR Code WhatsApp"
                  className="h-44 w-44 rounded-xl bg-surface object-contain"
                />
              ) : refreshQr.isPending ? (
                <Spinner label="Gerando QR…" />
              ) : (
                <p className="text-sm text-text-secondary">QR indisponível.</p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={refreshQr.isPending}
              onClick={() => void handleShowQr()}
            >
              Atualizar QR
            </Button>
          </>
        )}
      </Card>

      <Button variant="ghost" onClick={() => setActive(false)}>
        Fechar
      </Button>
    </div>
  );
}
