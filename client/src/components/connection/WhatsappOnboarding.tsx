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
 * Fluxo principal: número → código de pareamento no WhatsApp.
 * QR fica como alternativa. Backend orquestra a Z-API.
 */

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

export function WhatsappOnboarding() {
  const navigate = useNavigate();
  const start = useStartWhatsappConnect();
  const [label, setLabel] = useState('WhatsApp');
  const [phone, setPhone] = useState('');
  const [providerMode, setProviderMode] = useState<'web' | 'phoneless'>('web');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
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

  // Auto-refresh do QR só quando o usuário abriu a alternativa QR.
  useEffect(() => {
    if (!showQr || !connectionId || status === 'CONECTADO' || status === 'ERRO') return;
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
  }, [showQr, connectionId, status, qrAttempts]);

  async function handleStart() {
    const digits = normalizePhone(phone);
    if (digits.length < 10) {
      toast('Informe o número com DDI, ex.: 5511999999999', 'error');
      return;
    }
    try {
      const result = await start.mutateAsync({ label, providerMode, phone: digits });
      setConnectionId(result.connectionId);
      setPhoneCode(result.phoneCode);
      setQrBase64(result.qrBase64);
      setStatus(result.status);
      setDetail(result.instructions);
      setQrAttempts(0);
      if (!result.phoneCode && result.qrBase64) setShowQr(true);
      if (result.phonelessWarning) {
        toast(
          'Modo phoneless: use um número dedicado. Se for o WhatsApp do seu celular, ele pode deslogar.',
          'info',
        );
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      toast(msg, 'error');
      setStatus('ERRO');
      setDetail(msg);
      // Erros de provisionamento: orientar o atalho de credenciais manuais.
      if (
        msg.includes('ZAPI_PARTNER_TOKEN') ||
        msg.includes('Pool vazio') ||
        msg.includes('POOL')
      ) {
        toast('Enquanto o pool/parceiro não está pronto, use Credenciais manuais abaixo.', 'info');
      }
    }
  }

  async function handleRefreshCode() {
    const digits = normalizePhone(phone);
    if (!connectionId || digits.length < 10) return;
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
      setQrAttempts(0);
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
            Informe o número — geramos um código para você digitar no celular.
          </p>
        </div>

        <Input
          label="Número do WhatsApp (com DDI)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="5511999999999"
          inputMode="tel"
          autoComplete="tel"
        />

        <Input
          label="Nome da conexão"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ex.: Loja centro"
        />

        <button
          type="button"
          className="text-left text-xs font-semibold text-primary"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? 'Ocultar opções' : 'Opções avançadas'}
        </button>

        {showAdvanced && (
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
                Mantém o WhatsApp no celular e vincula este atendimento.
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
                Chip só para atendimento. Número pessoal no celular pode deslogar.
              </span>
            </label>
            {providerMode === 'phoneless' && (
              <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
                Prefira um número dedicado à loja no modo phoneless.
              </p>
            )}
          </div>
        )}

        <Button
          fullWidth
          loading={start.isPending}
          disabled={normalizePhone(phone).length < 10}
          onClick={() => void handleStart()}
        >
          Gerar código de conexão
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
              WhatsApp → Aparelhos conectados → Conectar com número de telefone
            </p>
          </div>
          {status && <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>}
        </div>

        {detail && <p className="text-xs text-text-secondary">{detail}</p>}

        {phoneCode ? (
          <p className="rounded-2xl bg-primary-light px-4 py-6 text-center text-3xl font-extrabold tracking-[0.35em] text-primary">
            {phoneCode}
          </p>
        ) : start.isPending || requestCode.isPending ? (
          <Spinner label="Gerando código…" />
        ) : (
          <p className="rounded-xl border border-border px-3 py-4 text-center text-sm text-text-secondary">
            Código indisponível — gere um novo abaixo.
          </p>
        )}

        <ol className="list-decimal space-y-1 pl-5 text-xs text-text-secondary">
          <li>Abra o WhatsApp neste número ({normalizePhone(phone) || '…'})</li>
          <li>Toque em Aparelhos conectados</li>
          <li>Escolha Conectar com número de telefone</li>
          <li>Digite o código acima</li>
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            loading={requestCode.isPending}
            onClick={() => void handleRefreshCode()}
          >
            Gerar novo código
          </Button>
          {status === 'ERRO' && (
            <Button variant="secondary" onClick={() => void handleStart()}>
              Tentar de novo
            </Button>
          )}
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        {!showQr ? (
          <Button variant="ghost" size="sm" onClick={() => void handleShowQr()}>
            Prefiro escanear QR Code
          </Button>
        ) : (
          <>
            <div>
              <h3 className="text-sm font-bold text-text-primary">QR Code</h3>
              <p className="text-xs text-text-secondary">
                WhatsApp → Aparelhos conectados → Conectar um aparelho
              </p>
            </div>
            <div className="flex min-h-[200px] items-center justify-center rounded-2xl border border-border bg-bg p-4">
              {qrBase64 ? (
                <img
                  src={qrBase64}
                  alt="QR Code WhatsApp"
                  className="h-48 w-48 rounded-xl bg-surface object-contain"
                />
              ) : refreshQr.isPending ? (
                <Spinner label="Gerando QR…" />
              ) : (
                <p className="text-sm text-text-secondary">QR indisponível.</p>
              )}
            </div>
            {(status === 'EXPIRADO' || qrAttempts >= 3 || !qrBase64) && (
              <Button
                variant="secondary"
                size="sm"
                loading={refreshQr.isPending}
                onClick={() => void handleShowQr()}
              >
                Atualizar QR
              </Button>
            )}
          </>
        )}
      </Card>

      <Button variant="ghost" onClick={() => navigate('/')}>
        Voltar às conexões
      </Button>
    </div>
  );
}
