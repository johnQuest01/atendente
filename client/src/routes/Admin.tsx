import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Spinner, EmptyState, ErrorState } from '@/components/ui/States';
import { BuildingIcon, PlusIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import {
  useTenants,
  useCreateTenant,
  useUpdateTenant,
  type TenantSummary,
} from '@/hooks/useTenants';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Painel do DONO DA PLATAFORMA (super-admin): lista, cria e ativa/desativa as
 * empresas (tenants), além de criar o administrador inicial de cada uma.
 */
export default function Admin() {
  const { user } = useAuth();
  const { data: tenants, isLoading, isError, refetch } = useTenants();
  const [creating, setCreating] = useState(false);

  // Só o dono da plataforma acessa (mesmo digitando a URL direto).
  if (user && user.role !== 'superadmin') return <Navigate to="/" replace />;

  return (
    <>
      <PageHeader
        title="Empresas"
        subtitle="Gestão da plataforma"
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon width={18} height={18} />
            Nova empresa
          </Button>
        }
      />

      <div className="flex flex-col gap-3 p-4">
        {isLoading && <Spinner label="Carregando empresas..." />}
        {isError && <ErrorState message="Não foi possível carregar as empresas." onRetry={() => void refetch()} />}

        {tenants && tenants.length === 0 && (
          <EmptyState
            icon={<BuildingIcon width={40} height={40} />}
            title="Nenhuma empresa ainda"
            description="Crie a primeira empresa e o administrador dela."
            action={<Button onClick={() => setCreating(true)}>Criar empresa</Button>}
          />
        )}

        {tenants?.map((t) => (
          <TenantRow key={t.id} tenant={t} />
        ))}
      </div>

      <CreateTenantModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function TenantRow({ tenant }: { tenant: TenantSummary }) {
  const update = useUpdateTenant();

  function toggleActive() {
    update.mutate(
      { id: tenant.id, is_active: !tenant.is_active },
      {
        onSuccess: () =>
          toast(tenant.is_active ? 'Empresa desativada.' : 'Empresa ativada.', 'success'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
        <BuildingIcon width={22} height={22} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-bold text-text-primary">{tenant.name}</p>
          <Badge tone={tenant.is_active ? 'success' : 'neutral'}>
            {tenant.is_active ? 'Ativa' : 'Inativa'}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-text-secondary">
          {tenant.users_count} usuário(s) ·{' '}
          {tenant.has_whatsapp
            ? `WhatsApp: ${tenant.whatsapp_status === 'connected' ? 'conectado' : 'cadastrado'}`
            : 'sem WhatsApp'}
        </p>
      </div>
      <Button
        size="sm"
        variant={tenant.is_active ? 'secondary' : 'primary'}
        loading={update.isPending}
        onClick={toggleActive}
      >
        {tenant.is_active ? 'Desativar' : 'Ativar'}
      </Button>
    </Card>
  );
}

function CreateTenantModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateTenant();
  const [name, setName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  function reset() {
    setName('');
    setAdminName('');
    setAdminEmail('');
    setAdminPassword('');
  }

  function submit() {
    create.mutate(
      { name, adminName, adminEmail, adminPassword },
      {
        onSuccess: () => {
          toast('Empresa criada com o administrador inicial!', 'success');
          reset();
          onClose();
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  const valid =
    name.trim().length >= 2 &&
    adminName.trim().length >= 2 &&
    /.+@.+\..+/.test(adminEmail) &&
    adminPassword.length >= 8;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nova empresa"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!valid}>
            Criar empresa
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Nome da empresa"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Loja da Ana"
        />
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-sm font-semibold text-text-primary">Administrador inicial</p>
          <div className="flex flex-col gap-3">
            <Input
              label="Nome"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="Nome do responsável"
            />
            <Input
              label="E-mail"
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="email@empresa.com"
            />
            <Input
              label="Senha"
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              hint="Mínimo 8 caracteres, com letra e número."
              placeholder="••••••••"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
