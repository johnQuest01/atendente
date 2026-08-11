import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import {
  useConnectStatus,
  useRefreshQr,
  useRequestPhoneCode,
  useStartWhatsappConnect,
  type OnboardingStatus,
} from '@/hooks/useWhatsappOnboarding';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Onboarding embutido: o cliente só vê nosso app (QR/código).
 * Backend orquestra Z-API (Partner-Token) — nunca expõe o painel dela.
 */

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

export function WhatsappOnboarding() {
  const navigate = useNavigate();
  const start = useStartWhatsappConnect();
  const [label, setLabel] = useState('WhatsApp');
  const [providerMode, setProviderMode] = useState<'web' | 'phoneless'>('web');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [phoneForCode, setPhoneForCode] = useState('');
  const [qrAttempts, setQrAttempts] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshQr = useRefreshQr(connectionId ?? undefined);
  const requestCode = useRequestPhoneCode(connectionId ?? undefined);
  const polling = useConnectStatus(
    connectionId ?? undefined,
    Boolean(connectionId) && status !== 'CONECTADO' && status !== 'ERRO',
  );

  useSocket({
    'whatsapp:status': (payload: unknown) => {
      const p = payload as {
        connectionId?: string;
        status?: OnboardingStatus;
        detail?: string | null;
        qrBase64?: string | null;
        phoneCode?: string | null;
        phone?: string | null;
      };
      if (!p.connectionId || p.connectionId !== connectionId) return;
      if (p.status) setStatus(p.status);
      if (p.detail != null) setDetail(p.detail);
      if (p.qrBase64) setQrBase64(p.qrBase64);
      if (p.phoneCode) setPhoneCode(p.phoneCode);
      if (p.status === 'CONECTADO') {
        toast('WhatsApp conectado!', 'success');
        navigate(`/conexoes/${p.connectionId}`);
      }
    },
  });

  useEffect(() => {
    if (polling.data?.status) {
      setStatus(polling.data.status);
      if (polling.data.connected) {
        toast('WhatsApp conectado!', 'success');
        navigate(`/conexoes/${polling.data.connectionId}`);
      }
    }
  }, [polling.data, navigate]);

  // Auto-refresh do QR a cada ~18s, no máx. 3 vezes (recomendação Z-API).
  useEffect(() => {
    if (!connectionId || status === 'CONECTADO' || status === 'ERRO') return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só reage a conexão/status/tentativas
  }, [connectionId, status, qrAttempts]);

  async function handleStart() {
    try {
      const result = await start.mutateAsync({ label, providerMode });
      setConnectionId(result.connectionId);
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

  if (!connectionId) {
    return (
      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">Conectar WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Em poucos passos o número fica ligado ao atendimento — sem abrir o painel da Z-API.
          </p>
        </div>

        <Input
          label="Nome da conexão"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ex.: Loja centro"
        />

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-text-primary">Tipo de conexão</p>
          <label className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
            <input
              type="radio"
              name="mode"
              checked={providerMode === 'web'}
              onChange={() => setProviderMode('web')}
              className="mt-1 accent-primary"
            />
            <span className="text-sm text-text-secondary">
              <strong className="text-text-primary">Aparelhos conectados (recomendado)</strong>
              <br />
              Mantém o WhatsApp no celular e adiciona este atendimento como aparelho vinculado.
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-xl border border-border px-3 py-2">
            <input
              type="radio"
              name="mode"
              checked={providerMode === 'phoneless'}
              onChange={() => setProviderMode('phoneless')}
              className="mt-1 accent-primary"
            />
            <span className="text-sm text-text-secondary">
              <strong className="text-text-primary">Número dedicado (phoneless)</strong>
              <br />
              Use um chip/número só para o atendimento. Se for o WhatsApp pessoal do celular, a
              sessão do aparelho pode deslogar.
            </span>
          </label>
        </div>

        {providerMode === 'phoneless' && (
          <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
            Aviso: no modo phoneless, conectar o mesmo número que você usa no celular pode
            desconectar o WhatsApp do aparelho. Prefira um número dedicado à loja.
          </p>
        )}

        <Button fullWidth loading={start.isPending} onClick={() => void handleStart()}>
          Criar conexão e mostrar QR
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
          ) : refreshQr.isPending || start.isPending ? (
            <Spinner label="Gerando QR…" />
          ) : (
            <p className="text-sm text-text-secondary">QR indisponível — gere um novo abaixo.</p>
          )}
        </div>

        {(status === 'EXPIRADO' || qrAttempts >= 3) && (
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

      <Button variant="ghost" onClick={() => navigate('/')}>
        Voltar às conexões
      </Button>
    </div>
  );
}
