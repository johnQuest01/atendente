import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Select } from '@/components/ui/Input';
import {
  useConfigureWebhook,
  useDeleteWhatsappConnection,
  useSaveWhatsappConnection,
  useWhatsappConnections,
  type WhatsappConnectionInput,
  type WhatsappConnectionView,
  type WhatsappProvider,
} from '@/hooks/useWhatsappConnection';
import { getConnectionStatus } from '@/components/connection/connectionStatus';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

const PROVIDER_LABEL: Record<string, string> = {
  zapi: 'Z-API',
  evolution: 'Evolution API',
  metacloud: 'WhatsApp Oficial (Meta)',
};

function copyValue(value: string | null | undefined, what: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value).then(
    () => toast(`${what} copiado!`, 'success'),
    () => toast('Não foi possível copiar — copie manualmente.', 'error'),
  );
}

/** Form de credenciais WhatsApp (criar ou editar). */
export function WhatsappConnectionForm({
  initial,
  encryptionOk,
  saving,
  onCancel,
  onSave,
  submitLabel = 'Salvar instância',
}: {
  initial?: WhatsappConnectionView;
  encryptionOk: boolean;
  saving: boolean;
  onCancel?: () => void;
  onSave: (payload: WhatsappConnectionInput) => void;
  submitLabel?: string;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [phoneNumber, setPhoneNumber] = useState(initial?.phoneNumber ?? '');
  const [provider, setProvider] = useState<WhatsappProvider>(initial?.provider ?? 'zapi');
  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [instance, setInstance] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState(initial?.phoneNumberId ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [aiPersona, setAiPersona] = useState(initial?.aiPersona ?? '');
  const [aiTemperature, setAiTemperature] = useState(
    initial?.aiTemperature != null ? String(initial.aiTemperature) : '',
  );
  const [aiMaxTokens, setAiMaxTokens] = useState(
    initial?.aiMaxTokens != null ? String(initial.aiMaxTokens) : '',
  );
  const [agentEnabled, setAgentEnabled] = useState<string>(
    initial?.agentEnabled === null || initial?.agentEnabled === undefined
      ? 'inherit'
      : initial.agentEnabled
        ? 'on'
        : 'off',
  );

  function submit() {
    const payload: WhatsappConnectionInput = {
      provider,
      label: label.trim() || undefined,
      phoneNumber: phoneNumber.trim() || null,
      baseUrl: baseUrl.trim() || undefined,
      aiPersona: aiPersona.trim() ? aiPersona.trim() : null,
      aiTemperature: aiTemperature.trim() === '' ? null : Number(aiTemperature),
      aiMaxTokens: aiMaxTokens.trim() === '' ? null : Number(aiMaxTokens),
      agentEnabled: agentEnabled === 'inherit' ? null : agentEnabled === 'on',
    };
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
    onSave(payload);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-bg p-3">
      <Input
        label="Nome da instância"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Ex.: Vendas, Suporte, Número 2"
      />
      <Input
        label="Número (opcional)"
        value={phoneNumber}
        onChange={(e) => setPhoneNumber(e.target.value)}
        placeholder="Ex.: 5511999999999"
      />
      <Select
        label="Provedor"
        value={provider}
        onChange={(e) => setProvider(e.target.value as WhatsappProvider)}
      >
        <option value="zapi">Z-API</option>
        <option value="evolution">Evolution API</option>
        <option value="metacloud">WhatsApp Oficial (Meta)</option>
      </Select>

      {provider === 'zapi' ? (
        <>
          <Input
            label="ID da instância"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            placeholder={initial?.instanceId ? `Salvo (${initial.instanceId})` : 'ID da Z-API'}
            hint="Painel Z-API → sua instância → ID da instância"
          />
          <Input
            label="Token da instância"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={initial?.hasToken ? '•••• salvo (vazio = manter)' : 'Token'}
            hint="Token da conta/instância (na URL da API Z-API)"
          />
          <Input
            label="Token da integração (Client-Token)"
            value={clientToken}
            onChange={(e) => setClientToken(e.target.value)}
            placeholder={
              initial?.hasClientToken ? '•••• salvo (vazio = manter)' : 'Cole aqui o token da integração'
            }
            hint="Na Z-API: Segurança / Token de integração. Cole neste campo — não misture com o Token da instância."
          />
        </>
      ) : provider === 'metacloud' ? (
        <>
          <Input
            label="Token de acesso permanente"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={initial?.hasAccessToken ? '•••• salvo (vazio = manter)' : 'EAA...'}
          />
          <Input
            label="Phone number ID"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder={initial?.phoneNumberId ?? 'ID do número na Meta'}
          />
        </>
      ) : (
        <>
          <Input
            label="API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial?.hasApiKey ? '•••• salvo (vazio = manter)' : 'apikey'}
          />
          <Input
            label="Nome da instância"
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
            placeholder={initial?.instance ? `Salvo (${initial.instance})` : 'nome'}
          />
        </>
      )}

      <Input
        label="URL base (opcional)"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={
          provider === 'zapi'
            ? 'https://api.z-api.io/instances'
            : provider === 'metacloud'
              ? 'https://graph.facebook.com/v21.0'
              : 'https://sua-evolution'
        }
      />

      <div className="rounded-lg border border-border p-3">
        <p className="mb-2 text-xs font-semibold text-text-primary">IA deste número (prompt separado)</p>
        <p className="mb-2 text-xs text-text-secondary">
          Prompt <strong>só desta instância</strong> — não mistura com o prompt geral da empresa nem
          com o de outro número. Conversas deste WhatsApp ficam isoladas das outras instâncias. Vazio
          = herda a personalidade geral.
        </p>
        <Select
          label="Atendente neste número"
          value={agentEnabled}
          onChange={(e) => setAgentEnabled(e.target.value)}
        >
          <option value="inherit">Herdar padrão da empresa</option>
          <option value="on">Ligado</option>
          <option value="off">Desligado</option>
        </Select>
        <label className="mt-2 block text-xs font-medium text-text-secondary">
          Prompt deste número (não conflita com outros)
          <textarea
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 font-sans text-sm font-normal text-text-primary"
            rows={4}
            value={aiPersona}
            onChange={(e) => setAiPersona(e.target.value)}
            placeholder="Opcional: sobrescreve a persona deste WhatsApp. Use {NOME_DO_ATENDENTE}, {NOME_DO_NEGOCIO}… Vazio = herda o padrão da empresa."
          />
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Input
            label="Temperatura"
            value={aiTemperature}
            onChange={(e) => setAiTemperature(e.target.value)}
            placeholder="ex.: 0.7"
          />
          <Input
            label="Máx. tokens"
            value={aiMaxTokens}
            onChange={(e) => setAiMaxTokens(e.target.value)}
            placeholder="ex.: 500"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
        )}
        <Button size="sm" onClick={submit} loading={saving} disabled={!encryptionOk}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function WhatsappConnectionRow({
  conn,
  canEdit,
  testing,
  configuring,
  deleting,
  onTest,
  onEdit,
  onConfigureWebhook,
  onDelete,
}: {
  conn: WhatsappConnectionView;
  canEdit: boolean;
  testing: boolean;
  configuring: boolean;
  deleting: boolean;
  onTest: () => void;
  onEdit: () => void;
  onConfigureWebhook: () => void;
  onDelete: () => void;
}) {
  const status = getConnectionStatus(conn);

  return (
    <div className="rounded-xl border border-border bg-bg p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{conn.label}</p>
          <p className="text-xs text-text-secondary">
            {PROVIDER_LABEL[conn.provider] ?? conn.provider}
            {conn.phoneNumber ? ` · ${conn.phoneNumber}` : ''}
            {conn.agentEnabled === false ? ' · IA desligada neste número' : ''}
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {conn.status?.detail && (
        <p className="mb-2 text-xs text-text-secondary">{conn.status.detail}</p>
      )}

      {conn.webhookUrl && (
        <div className="mb-2">
          <p className="mb-1 text-xs font-semibold text-text-primary">Webhook desta instância</p>
          <div className="flex items-center gap-2">
            <code className="block flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">
              {conn.webhookUrl}
            </code>
            <Button size="sm" variant="secondary" onClick={() => copyValue(conn.webhookUrl, 'URL')}>
              Copiar
            </Button>
          </div>
          {conn.provider === 'metacloud' && conn.verifyToken && (
            <div className="mt-2 flex items-center gap-2">
              <code className="block flex-1 truncate rounded-lg bg-surface px-2 py-1.5 text-xs">
                Verify: {conn.verifyToken}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => copyValue(conn.verifyToken, 'Verify token')}
              >
                Copiar
              </Button>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" loading={testing} onClick={onTest}>
            Testar
          </Button>
          {conn.provider !== 'metacloud' && (
            <Button size="sm" variant="secondary" loading={configuring} onClick={onConfigureWebhook}>
              Webhook auto
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Editar
          </Button>
          <Button size="sm" variant="secondary" loading={deleting} onClick={onDelete}>
            Remover
          </Button>
        </div>
      )}
    </div>
  );
}

/** Painel para gerenciar UMA conexão WhatsApp (credenciais). */
export function ManageConnectionPanel({
  connectionId,
  canEdit,
}: {
  connectionId: string;
  canEdit: boolean;
}) {
  const navigate = useNavigate();
  const { data, isFetching, refetch } = useWhatsappConnections();
  const save = useSaveWhatsappConnection();
  const remove = useDeleteWhatsappConnection();
  const configureWebhook = useConfigureWebhook();
  const [editing, setEditing] = useState(false);

  const conn = data?.connections.find((c) => c.id === connectionId);
  const encryptionOk = data?.encryptionAvailable !== false;

  if (!conn) {
    return (
      <Card>
        <p className="text-sm text-text-secondary">Conexão não encontrada.</p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Gerenciar conexão</h2>
        <p className="text-sm text-text-secondary">
          Credenciais e webhook deste número WhatsApp.
        </p>
      </div>

      {!canEdit && (
        <p className="text-xs text-text-secondary">Apenas administradores podem alterar.</p>
      )}
      {canEdit && !encryptionOk && (
        <p className="rounded-lg bg-warning/12 px-3 py-2 text-xs text-warning">
          Defina ENCRYPTION_KEY no servidor para salvar as credenciais com segurança.
        </p>
      )}

      {editing ? (
        <WhatsappConnectionForm
          initial={conn}
          encryptionOk={encryptionOk}
          saving={save.isPending}
          onCancel={() => setEditing(false)}
          onSave={(payload) => {
            save.mutate(
              { ...payload, id: conn.id },
              {
                onSuccess: (view) => {
                  setEditing(false);
                  if (view.status?.ok) toast(`Conectado! ${view.status.detail}`, 'success');
                  else if (!view.configured)
                    toast('Credenciais incompletas — preencha os campos do provedor.', 'error');
                  else toast(`Salvo, mas falhou: ${view.status?.detail ?? ''}`, 'error');
                },
                onError: (err) => toast(getErrorMessage(err), 'error'),
              },
            );
          }}
        />
      ) : (
        <WhatsappConnectionRow
          conn={conn}
          canEdit={canEdit}
          testing={isFetching}
          configuring={configureWebhook.isPending}
          deleting={remove.isPending}
          onTest={() =>
            void refetch().then(({ data: fresh }) => {
              const c = fresh?.connections.find((x) => x.id === conn.id);
              if (!c) return;
              if (!c.configured) toast('Credenciais incompletas.', 'info');
              else if (c.status?.ok) toast(`Conectado! ${c.status.detail}`, 'success');
              else toast(c.status?.detail ?? 'Falha', 'error');
            })
          }
          onEdit={() => setEditing(true)}
          onConfigureWebhook={() =>
            configureWebhook.mutate(conn.id, {
              onSuccess: (r) => toast(r.detail, 'success'),
              onError: (err) => toast(getErrorMessage(err), 'error'),
            })
          }
          onDelete={() => {
            if (!confirm(`Remover a instância "${conn.label}"?`)) return;
            remove.mutate(conn.id, {
              onSuccess: () => {
                toast('Instância removida.', 'success');
                navigate('/');
              },
              onError: (err) => toast(getErrorMessage(err), 'error'),
            });
          }}
        />
      )}
    </Card>
  );
}
