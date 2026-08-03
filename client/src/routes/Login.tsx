import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState('');

  if (isAuthenticated) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const ok = await login(email.trim(), password);
    setLoading(false);
    if (ok) navigate('/', { replace: true });
  }

  /**
   * Criar conta por token: leva para a página de convite, que valida o token e
   * abre o cadastro. Aceita o token puro OU o link inteiro (extrai o que vem
   * depois de /convite/), para o convidado poder colar qualquer um dos dois.
   */
  function goToRegister(e: FormEvent) {
    e.preventDefault();
    const raw = inviteCode.trim();
    if (!raw) return;
    const match = raw.match(/\/convite\/([^/?#\s]+)/i);
    const token = match ? match[1] : raw;
    navigate(`/convite/${encodeURIComponent(token)}`);
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg bg-app-radial px-6">
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
          <Input
            label="E-mail"
            type="email"
            autoComplete="email"
            placeholder="seu@email.com"
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
          onSubmit={goToRegister}
          className="glass flex flex-col gap-3 rounded-3xl p-6 shadow-card-hover"
        >
          <div>
            <h2 className="text-sm font-bold text-text-primary">Criar conta com token</h2>
            <p className="text-xs text-text-secondary">
              Recebeu um token de acesso? Cole abaixo para criar sua conta e começar o teste.
            </p>
          </div>
          <Input
            label="Token de acesso"
            placeholder="Cole aqui o token que você recebeu"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            fullWidth
            disabled={!inviteCode.trim()}
          >
            Criar conta
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-text-secondary">
          O acesso é só por convite — peça um token ao administrador.
        </p>
      </div>
    </div>
  );
}
