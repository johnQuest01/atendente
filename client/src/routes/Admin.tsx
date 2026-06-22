import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner, EmptyState, ErrorState } from '@/components/ui/States';
import { BuildingIcon, PlusIcon, SparklesIcon, EditIcon, TrashIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import {
  useTenants,
  useCreateTenant,
  useUpdateTenant,
  type TenantSummary,
} from '@/hooks/useTenants';
import {
  useAiProviders,
  useCreateAiProvider,
  useUpdateAiProvider,
  useDeleteAiProvider,
  useTestAiCreds,
  useTestSavedAiProvider,
  type AiKind,
  type AiProviderDto,
} from '@/hooks/useAiProviders';
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
          <AiProvidersSection />
        </div>
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

const KIND_LABEL: Record<AiKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI-compatível',
  gemini: 'Google',
};

interface AiPreset {
  id: string;
  kind: AiKind;
  label: string;
  baseUrl: string;
  model: string;
  free?: boolean;
}

// Atalhos para preencher os campos. O failover funciona com qualquer combinação.
const AI_PRESETS: AiPreset[] = [
  { id: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: '', model: 'claude-sonnet-4-6' },
  { id: 'gemini', kind: 'gemini', label: 'Gemini', baseUrl: '', model: 'gemini-1.5-flash', free: true },
  { id: 'groq', kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', free: true },
  { id: 'openai', kind: 'openai', label: 'ChatGPT', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', kind: 'openai', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', free: true },
  { id: 'custom', kind: 'openai', label: 'Personalizado', baseUrl: '', model: '' },
];

function statusBadge(p: AiProviderDto) {
  if (!p.is_active) return <Badge tone="neutral">Inativa</Badge>;
  if (p.in_cooldown) return <Badge tone="warning">Em cooldown</Badge>;
  if (p.last_status === 'ok') return <Badge tone="success">OK</Badge>;
  if (p.last_status) return <Badge tone="danger">{p.last_status}</Badge>;
  return <Badge tone="neutral">Não usada</Badge>;
}

function AiProvidersSection() {
  const { data: providers, isLoading, isError, refetch } = useAiProviders();
  const [modal, setModal] = useState<AiProviderDto | 'new' | null>(null);

  const nextPriority =
    providers && providers.length > 0 ? Math.max(...providers.map((p) => p.priority)) + 10 : 0;

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary">
            <SparklesIcon width={16} height={16} /> Inteligência Artificial
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Tentadas na ordem de prioridade. Se a cota/token de uma acabar, o sistema troca
            automaticamente para a próxima (failover) — a automação nunca para.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setModal('new')}>
          <PlusIcon width={18} height={18} />
          Adicionar
        </Button>
      </div>

      {isLoading && <Spinner label="Carregando provedores de IA..." />}
      {isError && (
        <ErrorState message="Não foi possível carregar os provedores de IA." onRetry={() => void refetch()} />
      )}

      {providers && providers.length === 0 && (
        <Card>
          <p className="text-sm text-text-secondary">
            Nenhuma IA cadastrada. Adicione uma (ex.: Claude, Gemini ou Groq) para ligar as respostas
            automáticas — e cadastre mais de uma para o failover.
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {providers?.map((p) => (
          <AiProviderRow key={p.id} provider={p} onEdit={() => setModal(p)} />
        ))}
      </div>

      <AiProviderModal
        open={modal !== null}
        onClose={() => setModal(null)}
        provider={modal && modal !== 'new' ? modal : undefined}
        suggestedPriority={nextPriority}
      />
    </div>
  );
}

function AiProviderRow({ provider, onEdit }: { provider: AiProviderDto; onEdit: () => void }) {
  const update = useUpdateAiProvider();
  const del = useDeleteAiProvider();
  const test = useTestSavedAiProvider();

  function toggleActive() {
    update.mutate(
      { id: provider.id, isActive: !provider.is_active },
      { onError: (err) => toast(getErrorMessage(err), 'error') },
    );
  }

  function runTest() {
    test.mutate(provider.id, {
      onSuccess: (r) => toast(r.detail, r.ok ? 'success' : 'error'),
      onError: (err) => toast(getErrorMessage(err), 'error'),
    });
  }

  function remove() {
    if (!window.confirm(`Remover "${provider.label}" da cadeia de IA?`)) return;
    del.mutate(provider.id, {
      onSuccess: () => toast('Provedor removido.', 'success'),
      onError: (err) => toast(getErrorMessage(err), 'error'),
    });
  }

  const showError = provider.is_active && provider.last_status && provider.last_status !== 'ok' && provider.last_error;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
          <SparklesIcon width={20} height={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-bold text-text-primary">{provider.label}</p>
            <Badge tone="primary">#{provider.priority}</Badge>
            {statusBadge(provider)}
          </div>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {KIND_LABEL[provider.kind]} · {provider.model}
            {provider.key_masked ? ` · chave ${provider.key_masked}` : ' · sem chave'}
          </p>
        </div>
        <Toggle checked={provider.is_active} onChange={toggleActive} disabled={update.isPending} label="Ativa" />
      </div>

      {showError && (
        <p className="rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">{provider.last_error}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" loading={test.isPending} onClick={runTest}>
          Testar
        </Button>
        <Button size="sm" variant="secondary" onClick={onEdit}>
          <EditIcon width={16} height={16} />
          Editar
        </Button>
        <Button size="sm" variant="ghost" loading={del.isPending} onClick={remove} aria-label="Remover">
          <TrashIcon width={16} height={16} />
        </Button>
      </div>
    </Card>
  );
}

function AiProviderModal({
  open,
  onClose,
  provider,
  suggestedPriority,
}: {
  open: boolean;
  onClose: () => void;
  provider?: AiProviderDto;
  suggestedPriority: number;
}) {
  const isEdit = Boolean(provider);
  const create = useCreateAiProvider();
  const update = useUpdateAiProvider();
  const testCreds = useTestAiCreds();

  const [presetId, setPresetId] = useState('claude');
  const [kind, setKind] = useState<AiKind>('anthropic');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (provider) {
      setKind(provider.kind);
      setLabel(provider.label);
      setModel(provider.model);
      setBaseUrl(provider.base_url ?? '');
      setApiKey('');
      setPriority(provider.priority);
      setIsActive(provider.is_active);
    } else {
      const p = AI_PRESETS[0];
      setPresetId(p.id);
      setKind(p.kind);
      setLabel(p.label);
      setModel(p.model);
      setBaseUrl(p.baseUrl);
      setApiKey('');
      setPriority(suggestedPriority);
      setIsActive(true);
    }
  }, [open, provider, suggestedPriority]);

  function applyPreset(id: string) {
    setPresetId(id);
    const p = AI_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    setLabel(p.label);
    setModel(p.model);
    setBaseUrl(p.baseUrl);
  }

  const canSubmit =
    label.trim().length >= 2 && model.trim().length >= 1 && (isEdit || apiKey.trim().length >= 1);
  const saving = create.isPending || update.isPending;

  function runTest() {
    if (apiKey.trim().length < 1) {
      toast('Informe a chave para testar.', 'error');
      return;
    }
    testCreds.mutate(
      { kind, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined, model: model.trim() },
      {
        onSuccess: (r) => toast(r.detail, r.ok ? 'success' : 'error'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  function submit() {
    if (provider) {
      update.mutate(
        {
          id: provider.id,
          label: label.trim(),
          model: model.trim(),
          baseUrl: baseUrl.trim() || null,
          priority,
          isActive,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
        {
          onSuccess: () => {
            toast('Provedor atualizado.', 'success');
            onClose();
          },
          onError: (err) => toast(getErrorMessage(err), 'error'),
        },
      );
    } else {
      create.mutate(
        {
          kind,
          label: label.trim(),
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          model: model.trim(),
          priority,
          isActive,
        },
        {
          onSuccess: () => {
            toast('IA adicionada à cadeia!', 'success');
            onClose();
          },
          onError: (err) => toast(getErrorMessage(err), 'error'),
        },
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Editar ${provider?.label ?? 'IA'}` : 'Adicionar IA'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSubmit}>
            {isEdit ? 'Salvar' : 'Adicionar'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {!isEdit && (
          <Select label="Provedor" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            {AI_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.free ? ' (cota grátis)' : ''}
              </option>
            ))}
          </Select>
        )}
        <Input
          label="Nome (rótulo)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ex.: Claude, Gemini..."
        />
        <Input
          label="Modelo"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Ex.: gemini-1.5-flash"
        />
        {kind !== 'anthropic' && (
          <Input
            label="Base URL (opcional)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={kind === 'gemini' ? 'padrão do Gemini' : 'https://api.groq.com/openai/v1'}
            hint="Deixe em branco para usar o padrão do provedor."
          />
        )}
        <Input
          label="Chave de API"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEdit ? '•••• (em branco mantém a atual)' : 'cole a chave aqui'}
        />
        <div className="flex items-end gap-4">
          <Input
            label="Prioridade"
            type="number"
            value={String(priority)}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
            hint="Menor = tentada primeiro."
            className="w-24"
          />
          <label className="flex items-center gap-2 pb-2.5">
            <Toggle checked={isActive} onChange={setIsActive} label="Ativa" />
            <span className="text-sm text-text-primary">Ativa</span>
          </label>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" loading={testCreds.isPending} onClick={runTest} className="mb-1">
            Testar chave
          </Button>
        </div>
      </div>
    </Modal>
  );
}
