import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Spinner, EmptyState, ErrorState } from '@/components/ui/States';
import { BuildingIcon, PlusIcon, EditIcon, KeyIcon, CopyIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import {
  useTenants,
  useCreateTenant,
  useUpdateTenant,
  useDeleteTenant,
  type TenantSummary,
} from '@/hooks/useTenants';
import { useInvites, useCreateInvite, useRevokeInvite, inviteStatus } from '@/hooks/useInvites';
import {
  useTenantTokens,
  useGenerateToken,
  useRevokeToken,
  type AccessTokenReveal,
} from '@/hooks/useAccessTokens';
import { AiProvidersManager } from '@/components/ai/AiProvidersManager';
import { InstancePoolManager } from '@/components/admin/InstancePoolManager';
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

        <div className="mt-4 border-t border-border pt-4">
          <InvitesManager />
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <InstancePoolManager />
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <AiProvidersManager scope="global" />
        </div>
      </div>

      <CreateTenantModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/** Quanto falta do teste, em linguagem de gente. */
function trialLabel(trialEndsAt: string | null): { text: string; expired: boolean } | null {
  if (!trialEndsAt) return null;
  const ends = Date.parse(trialEndsAt);
  if (Number.isNaN(ends)) return null;
  const days = Math.ceil((ends - Date.now()) / 86_400_000);
  if (days <= 0) return { text: 'Teste vencido', expired: true };
  return { text: `Teste: ${days} dia${days > 1 ? 's' : ''}`, expired: false };
}

/**
 * Convites de acesso. Sem gateway de pagamento, é assim que um cliente novo
 * entra: gera-se o link, ele cria a conta e o teste começa no aceite.
 */
function InvitesManager() {
  const { data: invites, isLoading } = useInvites();
  const create = useCreateInvite();
  const revoke = useRevokeInvite();

  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [trialDays, setTrialDays] = useState('14');

  function copy(url: string) {
    void navigator.clipboard?.writeText(url).then(
      () => toast('Link do convite copiado!', 'success'),
      () => toast('Não foi possível copiar — copie manualmente.', 'error'),
    );
  }

  function submit() {
    create.mutate(
      {
        email: email.trim() || undefined,
        companyName: companyName.trim() || undefined,
        trialDays: Math.max(1, Number(trialDays) || 14),
        expiresInDays: 14,
      },
      {
        onSuccess: ({ url }) => {
          setEmail('');
          setCompanyName('');
          copy(url);
          toast('Convite criado — link copiado.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Convites de acesso</h2>
        <p className="text-sm text-text-secondary">
          Gere um link para o cliente criar a própria conta e testar com o WhatsApp dele.
        </p>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
        <Input
          label="E-mail do convidado (opcional)"
          type="email"
          placeholder="Deixe vazio para um link aberto"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Nome sugerido da empresa (opcional)"
          placeholder="Ex.: Distribuidora Alfa"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />
        <Input
          label="Dias de teste"
          type="number"
          min={1}
          max={365}
          value={trialDays}
          onChange={(e) => setTrialDays(e.target.value)}
        />
        <Button size="sm" onClick={submit} loading={create.isPending}>
          <PlusIcon width={16} height={16} />
          Gerar convite
        </Button>
      </div>

      {isLoading && <Spinner label="Carregando convites..." />}
      {invites && invites.length === 0 && (
        <p className="text-xs text-text-secondary">Nenhum convite gerado ainda.</p>
      )}

      {invites?.map((inv) => {
        const st = inviteStatus(inv);
        return (
          <div key={inv.id} className="flex flex-col gap-1.5 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2">
              <Badge tone={st === 'open' ? 'success' : st === 'used' ? 'neutral' : 'danger'}>
                {st === 'open' ? 'Aberto' : st === 'used' ? 'Usado' : 'Expirado'}
              </Badge>
              <p className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                {inv.tenant_name ?? inv.company_name ?? inv.email ?? 'Link aberto'} ·{' '}
                {inv.trial_days} dias de teste
              </p>
            </div>
            {st === 'open' && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs text-text-primary">
                  {inv.url}
                </code>
                <Button size="sm" variant="secondary" onClick={() => copy(inv.url)}>
                  Copiar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(inv.id, {
                      onSuccess: () => toast('Convite revogado.', 'success'),
                      onError: (err) => toast(getErrorMessage(err), 'error'),
                    })
                  }
                >
                  Revogar
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function TenantRow({ tenant }: { tenant: TenantSummary }) {
  const update = useUpdateTenant();
  const remove = useDeleteTenant();
  const [editingLimit, setEditingLimit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  function confirmRemove() {
    remove.mutate(tenant.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        toast(`Empresa "${tenant.name}" removida.`, 'success');
      },
      onError: (err) => toast(getErrorMessage(err), 'error'),
    });
  }

  const limitTxt =
    tenant.ai_message_limit == null
      ? 'IA: ilimitada'
      : `IA: ${tenant.ai_used}/${tenant.ai_message_limit} no mês`;
  const overLimit = tenant.ai_message_limit != null && tenant.ai_used >= tenant.ai_message_limit;
  const trial = trialLabel(tenant.trial_ends_at);

  /** Estende a partir de HOJE — não do vencimento, que pode ter passado faz tempo. */
  function extendTrial(days: number | null) {
    const trial_ends_at = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    update.mutate(
      { id: tenant.id, trial_ends_at },
      {
        onSuccess: () =>
          toast(days === null ? 'Acesso liberado sem prazo.' : `Teste estendido por ${days} dias.`, 'success'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
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
        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <Button
            size="sm"
            variant={tenant.is_active ? 'secondary' : 'primary'}
            loading={update.isPending}
            onClick={toggleActive}
          >
            {tenant.is_active ? 'Desativar' : 'Ativar'}
          </Button>
          {tenant.can_delete === true && (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              Remover
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <Badge tone={overLimit ? 'danger' : 'neutral'}>{limitTxt}</Badge>
        <Button size="sm" variant="ghost" onClick={() => setEditingLimit(true)}>
          <EditIcon width={15} height={15} />
          Limite de IA
        </Button>
      </div>

      {trial && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <Badge tone={trial.expired ? 'danger' : 'neutral'}>{trial.text}</Badge>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => extendTrial(30)}>
              +30 dias
            </Button>
            <Button size="sm" variant="ghost" loading={update.isPending} onClick={() => extendTrial(null)}>
              Sem prazo
            </Button>
          </div>
        </div>
      )}

      <AccessTokenManager tenantId={tenant.id} tenantName={tenant.name} />

      <TenantLimitModal
        open={editingLimit}
        onClose={() => setEditingLimit(false)}
        tenant={tenant}
      />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Remover empresa?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>
              Cancelar
            </Button>
            <Button variant="primary" loading={remove.isPending} onClick={confirmRemove}>
              Remover de vez
            </Button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          Isso apaga <strong>{tenant.name}</strong> e tudo ligado a ela: usuários, WhatsApp,
          conversas, produtos e configurações. Instâncias do pool voltam a ficar livres. Não dá
          para desfazer.
        </p>
      </Modal>
    </Card>
  );
}

/** Como o token aparece em texto para copiar. */
function copyText(text: string, ok: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast(ok, 'success'),
    () => toast('Não foi possível copiar — copie manualmente.', 'error'),
  );
}

/**
 * Token de acesso da empresa (por tenant). Só o superadmin gera/revoga. Ao gerar,
 * o valor aparece UMA vez num modal copiável; depois fica identificado por prefixo,
 * com "revelar" para reexibir (decifra no servidor).
 */
function AccessTokenManager({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useTenantTokens(tenantId, open);
  const generate = useGenerateToken();
  const revoke = useRevokeToken();
  const [justCreated, setJustCreated] = useState<AccessTokenReveal | null>(null);
  const [revealed, setRevealed] = useState(false);

  const active = data?.active ?? null;

  function doGenerate() {
    generate.mutate(
      { tenantId },
      {
        onSuccess: (token) => {
          setJustCreated(token);
          setRevealed(false);
          toast('Token gerado — copie agora, ele só aparece uma vez aqui.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <KeyIcon width={14} height={14} />
          Token de acesso
        </span>
        <Badge tone={active ? 'success' : 'neutral'}>
          {active ? `${active.token_prefix}…` : 'nenhum'}
        </Badge>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {isLoading && <Spinner label="Carregando token..." />}

          {active && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg p-2">
              <code className="min-w-0 flex-1 truncate text-xs text-text-primary">
                {revealed ? active.token : `${active.token_prefix}${'•'.repeat(10)}`}
              </code>
              <Button size="sm" variant="ghost" onClick={() => setRevealed((v) => !v)}>
                {revealed ? 'Ocultar' : 'Revelar'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => copyText(active.token, 'Token copiado!')}
              >
                <CopyIcon width={14} height={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={revoke.isPending}
                onClick={() =>
                  revoke.mutate(
                    { id: active.id, tenantId },
                    {
                      onSuccess: () => toast('Token revogado.', 'success'),
                      onError: (err) => toast(getErrorMessage(err), 'error'),
                    },
                  )
                }
              >
                Revogar
              </Button>
            </div>
          )}

          <Button size="sm" variant={active ? 'secondary' : 'primary'} loading={generate.isPending} onClick={doGenerate}>
            <KeyIcon width={15} height={15} />
            {active ? 'Gerar novo (revoga o atual)' : 'Gerar token de acesso'}
          </Button>
          <p className="text-[11px] leading-snug text-text-secondary">
            Entregue este token ao responsável de <strong>{tenantName}</strong>. Ele vê o mesmo token
            no painel (Configurações) depois de logar. Só existe um token ativo por empresa.
          </p>
        </div>
      )}

      <Modal
        open={Boolean(justCreated)}
        onClose={() => setJustCreated(null)}
        title="Token gerado"
        footer={
          <div className="flex justify-end">
            <Button onClick={() => setJustCreated(null)}>Fechar</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Copie agora e guarde. Por segurança ele fica cifrado; você pode reexibi-lo depois em
            “Revelar”, mas é mais seguro copiar já.
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg p-2">
            <code className="min-w-0 flex-1 break-all text-xs text-text-primary">
              {justCreated?.token}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => justCreated && copyText(justCreated.token, 'Token copiado!')}
            >
              <CopyIcon width={14} height={14} />
              Copiar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TenantLimitModal({
  open,
  onClose,
  tenant,
}: {
  open: boolean;
  onClose: () => void;
  tenant: TenantSummary;
}) {
  const update = useUpdateTenant();
  const [unlimited, setUnlimited] = useState(tenant.ai_message_limit == null);
  const [value, setValue] = useState(String(tenant.ai_message_limit ?? 1000));

  // Re-sincroniza com o valor atual sempre que o modal abre.
  useEffect(() => {
    if (!open) return;
    setUnlimited(tenant.ai_message_limit == null);
    setValue(String(tenant.ai_message_limit ?? 1000));
  }, [open, tenant.ai_message_limit]);

  function submit() {
    const ai_message_limit = unlimited ? null : Math.max(0, Number(value) || 0);
    update.mutate(
      { id: tenant.id, ai_message_limit },
      {
        onSuccess: () => {
          toast('Limite de IA atualizado.', 'success');
          onClose();
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Limite de IA — ${tenant.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={update.isPending}>
            Salvar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-secondary">
          Teto mensal de mensagens de IA pagas pela plataforma. Ao atingir, a IA padrão para de
          responder para esta empresa — ela pode conectar a própria chave para continuar sem limite.
          Uso no mês: <strong>{tenant.ai_used}</strong>.
        </p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={unlimited}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          <span className="text-sm text-text-primary">Ilimitado</span>
        </label>
        {!unlimited && (
          <Input
            label="Limite mensal (mensagens)"
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Ex.: 1000"
          />
        )}
      </div>
    </Modal>
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

