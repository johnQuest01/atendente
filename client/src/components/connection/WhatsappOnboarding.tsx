import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import {
  useConnectStatus,
  useRequestPhoneCode,
  useStartWhatsappConnect,
  type OnboardingStatus,
} from '@/hooks/useWhatsappOnboarding';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Fluxo provisório simples (cliente nunca vê Z-API):
 * 1) Digita o número
 * 2) Backend pega instância paga do pool (sem número)
 * 3) Mostra código → cliente digita no WhatsApp → conectado
 */

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

export function WhatsappOnboarding() {
  const navigate = useNavigate();
  const start = useStartWhatsappConnect();
  const [phone, setPhone] = useState('');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

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
        phoneCode?: string | null;
      };
      if (!p.connectionId || p.connectionId !== connectionId) return;
      if (p.status) setStatus(p.status);
      if (p.detail != null) setDetail(p.detail);
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

  async function handleStart() {
    const digits = normalizePhone(phone);
    if (digits.length < 10) {
      toast('Informe o número com DDI, ex.: 5511999999999', 'error');
      return;
    }
    try {
      const result = await start.mutateAsync({
        label: `WhatsApp ${digits.slice(-4)}`,
        providerMode: 'web',
        phone: digits,
      });
      setConnectionId(result.connectionId);
      setPhoneCode(result.phoneCode);
      setStatus(result.status);
      setDetail(result.instructions);
      if (!result.phoneCode) {
        toast(
          'Não foi possível gerar o código agora. Tente de novo em instantes.',
          'error',
        );
      }
    } catch (err) {
      toast(getErrorMessage(err), 'error');
      setStatus('ERRO');
      setDetail(getErrorMessage(err));
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

  if (!connectionId) {
    return (
      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-bold text-text-primary">Conectar WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Digite o número. Em seguida aparece um código para você confirmar no celular.
          </p>
        </div>

        <Input
          label="Seu número WhatsApp (com DDI)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="5511999999999"
          inputMode="tel"
          autoComplete="tel"
        />

        <Button
          fullWidth
          loading={start.isPending}
          disabled={normalizePhone(phone).length < 10}
          onClick={() => void handleStart()}
        >
          Continuar
        </Button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-text-primary">Confirme no celular</h2>
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
          Código indisponível — toque em gerar novo.
        </p>
      )}

      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
        <li>Abra o WhatsApp deste número</li>
        <li>Menu → Aparelhos conectados</li>
        <li>Conectar com número de telefone</li>
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
        <Button variant="ghost" onClick={() => navigate('/')}>
          Voltar
        </Button>
      </div>
    </Card>
  );
}
