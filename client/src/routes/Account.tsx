import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/States';
import { BuildingIcon, KeyIcon, CopyIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import { useMyAccessToken } from '@/hooks/useAccessTokens';
import { toast } from '@/store/appStore';
import { initials } from '@/utils/formatters';
import type { UserRole } from '@/types';

function roleLabel(role: UserRole): string {
  if (role === 'superadmin') return 'Dono da plataforma';
  if (role === 'admin') return 'Administrador';
  return 'Operador';
}

function AccessTokenCard() {
  const { data: token, isLoading } = useMyAccessToken();
  const [revealed, setRevealed] = useState(false);

  function copy(value: string) {
    void navigator.clipboard?.writeText(value).then(
      () => toast('Token de acesso copiado!', 'success'),
      () => toast('Não foi possível copiar — copie manualmente.', 'error'),
    );
  }

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-light text-primary">
          <KeyIcon width={18} height={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-text-primary">Token de acesso</h2>
          <p className="text-xs text-text-secondary">
            A credencial desta empresa no sistema, emitida pelo administrador da plataforma.
          </p>
        </div>
      </div>

      {isLoading ? (
        <Spinner label="Carregando..." />
      ) : token ? (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-border bg-bg p-2">
            <code className="min-w-0 flex-1 break-all text-xs text-text-primary">
              {revealed ? token.token : `${token.token_prefix}${'•'.repeat(12)}`}
            </code>
            <Button size="sm" variant="ghost" onClick={() => setRevealed((v) => !v)}>
              {revealed ? 'Ocultar' : 'Revelar'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copy(token.token)}>
              <CopyIcon width={14} height={14} />
            </Button>
          </div>
          {token.expires_at && (
            <p className="text-[11px] text-text-secondary">
              Expira em {new Date(token.expires_at).toLocaleDateString('pt-BR')}.
            </p>
          )}
        </>
      ) : (
        <p className="rounded-lg bg-bg px-3 py-2 text-xs text-text-secondary">
          Nenhum token ativo ainda. Peça ao administrador da plataforma para gerar o seu.
        </p>
      )}
    </Card>
  );
}

export default function Account() {
  const { user, logout } = useAuth();

  return (
    <>
      <PageHeader title="Conta" subtitle="Perfil e acesso" />

      <div className="flex flex-col gap-4 p-4">
        <Card className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-light text-lg font-bold text-primary">
            {initials(user?.name ?? null)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-text-primary">{user?.name}</p>
            <p className="truncate text-sm text-text-secondary">{user?.email}</p>
            {user && <Badge tone="primary" className="mt-1">{roleLabel(user.role)}</Badge>}
          </div>
        </Card>

        <AccessTokenCard />

        {user?.role === 'superadmin' && (
          <Link to="/admin" className="block">
            <Card className="flex items-center gap-3 transition-colors hover:border-primary/40">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
                <BuildingIcon width={22} height={22} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-text-primary">Painel da plataforma</p>
                <p className="text-xs text-text-secondary">Gerencie as empresas e seus administradores.</p>
              </div>
              <span className="text-text-secondary">›</span>
            </Card>
          </Link>
        )}

        <Button variant="danger" fullWidth onClick={logout}>
          Sair da conta
        </Button>
      </div>
    </>
  );
}
