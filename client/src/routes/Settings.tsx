import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import { Input, Select } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/States';
import { BuildingIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import { useAgentStatus, useSetAgentStatus, AGENT_QUERY_KEY } from '@/hooks/useAgent';
import { usePersona, useSetPersona, usePersonaPreview } from '@/hooks/usePersona';
import { useSystemStatus, type ServiceCheck } from '@/hooks/useSystemStatus';
import {
  useWhatsappConnection,
  useSaveWhatsappConnection,
  type WhatsappConnectionInput,
  type WhatsappProvider,
} from '@/hooks/useWhatsappConnection';
import {
  useReminderOwners,
  useAddReminderOwner,
  useRemoveReminderOwner,
} from '@/hooks/useReminderOwners';
import { useAiUsage } from '@/hooks/useAiProviders';
import { AiProvidersManager } from '@/components/ai/AiProvidersManager';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { initials } from '@/utils/formatters';
import type { UserRole } from '@/types';

const PROVIDER_LABEL: Record<string, string> = {
  zapi: 'Z-API',
  evolution: 'Evolution API',
  metacloud: 'WhatsApp Oficial (Meta)',
};

function roleLabel(role: UserRole): string {
  if (role === 'superadmin') return 'Dono da plataforma';
  if (role === 'admin') return 'Administrador';
  return 'Operador';
}

export default function Settings() {
  const { user, logout } = useAuth();

  const qc = useQueryClient();
  const { data: agentEnabled } = useAgentStatus();
  const setAgent = useSetAgentStatus();
  const { data: health, isFetching, refetch } = useSystemStatus();

  // Sincroniza o status em tempo real se ele for alterado em outro dispositivo.
  const onAgentStatus = useCallback(
    (payload: unknown) => {
      const enabled = (payload as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled === 'boolean') qc.setQueryData(AGENT_QUERY_KEY, enabled);
    },
    [qc],
  );
  useSocket({ 'agent:status': onAgentStatus });

  const isOn = agentEnabled ?? true;

  return (
    <>
      <PageHeader title="Configurações" subtitle="Perfil e integrações" />

      <div className="flex flex-col gap-4 p-4">
        <Card className={isOn ? 'border-2 border-success/30' : 'border-2 border-danger/40'}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-text-primary">Atendente de IA</h2>
                <Badge tone={isOn ? 'success' : 'danger'}>{isOn ? 'Ligado' : 'Desligado'}</Badge>
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                {isOn
                  ? 'A IA responde automaticamente os clientes no WhatsApp.'
                  : 'A IA está pausada. As mensagens chegam no painel, mas quem responde é você.'}
              </p>
            </div>
            <Toggle
              checked={isOn}
              disabled={setAgent.isPending}
              onChange={(next) => setAgent.mutate(next)}
              label="Ligar ou desligar o atendente de IA"
            />
          </div>
        </Card>

        <PersonaCard />

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

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-text-primary">Status do sistema</h2>
            <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
              Testar
            </Button>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            <StatusRow label="Servidor / Banco" check={health?.services.database} />
            <StatusRow
              label={`IA${health?.aiProvider && health.aiProvider !== 'nenhum' ? ` (${health.aiProvider})` : ''}`}
              check={health?.services.ai}
            />
            <StatusRow label="Transcrição de áudio (STT)" check={health?.services.transcription} />
            <StatusRow
              label={`WhatsApp (${PROVIDER_LABEL[health?.whatsappProvider ?? 'zapi'] ?? 'Z-API'})`}
              check={health?.services.whatsapp}
            />
          </ul>
          {health && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-xs text-text-secondary">
                Última verificação: {new Date(health.timestamp).toLocaleString('pt-BR')}
              </p>
              <Badge tone={health.storage === 'remote' ? 'success' : 'warning'}>
                {health.storage === 'remote' ? 'Mídia: CDN (R2)' : 'Mídia: local'}
              </Badge>
            </div>
          )}
        </Card>

        <WhatsappCard canEdit={user?.role === 'admin' || user?.role === 'superadmin'} />

        {(user?.role === 'admin' || user?.role === 'superadmin') && <ReminderOwnersCard />}

        {(user?.role === 'admin' || user?.role === 'superadmin') && <AiCard />}

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

function AiCard() {
  const { data: usage } = useAiUsage('tenant');
  const over =
    !!usage && usage.source !== 'tenant' && usage.limit != null && usage.used >= usage.limit;

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-base font-bold text-text-primary">Inteligência Artificial da empresa</h2>
        <p className="text-sm text-text-secondary">
          Conecte suas próprias chaves e defina a ordem de atendimento. Quando os tokens de uma IA
          acabam, o sistema passa automaticamente para a próxima — sem parar a automação.
        </p>
      </div>

      {usage && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-border bg-bg px-3 py-2">
          <span className="text-xs text-text-secondary">
            Uso de IA neste mês{usage.source === 'tenant' ? ' (suas chaves)' : ' (plano)'}
          </span>
          <Badge tone={over ? 'danger' : 'neutral'}>
            {usage.source === 'tenant' || usage.limit == null
              ? `${usage.used} mensagem(ns)`
              : `${usage.used}/${usage.limit}`}
          </Badge>
        </div>
      )}

      <AiProvidersManager scope="tenant" />
    </Card>
  );
}

