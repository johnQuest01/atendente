import { useEffect, useRef, useState } from 'react';
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
  AGUARDANDO_LEITURA: 'Aguardando leitura',
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

/**
 * Reconexão embutida para uma conexão já existente (QR/código no app).
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
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [phoneForCode, setPhoneForCode] = useState('');
  const [qrAttempts, setQrAttempts] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (!active || status === 'CONECTADO' || status === 'ERRO') return;
    if (qrAttempts >= 3) return;

    autoRefreshRef.current = setInterval(() => {
      void refreshQr
        .mutateAsync()
        .then((r) => {
          if (r.qrBase64) setQrBase64(r.qrBase64);
          setQrAttempts((n) => n + 1);
        })
        .catch(() => undefined);
    }, 18_000);

    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status, qrAttempts, connectionId]);

  async function handleStart() {
    try {
      setActive(true);
      const result = await restart.mutateAsync({ connectionId });
      setQrBase64(result.qrBase64);
      setStatus(result.status);
      setDetail(result.instructions);
      setQrAttempts(0);
      if (result.phonelessWarning) {
        toast(
          'Modo phoneless: use um número dedicado. Se for o WhatsApp do seu celular, ele pode deslogar.',
          'info',
        );
      }
    } catch (err) {
      toast(getErrorMessage(err), 'error');
      setStatus('ERRO');
      setDetail(getErrorMessage(err));
    }
  }

  async function handleManualQr() {
    try {
      const r = await refreshQr.mutateAsync();
      if (r.qrBase64) setQrBase64(r.qrBase64);
      setQrAttempts(0);
      setStatus('AGUARDANDO_LEITURA');
      toast('Novo QR gerado.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  async function handlePhoneCode() {
    try {
      const r = await requestCode.mutateAsync(phoneForCode);
      setPhoneCode(r.code);
      toast('Código gerado — digite no WhatsApp do celular.', 'success');
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
            Gere um novo QR neste app — sem abrir o painel da Z-API.
          </p>
        </div>
        <Button fullWidth loading={restart.isPending} onClick={() => void handleStart()}>
          Gerar QR de reconexão
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-text-primary">Escaneie o QR Code</h2>
            <p className="text-sm text-text-secondary">
              WhatsApp → Aparelhos conectados → Conectar um aparelho
            </p>
          </div>
          {status && <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>}
        </div>

        {detail && <p className="text-xs text-text-secondary">{detail}</p>}

        <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-border bg-bg p-4">
          {qrBase64 ? (
            <img
              src={qrBase64}
              alt="QR Code WhatsApp"
              className="h-56 w-56 rounded-xl bg-surface object-contain"
            />
          ) : refreshQr.isPending || restart.isPending ? (
            <Spinner label="Gerando QR…" />
          ) : (
            <p className="text-sm text-text-secondary">QR indisponível — gere um novo abaixo.</p>
          )}
        </div>

        {(status === 'EXPIRADO' || qrAttempts >= 3 || !qrBase64) && (
          <Button
            variant="secondary"
            loading={refreshQr.isPending}
            onClick={() => void handleManualQr()}
          >
            Gerar novo QR
          </Button>
        )}

        {status === 'ERRO' && (
          <Button variant="secondary" onClick={() => void handleStart()}>
            Tentar de novo
          </Button>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Ou conecte com código</h3>
          <p className="text-xs text-text-secondary">
            No WhatsApp: Aparelhos conectados → Conectar com número de telefone.
          </p>
        </div>
        <Input
          label="Número com DDI"
          placeholder="5511999999999"
          value={phoneForCode}
          onChange={(e) => setPhoneForCode(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          loading={requestCode.isPending}
          disabled={!phoneForCode.trim()}
          onClick={() => void handlePhoneCode()}
        >
          Gerar código
        </Button>
        {phoneCode && (
          <p className="rounded-xl bg-primary-light px-4 py-3 text-center text-2xl font-extrabold tracking-widest text-primary">
            {phoneCode}
          </p>
        )}
      </Card>

      <Button variant="ghost" onClick={() => setActive(false)}>
        Fechar
      </Button>
    </div>
  );
}
