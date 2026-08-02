import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getErrorMessage } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { reauthSocket } from '@/hooks/useSocket';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import { toast } from '@/store/appStore';
import type { User } from '@/types';

/**
 * Página pública do convite. Quem chega aqui ainda não tem conta: valida o
 * link, cria a empresa com o período de teste e já entra no painel.
 */

interface InvitePreview {
  valid: boolean;
  reason?: 'used' | 'expired';
  companyName?: string | null;
  email?: string | null;
  trialDays?: number;
  expiresAt?: string;
}

interface AcceptResponse {
  token: string;
  user: User;
  tenant: { id: string; name: string; trialEndsAt: string | null };
}

export default function AcceptInvite() {
  const { token: inviteToken } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<InvitePreview>(`/invites/${inviteToken}`)
      .then(({ data }) => {
        if (!alive) return;
        setPreview(data);
        if (data.companyName) setCompanyName(data.companyName);
        if (data.email) setAdminEmail(data.email);
      })
      .catch((err) => {
        if (alive) setLoadError(getErrorMessage(err, 'Convite não encontrado.'));
      });
    return () => {
      alive = false;
    };
  }, [inviteToken]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { data } = await api.post<AcceptResponse>(`/invites/${inviteToken}/accept`, {
        companyName: companyName.trim(),
        adminName: adminName.trim(),
        adminEmail: adminEmail.trim(),
        adminPassword,
      });
      setAuth(data.user, data.token);
      reauthSocket();
      toast(`Bem-vindo! Seu teste começou agora.`, 'success');
      navigate('/', { replace: true });
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const invalidMessage =
    loadError ??
    (preview && !preview.valid
      ? preview.reason === 'used'
        ? 'Este convite já foi utilizado. Se a conta é sua, entre pelo login.'
        : 'Este convite expirou. Peça um link novo para quem te convidou.'
      : null);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg bg-app-radial px-6 py-10">
      <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative w-full max-w-sm animate-scale-in">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-gradient text-2xl font-black text-white shadow-glow">
            IA
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">
              Crie sua conta
            </h1>
            <p className="text-sm text-text-secondary">
              {preview?.valid && preview.trialDays
                ? `Você tem ${preview.trialDays} dias para testar o atendente com o seu WhatsApp.`
                : 'Atendimento inteligente no WhatsApp'}
            </p>
          </div>
        </div>

        {!preview && !loadError ? (
          <div className="flex justify-center py-10">
            <Spinner label="Validando convite..." />
          </div>
        ) : invalidMessage ? (
          <div className="glass flex flex-col gap-4 rounded-3xl p-6 text-center shadow-card-hover">
            <p className="text-sm text-text-secondary">{invalidMessage}</p>
            <Button variant="secondary" onClick={() => navigate('/login')} fullWidth>
              Ir para o login
            </Button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="glass flex flex-col gap-4 rounded-3xl p-6 shadow-card-hover"
          >
            <Input
              label="Nome da empresa"
              placeholder="Ex.: Distribuidora Alfa"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
            />
            <Input
              label="Seu nome"
              autoComplete="name"
              placeholder="Como devemos te chamar"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              required
            />
            <Input
              label="E-mail"
              type="email"
              autoComplete="email"
              placeholder="seu@email.com"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              // Convite endereçado: o e-mail é parte do convite, não é escolha.
              disabled={Boolean(preview?.email)}
              required
            />
            <Input
              label="Senha"
              type="password"
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres, com letra e número"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              required
            />
            <Button type="submit" size="lg" loading={submitting} fullWidth>
              Criar conta e começar
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-xs text-text-secondary">
          Ao criar a conta você poderá conectar seu próprio número de WhatsApp e testar o atendente
          com seus clientes.
        </p>
      </div>
    </div>
  );
}