function PersonaCard() {
  const { data, isLoading } = usePersona();
  const setPersona = useSetPersona();
  const preview = usePersonaPreview();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [temp, setTemp] = useState(0.7);

  // Sincroniza textarea/temperatura quando os dados chegam (sem sobrescrever edição).
  useEffect(() => {
    if (data && !touched) {
      setText(data.prompt);
      setTemp(data.temperature ?? 0.7);
    }
  }, [data, touched]);

  const isDefault = data?.isDefault ?? true;
  const dirty =
    touched && data
      ? text !== data.prompt || Math.abs(temp - (data.temperature ?? 0.7)) > 0.001
      : false;

  function save() {
    setPersona.mutate(
      { prompt: text, temperature: temp },
      {
        onSuccess: () => {
          setTouched(false);
          toast('Personalidade da IA salva! O agente já segue as novas instruções.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  function restoreDefault() {
    if (!data) return;
    setText(data.default);
    setTouched(true);
  }

  function runPreview() {
    const message = testMsg.trim();
    if (!message) return;
    preview.mutate({ prompt: text, message, temperature: temp });
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Personalidade da IA</h2>
          <p className="text-sm text-text-secondary">
            Escreva o contexto, o jeito de falar e as regras que a IA deve seguir. É como escrever
            as instruções direto pra IA — ela lê e responde os clientes seguindo isto.
          </p>
        </div>
        <Badge tone={isDefault ? 'primary' : 'success'}>{isDefault ? 'Padrão' : 'Personalizado'}</Badge>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setTouched(true);
        }}
        disabled={isLoading}
        rows={16}
        spellCheck
        placeholder="Ex.: Você é a Ana, atendente da Loja X. Fale de forma simpática e curta..."
        className="mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-text-primary outline-none focus:border-primary"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-text-secondary">{text.length} caracteres</span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={restoreDefault} disabled={setPersona.isPending}>
            Restaurar padrão
          </Button>
          <Button size="sm" onClick={save} loading={setPersona.isPending} disabled={!dirty}>
            Salvar
          </Button>
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-bold text-text-primary">Testar resposta (pré-visualização)</h3>
        <p className="mb-2 text-xs text-text-secondary">
          Simule uma mensagem de cliente e veja como a IA responderia com este prompt — sem enviar
          nada no WhatsApp. Usa o texto acima (mesmo sem salvar), o seu catálogo e o provedor de IA ativo.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Mensagem do cliente"
              value={testMsg}
              onChange={(e) => setTestMsg(e.target.value)}
              placeholder="Ex.: Oi, vocês vendem no atacado? Qual o pedido mínimo?"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runPreview();
                }
              }}
            />
          </div>
          <Button size="sm" onClick={runPreview} loading={preview.isPending} disabled={!testMsg.trim()}>
            Simular resposta
          </Button>
        </div>

        <label className="mt-3 flex items-center gap-3 text-xs text-text-secondary">
          <span className="whitespace-nowrap">Criatividade: {temp.toFixed(1)}</span>
          <input
            type="range"
            min={0}
            max={1.2}
            step={0.1}
            value={temp}
            onChange={(e) => {
              setTemp(Number(e.target.value));
              setTouched(true);
            }}
            className="flex-1 accent-primary"
          />
        </label>
        <p className="mt-1 text-[11px] text-text-secondary">
          Este valor é salvo com a personalidade e vale também para o atendimento real no WhatsApp.
        </p>

        {preview.isError && <p className="mt-2 text-xs text-danger">{getErrorMessage(preview.error)}</p>}

        {preview.data && (
          <div className="mt-3 rounded-xl border border-border bg-bg p-3">
            {preview.data.reply ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone="success">Resposta da IA</Badge>
                  {preview.data.providerLabel && (
                    <span className="text-[11px] text-text-secondary">via {preview.data.providerLabel}</span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-snug text-text-primary">
                  {preview.data.reply}
                </p>
              </>
            ) : (
              <p className="text-xs text-warning">{preview.data.detail ?? 'A IA não respondeu.'}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Assistente pessoal de lembretes. Um número cadastrado aqui para de ser
 * atendido como cliente: o que ele mandar (texto ou áudio) vira lembrete.
 */
function ReminderOwnersCard() {
  const { data: owners, isLoading } = useReminderOwners();
  const add = useAddReminderOwner();
  const remove = useRemoveReminderOwner();

  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');

  function submit() {
    if (!phone.trim()) return;
    add.mutate(
      { phone: phone.trim(), label: label.trim() || undefined },
      {
        onSuccess: () => {
          setPhone('');
          setLabel('');
          toast('Número autorizado a usar os lembretes.', 'success');
        },
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Lembretes pessoais</h2>
        <p className="text-sm text-text-secondary">
          Números autorizados falam com seu assistente pessoal pelo mesmo WhatsApp. Eles não viram
          clientes e não recebem resposta de vendas — só lembretes.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando..." />}

      {owners?.map((o) => (
        <div
          key={o.phone}
          className="flex items-center gap-2 rounded-xl border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{o.label ?? o.phone}</p>
            {o.label && <p className="truncate text-xs text-text-secondary">{o.phone}</p>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(o.phone, {
                onSuccess: () => toast('Número removido.', 'success'),
                onError: (err) => toast(getErrorMessage(err), 'error'),
              })
            }
          >
            Remover
          </Button>
        </div>
      ))}

      {owners && owners.length === 0 && (
        <p className="text-xs text-text-secondary">
          Nenhum número autorizado. Adicione o seu para começar a mandar lembretes por WhatsApp.
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
        <Input
          label="Número (com DDI e DDD)"
          placeholder="Ex.: 5511999998888"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          label="Identificação (opcional)"
          placeholder="Ex.: meu celular"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button size="sm" onClick={submit} loading={add.isPending}>
          Autorizar número
        </Button>
      </div>

      <p className="text-xs text-text-secondary">
        Depois é só mandar no WhatsApp: <em>“me lembra amanhã às 9h de pagar o fornecedor”</em>.
        Envie <strong>AJUDA</strong> para ver todos os comandos.
      </p>
    </Card>
  );
}

function WhatsappCard({ canEdit }: { canEdit: boolean }) {
  const { data, isFetching, refetch } = useWhatsappConnection();
  const save = useSaveWhatsappConnection();

  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<WhatsappProvider>('zapi');
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [instance, setInstance] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    if (data && !editing) setProvider(data.provider);
  }, [data, editing]);

  const status = data?.status;
  const ok = status?.ok ?? false;
  const tone = !data ? 'warning' : ok ? 'success' : data.configured ? 'danger' : 'warning';
  const label = !data ? '...' : ok ? 'Conectado' : data.configured ? 'Offline' : 'Não configurado';

  function copyValue(value: string | null | undefined, what: string) {
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(
      () => toast(`${what} copiado!`, 'success'),
      () => toast('Não foi possível copiar — copie manualmente.', 'error'),
    );
  }

  function resetFields() {
    setInstanceId('');
    setToken('');
    setClientToken('');
    setApiKey('');
    setInstance('');
    setAccessToken('');
    setPhoneNumberId('');
    setBaseUrl('');
  }

  function submit() {
    const payload: WhatsappConnectionInput = { provider };
    if (provider === 'zapi') {
      if (instanceId.trim()) payload.instanceId = instanceId.trim();
      if (token.trim()) payload.token = token.trim();
      if (clientToken.trim()) payload.clientToken = clientToken.trim();
    } else if (provider === 'metacloud') {
      if (accessToken.trim()) payload.accessToken = accessToken.trim();
      if (phoneNumberId.trim()) payload.phoneNumberId = phoneNumberId.trim();
    } else {
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      if (instance.trim()) payload.instance = instance.trim();
    }
    if (baseUrl.trim()) payload.baseUrl = baseUrl.trim();

    save.mutate(payload, {
      onSuccess: () => {
        setEditing(false);
        resetFields();
        toast('Conexão de WhatsApp salva!', 'success');
      },
      onError: (err) => toast(getErrorMessage(err), 'error'),
    });
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Conexão do WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Conecte a instância de WhatsApp desta empresa. O agente envia e recebe por ela.
          </p>
        </div>
        <Badge tone={tone}>{label}</Badge>
      </div>

      {status?.detail && <p className="mb-3 text-xs text-text-secondary">{status.detail}</p>}

      {data?.webhookUrl && (
        <div className="mb-3 rounded-xl border border-border bg-bg p-3">
          <p className="mb-1 text-xs font-semibold text-text-primary">URL de webhook desta empresa</p>
          <p className="mb-2 text-xs text-text-secondary">
            {data.provider === 'metacloud'
              ? 'Cole em Meta for Developers → WhatsApp → Configuration → Callback URL.'
              : `Cole no painel da ${PROVIDER_LABEL[data.provider] ?? 'Z-API'} (mensagens recebidas e status).`}
          </p>
          <div className="flex items-center gap-2">
            <code className="block flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs text-text-primary">
              {data.webhookUrl}
            </code>
            <Button size="sm" variant="secondary" onClick={() => copyValue(data.webhookUrl, 'URL de webhook')}>
              Copiar
            </Button>
          </div>

          {data.provider === 'metacloud' && data.verifyToken && (
            <>
              <p className="mb-1 mt-3 text-xs font-semibold text-text-primary">Verify token</p>
              <p className="mb-2 text-xs text-text-secondary">
                No mesmo formulário da Meta, cole este valor no campo “Verify token”. Depois clique em
                Verify and save e assine o campo <strong>messages</strong>.
              </p>
              <div className="flex items-center gap-2">
                <code className="block flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs text-text-primary">
                  {data.verifyToken}
                </code>
                <Button size="sm" variant="secondary" onClick={() => copyValue(data.verifyToken, 'Verify token')}>
                  Copiar
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {canEdit && data?.encryptionAvailable === false && (
        <p className="mb-3 rounded-lg bg-warning/12 px-3 py-2 text-xs text-warning">
          Defina ENCRYPTION_KEY no servidor para salvar as credenciais com segurança.
        </p>
      )}

      {!canEdit ? (
        <p className="text-xs text-text-secondary">Apenas administradores podem alterar a conexão.</p>
      ) : editing ? (
        <div className="flex flex-col gap-3">
          <Select
            label="Provedor"
            value={provider}
            onChange={(e) => setProvider(e.target.value as WhatsappProvider)}
          >
            <option value="zapi">Z-API</option>
            <option value="evolution">Evolution API</option>
            <option value="metacloud">WhatsApp Oficial (Meta)</option>
          </Select>

          {provider === 'metacloud' && (
            <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-text-secondary">
              Pegue os dois valores em{' '}
              <a
                href="https://developers.facebook.com/apps"
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary underline"
              >
                Meta for Developers
              </a>{' '}
              → seu app → WhatsApp → API Setup. Salve aqui primeiro: a URL de webhook e o verify token
              aparecem logo acima, e é com eles que você conclui a configuração lá na Meta.
            </p>
          )}

          {provider === 'zapi' ? (
            <>
              <Input
                label="Instance ID"
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                placeholder={data?.instanceId ? `Salvo (${data.instanceId})` : 'Ex.: 3DF1A2...'}
              />
              <Input
                label="Token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={data?.hasToken ? '•••• salvo (vazio = manter)' : 'Token da instância'}
              />
              <Input
                label="Client-Token (opcional)"
                value={clientToken}
                onChange={(e) => setClientToken(e.target.value)}
                placeholder={data?.hasClientToken ? '•••• salvo (vazio = manter)' : 'Segurança da conta'}
              />
            </>
          ) : provider === 'metacloud' ? (
            <>
              <Input
                label="Token de acesso permanente"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={data?.hasAccessToken ? '•••• salvo (vazio = manter)' : 'Começa com EAA...'}
              />
              <Input
                label="Phone number ID"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder={data?.phoneNumberId ?? 'Ex.: 123456789012345'}
              />
            </>
          ) : (
            <>
              <Input
                label="API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data?.hasApiKey ? '•••• salvo (vazio = manter)' : 'apikey da Evolution'}
              />
              <Input
                label="Instância"
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
                placeholder={data?.instance ? `Salvo (${data.instance})` : 'Nome da instância'}
              />
            </>
          )}

          <Input
            label="URL base (opcional)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              data?.baseUrl ??
              (provider === 'zapi'
                ? 'https://api.z-api.io/instances'
                : provider === 'metacloud'
                  ? 'https://graph.facebook.com/v21.0'
                  : 'http://...')
            }
          />

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={save.isPending}>
              Cancelar
            </Button>
            <Button size="sm" onClick={submit} loading={save.isPending} disabled={data?.encryptionAvailable === false}>
              Salvar conexão
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
            Testar conexão
          </Button>
          <Button size="sm" onClick={() => setEditing(true)}>
            {data?.configured ? 'Editar credenciais' : 'Configurar'}
          </Button>
        </div>
      )}
    </Card>
  );
}

function StatusRow({ label, check }: { label: string; check?: ServiceCheck }) {
  const ok = check?.ok ?? false;
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <span className="text-sm text-text-primary">{label}</span>
        {check?.detail && (
          <p className="mt-0.5 truncate text-xs text-text-secondary" title={check.detail}>
            {check.detail}
          </p>
        )}
      </div>
      <Badge tone={check ? (ok ? 'success' : 'danger') : 'warning'}>
        {check ? (ok ? 'OK' : 'Falha') : '...'}
      </Badge>
    </li>
  );
}
