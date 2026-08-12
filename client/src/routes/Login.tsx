import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { api, getErrorMessage } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { reauthSocket } from '@/hooks/useSocket';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/store/appStore';
import type { User } from '@/types';

interface AcceptResponse {
  token: string;
  user: User;
  tenant: { id: string; name: string; trialEndsAt: string | null };
}

function extractInviteToken(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/\/convite\/([^/?#\s]+)/i);
  return match ? match[1] : trimmed;
}

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registering, setRegistering] = useState(false);

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const ok = await login(email.trim(), password);
    setLoading(false);
    if (ok) navigate('/', { replace: true });
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    const token = extractInviteToken(inviteToken);
    if (!token) {
      toast('Cole o token de convite que você recebeu.', 'error');
      return;
    }
    setRegistering(true);
    try {
      const { data } = await api.post<AcceptResponse>(`/invites/${encodeURIComponent(token)}/accept`, {
        adminName: fullName.trim(),
        adminEmail: registerEmail.trim(),
        adminPhone: phone.trim(),
        adminPassword: registerPassword,
      });
      setAuth(data.user, data.token);
      reauthSocket();
      toast('Conta criada! Agora conecte seu WhatsApp.', 'success');
      navigate('/', { replace: true });
    } catch (err) {
      toast(getErrorMessage(err, 'Não foi possível criar a conta. Confira o token de convite.'), 'error');
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg bg-app-radial px-6 py-10">
      <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative w-full max-w-sm animate-scale-in">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-gradient text-2xl font-black text-white shadow-glow">
            IA
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">Agente de IA</h1>
            <p className="text-sm text-text-secondary">Atendimento inteligente no WhatsApp</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="glass flex flex-col gap-4 rounded-3xl p-6 shadow-card-hover"
        >
          <h2 className="text-sm font-bold text-text-primary">Já tenho conta</h2>
          <Input
            label="E-mail"
            type="email"
            autoComplete="email"
            placeholder="seu@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label="Senha"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" size="lg" loading={loading} fullWidth>
            Entrar
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-text-secondary">ou</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <form
          onSubmit={handleRegister}
          className="glass flex flex-col gap-3 rounded-3xl p-6 shadow-card-hover"
        >
          <div>
            <h2 className="text-sm font-bold text-text-primary">Criar conta com convite</h2>
            <p className="text-xs text-text-secondary">
              Preencha seus dados e o <strong>token de convite</strong> que você recebeu para ter
              acesso.
            </p>
          </div>
          <Input
            label="Nome completo"
            autoComplete="name"
            placeholder="Seu nome completo"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
          <Input
            label="Telefone (WhatsApp)"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="11 99999-9999"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <Input
            label="E-mail (Gmail)"
            type="email"
            autoComplete="email"
            placeholder="seu@gmail.com"
            value={registerEmail}
            onChange={(e) => setRegisterEmail(e.target.value)}
            required
          />
          <Input
            label="Token de convite"
            placeholder="Cole aqui o token ou o link /convite/..."
            value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)}
            required
          />
          <Input
            label="Senha"
            type="password"
            autoComplete="new-password"
            placeholder="Mínimo 8 caracteres, com letra e número"
            value={registerPassword}
            onChange={(e) => setRegisterPassword(e.target.value)}
            required
          />
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            fullWidth
            loading={registering}
            disabled={
              !fullName.trim() ||
              !phone.trim() ||
              !registerEmail.trim() ||
              !inviteToken.trim() ||
              !registerPassword
            }
          >
            Criar conta e entrar
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-text-secondary">
          O acesso é só por <strong>token de convite</strong> — peça um ao administrador.
        </p>
      </div>
    </div>
  );
}
