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
import { BuildingIcon, KeyIcon, CopyIcon } from '@/components/ui/Icons';
import { useAuth } from '@/hooks/useAuth';
import { useMyAccessToken } from '@/hooks/useAccessTokens';
import { useAgentStatus, useSetAgentStatus, AGENT_QUERY_KEY } from '@/hooks/useAgent';
import {
  usePersona,
  useSetPersona,
  usePersonaPreview,
  useReminderPersona,
  useSetReminderPersona,
  useBehaviorSettings,
  useSetBehavior,
  type BehaviorSetting,
} from '@/hooks/usePersona';
import { useSystemStatus, type ServiceCheck } from '@/hooks/useSystemStatus';
import {
  useWhatsappConnections,
  useSaveWhatsappConnection,
  useDeleteWhatsappConnection,
  useConfigureWebhook,
  type WhatsappConnectionInput,
  type WhatsappConnectionView,
  type WhatsappProvider,
} from '@/hooks/useWhatsappConnection';
import {
  useReminderOwners,
  useAddReminderOwner,
  useRemoveReminderOwner,
  useMemoryScan,
  useSetMemoryScan,
} from '@/hooks/useReminderOwners';
import { useKeywords, useCreateKeyword, useDeleteKeyword } from '@/hooks/useKeywords';
import { useAiUsage } from '@/hooks/useAiProviders';
import { AiProvidersManager } from '@/components/ai/AiProvidersManager';
import { ContactsHistoryCard } from '@/components/features/ContactsHistoryCard';
import { ConnectionNumberPicker } from '@/components/features/ConnectionNumberPicker';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone, initials } from '@/utils/formatters';
import { splitDispatchKeywords } from '@/utils/dispatchKeywords';
import type { UserRole } from '@/types';

/** Campo de prompt: sans, um pouco mais preto, sem negrito. */
const PROMPT_TEXTAREA_CLASS =
  'mt-1 w-full resize-y rounded-xl border border-border bg-bg p-3 font-sans text-sm font-normal leading-relaxed text-[#0a0d14] outline-none focus:border-primary';

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

        <AccessTokenCard />

        <Card>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-text-primary">Status do sistema</h2>
            <div className="flex items-center gap-2">
              {health && (
                <Badge tone={health.status === 'ok' ? 'success' : 'warning'}>
                  {health.status === 'ok' ? 'Tudo operando' : 'Atenção'}
                </Badge>
              )}
              <Button size="sm" variant="secondary" loading={isFetching} onClick={() => void refetch()}>
                Testar
              </Button>
            </div>
          </div>
          <p className="mb-2 text-xs text-text-secondary">
            Cada linha mostra o serviço que está em uso agora — trocar de provedor troca o nome aqui.
          </p>
          <ul className="flex flex-col divide-y divide-border">
            <StatusRow label="WhatsApp" check={health?.services.whatsapp} />
            <StatusRow label="Inteligência artificial" check={health?.services.ai} />
            <StatusRow label="Banco de dados" check={health?.services.database} />
            <StatusRow label="Transcrição de áudio" check={health?.services.transcription} />
            <StatusRow label="Armazenamento de mídia" check={health?.services.storage} />
          </ul>
          {health && (
            <p className="mt-3 text-xs text-text-secondary">
              Última verificação: {new Date(health.timestamp).toLocaleString('pt-BR')}
            </p>
          )}
        </Card>

        <WhatsappCard canEdit={user?.role === 'admin' || user?.role === 'superadmin'} />

        <ContactsHistoryCard />

        {(user?.role === 'admin' || user?.role === 'superadmin') && <ReminderOwnersCard />}

        {(user?.role === 'admin' || user?.role === 'superadmin') && <DispatchKeywordsCard />}

        {(user?.role === 'admin' || user?.role === 'superadmin') && <ReminderPersonaCard />}

        {(user?.role === 'admin' || user?.role === 'superadmin') && <MemoryScanCard />}

        {(user?.role === 'admin' || user?.role === 'superadmin') && <BehaviorSettingsCard />}

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

/**
 * Token de acesso da empresa. É gerado pelo dono da plataforma e fica visível
 * aqui para qualquer pessoa logada NESTA empresa (só o token da própria empresa,
 * nunca o de outra). Só-leitura: quem gera/revoga é o superadmin, no /admin.
 */
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
        className={PROMPT_TEXTAREA_CLASS}
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
                    <span className="text-[11px] text-text-secondary">
                      via {preview.data.providerLabel}
                      {preview.data.model ? ` · ${preview.data.model}` : ''}
                    </span>
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

/**
 * Palavras de disparo dos compromissos do dia. Quando um número autorizado manda
 * uma dessas no WhatsApp da instância escolhida, a secretária responde os
 * compromissos de HOJE (zero IA). As palavras padrão (HOJE, AMANHÃ, SEMANA, MÊS,
 * TODOS) já funcionam sem cadastrar nada.
 */
function DispatchKeywordsCard() {
  const { data: keywords, isLoading } = useKeywords();
  const { data: waData } = useWhatsappConnections();
  const create = useCreateKeyword();
  const remove = useDeleteKeyword();
  const [word, setWord] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [saving, setSaving] = useState(false);

  const connections = waData?.connections ?? [];
  const words = (keywords ?? []).filter((k) => k.content_type === 'reminders_today');
  const existing = new Set(
    words.map((k) => `${k.connection_id ?? ''}:${k.keyword.trim().toLowerCase()}`),
  );

  function phoneLabel(connId: string | null | undefined): string {
    if (!connId) return 'todos os números';
    const c = connections.find((x) => x.id === connId);
    if (!c) return 'número';
    const digits = c.phoneNumber?.replace(/\D/g, '') ?? '';
    return digits.length >= 10 ? formatPhone(digits) : c.label;
  }

  async function add() {
    if (!connectionId) return toast('Escolha de qual número esta palavra vale.', 'error');
    const parts = splitDispatchKeywords(word);
    if (parts.length === 0) return;

    const toCreate = parts.filter((p) => !existing.has(`${connectionId}:${p}`));
    if (toCreate.length === 0) {
      toast('Essas palavras já estão cadastradas neste número.', 'info');
      setWord('');
      return;
    }

    setSaving(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const w of toCreate) {
        try {
          await create.mutateAsync({
            keyword: w,
            intent: 'reminders_today',
            content_type: 'reminders_today',
            content_id: null,
            priority: 1,
            connection_id: connectionId,
          });
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      setWord('');
      if (ok > 0 && fail === 0) {
        toast(
          ok === 1 ? 'Palavra de disparo adicionada.' : `${ok} palavras de disparo adicionadas.`,
          'success',
        );
      } else if (ok > 0) {
        toast(`${ok} salva(s), ${fail} falhou(aram).`, 'info');
      } else {
        toast('Não foi possível salvar as palavras.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Palavras de disparo</h2>
        <p className="text-sm text-text-secondary">
          Quando um número autorizado mandar uma destas palavras <strong>no WhatsApp
          escolhido</strong>, eu respondo os compromissos de hoje — sem gastar IA.
          Maiúsculas/minúsculas não importam. Separe várias com <strong>ponto</strong> ou{' '}
          <strong>vírgula</strong> (ex.: <em>hoje. amanha. mes, e todos</em>). As palavras{' '}
          <strong>HOJE</strong>, <strong>AMANHÃ</strong>, <strong>SEMANA</strong>,{' '}
          <strong>MÊS</strong> e <strong>TODOS</strong> já funcionam sem cadastrar.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando..." />}

      {words.map((k) => (
        <div key={k.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">{k.keyword}</p>
            <p className="truncate text-xs text-text-secondary">{phoneLabel(k.connection_id)}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(k.id, {
                onSuccess: () => toast('Palavra removida.', 'success'),
                onError: (err) => toast(getErrorMessage(err), 'error'),
              })
            }
          >
            Remover
          </Button>
        </div>
      ))}

      {words.length === 0 && !isLoading && (
        <p className="text-xs text-text-secondary">
          Nenhuma palavra extra. Ex.: <em>resumo. agenda do dia</em>
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
        <ConnectionNumberPicker
          value={connectionId}
          onChange={setConnectionId}
          label="Disparar em qual número?"
          cards={connections.length > 1}
        />
        <Input
          label="Nova palavra de disparo"
          placeholder="Ex.: resumo. agenda do dia, e balanço"
          hint="Ponto ou vírgula separa várias. Vale só no número escolhido acima."
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button
          size="sm"
          onClick={() => void add()}
          loading={saving || create.isPending}
          disabled={!word.trim() || !connectionId}
        >
          Adicionar palavra
        </Button>
      </div>
    </Card>
  );
}

/**
 * Comportamento do assistente de lembretes: como a "secretária" fala com o dono
 * ao confirmar/criar lembretes. Espelha o PersonaCard, com playground próprio
 * (target='reminder'): você digita como falaria e vê o texto de confirmação.
 */
function ReminderPersonaCard() {
  const { data, isLoading } = useReminderPersona();
  const setPersona = useSetReminderPersona();
  const preview = usePersonaPreview();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    if (data && !touched) setText(data.prompt);
  }, [data, touched]);

  const isDefault = data?.isDefault ?? true;
  const dirty = touched && data ? text !== data.prompt : false;

  function save() {
    setPersona.mutate(
      { prompt: text },
      {
        onSuccess: () => {
          setTouched(false);
          toast('Comportamento do assistente de lembretes salvo!', 'success');
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
    preview.mutate({ prompt: text, message, target: 'reminder' });
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Assistente de lembretes</h2>
          <p className="text-sm text-text-secondary">
            Defina o tom com que sua secretária confirma e cobra lembretes. Isso muda só o jeito de
            falar — a data e a hora continuam calculadas pelo sistema.
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
        rows={10}
        spellCheck
        placeholder='Ex.: "Você é minha secretária. Confirme com clareza, cite a data por extenso..."'
        className={PROMPT_TEXTAREA_CLASS}
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
        <h3 className="text-sm font-bold text-text-primary">Testar confirmação</h3>
        <p className="mb-2 text-xs text-text-secondary">
          Escreva como você pediria um lembrete e veja como a secretária confirmaria — sem salvar
          nada nem enviar WhatsApp.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Como você falaria"
              value={testMsg}
              onChange={(e) => setTestMsg(e.target.value)}
              placeholder="Ex.: me lembra sexta às 15h de pagar o fornecedor"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runPreview();
                }
              }}
            />
          </div>
          <Button size="sm" onClick={runPreview} loading={preview.isPending} disabled={!testMsg.trim()}>
            Testar
          </Button>
        </div>

        {preview.isError && <p className="mt-2 text-xs text-danger">{getErrorMessage(preview.error)}</p>}

        {preview.data && (
          <div className="mt-3 rounded-xl border border-border bg-bg p-3">
            {preview.data.reply ? (
              <>
                <Badge tone="success" className="mb-1">
                  Confirmação da secretária
                </Badge>
                <p className="whitespace-pre-wrap text-sm leading-snug text-text-primary">
                  {preview.data.reply}
                </p>
              </>
            ) : (
              <p className="text-xs text-warning">{preview.data.detail ?? 'Não interpretei um lembrete.'}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Varredura de conversas (recuperar compromissos). OFF por padrão — custa IA.
 * O liga/desliga é aqui; quem aciona é o dono pelo WhatsApp, e a secretária
 * propõe os compromissos achados antes de salvar (nada entra sozinho).
 */
function MemoryScanCard() {
  const { data: enabled } = useMemoryScan();
  const setScan = useSetMemoryScan();
  const isOn = enabled ?? false;

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-text-primary">Recuperar compromissos</h2>
            <Badge tone={isOn ? 'success' : 'neutral'}>{isOn ? 'Ligado' : 'Desligado'}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Deixa a IA reler as conversas recentes e sugerir compromissos que foram falados mas não
            viraram lembrete. Só roda quando você pede — e consome IA só nessa hora.
          </p>
        </div>
        <Toggle
          checked={isOn}
          disabled={setScan.isPending}
          onChange={(next) =>
            setScan.mutate(next, {
              onSuccess: () =>
                toast(next ? 'Varredura ligada.' : 'Varredura desligada.', 'success'),
              onError: (err) => toast(getErrorMessage(err), 'error'),
            })
          }
          label="Ligar ou desligar a varredura de conversas"
        />
      </div>
      {isOn && (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-text-secondary">
          No WhatsApp do dono, mande <strong>RECUPERAR COMPROMISSOS</strong> (ou{' '}
          <strong>VARRER 7 DIAS</strong>). A secretária lista o que encontrou e só salva depois do
          seu <strong>SIM</strong>.
        </p>
      )}
    </Card>
  );
}

/**
 * Ajustes simples de comportamento, renderizados a partir do registro do
 * servidor (behavior-settings). Para expor um novo ajuste, basta adicionar uma
 * linha no registro do backend — este card mostra o campo certo sozinho.
 */
function BehaviorSettingsCard() {
  const { data: settings, isLoading } = useBehaviorSettings();
  const save = useSetBehavior();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of settings) if (next[s.key] === undefined) next[s.key] = s.value;
      return next;
    });
  }, [settings]);

  function commit(s: BehaviorSetting, value: string | boolean) {
    save.mutate(
      { key: s.key, value },
      {
        onSuccess: () => toast(`"${s.label}" salvo.`, 'success'),
        onError: (err) => toast(getErrorMessage(err), 'error'),
      },
    );
  }

  const scopeLabel: Record<string, string> = { sales: 'Vendas', reminder: 'Lembretes', geral: 'Geral' };

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Ajustes de comportamento</h2>
        <p className="text-sm text-text-secondary">
          Regulagens rápidas da IA. Cada item vale na hora — sem precisar mexer no código.
        </p>
      </div>

      {isLoading && <Spinner label="Carregando ajustes..." />}

      {settings?.map((s) => {
        const draft = drafts[s.key] ?? s.value;
        const dirty = draft !== s.value;
        return (
          <div key={s.key} className="rounded-xl border border-border bg-bg p-3">
            <div className="mb-1 flex items-center gap-2">
              <p className="text-sm font-semibold text-text-primary">{s.label}</p>
              <Badge tone="neutral">{scopeLabel[s.scope] ?? s.scope}</Badge>
            </div>
            <p className="mb-2 text-xs text-text-secondary">{s.description}</p>

            {s.type === 'toggle' ? (
              <Toggle
                checked={draft === 'true'}
                disabled={save.isPending}
                onChange={(next) => commit(s, next)}
                label={s.label}
              />
            ) : s.type === 'number' ? (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={s.min ?? 0}
                  max={s.max ?? 100}
                  step={(s.max ?? 1) <= 2 ? 0.1 : 1}
                  value={Number(draft)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  className="flex-1 accent-primary"
                />
                <span className="w-14 text-right text-xs tabular-nums text-text-primary">{draft}</span>
                <Button size="sm" onClick={() => commit(s, draft)} loading={save.isPending} disabled={!dirty}>
                  Salvar
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder="Deixe vazio para usar o padrão"
                />
                <Button size="sm" onClick={() => commit(s, draft)} loading={save.isPending} disabled={!dirty}>
                  Salvar
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function WhatsappCard({ canEdit }: { canEdit: boolean }) {
  const { data, isFetching, refetch } = useWhatsappConnections();
  const save = useSaveWhatsappConnection();
  const remove = useDeleteWhatsappConnection();
  const configureWebhook = useConfigureWebhook();

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const connections = data?.connections ?? [];
  const encryptionOk = data?.encryptionAvailable !== false;

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Números WhatsApp</h2>
          <p className="text-sm text-text-secondary">
            Cadastre várias instâncias independentes (Z-API, Evolution ou Meta). Cada número tem
            webhook e IA próprios.
          </p>
        </div>
        <Badge tone={connections.some((c) => c.status?.ok) ? 'success' : 'warning'}>
          {connections.length} instância{connections.length === 1 ? '' : 's'}
        </Badge>
      </div>

      {!canEdit && (
        <p className="mb-3 text-xs text-text-secondary">Apenas administradores podem alterar.</p>
      )}
      {canEdit && !encryptionOk && (
        <p className="mb-3 rounded-lg bg-warning/12 px-3 py-2 text-xs text-warning">
          Defina ENCRYPTION_KEY no servidor para salvar as credenciais com segurança.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {connections.map((conn) =>
          editingId === conn.id ? (
            <WhatsappConnectionForm
              key={conn.id}
              initial={conn}
              encryptionOk={encryptionOk}
              saving={save.isPending}
              onCancel={() => setEditingId(null)}
              onSave={(payload) => {
                save.mutate(
                  { ...payload, id: conn.id },
                  {
                    onSuccess: (view) => {
                      setEditingId(null);
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
              key={conn.id}
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
              onEdit={() => setEditingId(conn.id)}
              onConfigureWebhook={() =>
                configureWebhook.mutate(conn.id, {
                  onSuccess: (r) => toast(r.detail, 'success'),
                  onError: (err) => toast(getErrorMessage(err), 'error'),
                })
              }
              onDelete={() => {
                if (!confirm(`Remover a instância "${conn.label}"?`)) return;
                remove.mutate(conn.id, {
                  onSuccess: () => toast('Instância removida.', 'success'),
                  onError: (err) => toast(getErrorMessage(err), 'error'),
                });
              }}
            />
          ),
        )}

        {editingId === 'new' && (
          <WhatsappConnectionForm
            encryptionOk={encryptionOk}
            saving={save.isPending}
            onCancel={() => setEditingId(null)}
            onSave={(payload) => {
              save.mutate(payload, {
                onSuccess: (view) => {
                  setEditingId(null);
                  if (view.status?.ok) toast(`Conectado! ${view.status.detail}`, 'success');
                  else toast('Instância criada. Complete as credenciais se precisar.', 'success');
                },
                onError: (err) => toast(getErrorMessage(err), 'error'),
              });
            }}
          />
        )}
      </div>

      {canEdit && editingId === null && (
        <Button
          size="sm"
          className="mt-3"
          disabled={!encryptionOk}
          onClick={() => setEditingId('new')}
        >
          Adicionar número / instância
        </Button>
      )}
    </Card>
  );
}

function copyValue(value: string | null | undefined, what: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value).then(
    () => toast(`${what} copiado!`, 'success'),
    () => toast('Não foi possível copiar — copie manualmente.', 'error'),
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
  const ok = conn.status?.ok ?? false;
  const tone = ok ? 'success' : conn.configured ? 'danger' : 'warning';
  const badge = ok ? 'Conectado' : conn.configured ? 'Offline' : 'Incompleto';

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
        <Badge tone={tone}>{badge}</Badge>
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

function WhatsappConnectionForm({
  initial,
  encryptionOk,
  saving,
  onCancel,
  onSave,
}: {
  initial?: WhatsappConnectionView;
  encryptionOk: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (payload: WhatsappConnectionInput) => void;
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
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 font-sans text-sm font-normal text-[#0a0d14]"
            rows={4}
            value={aiPersona}
            onChange={(e) => setAiPersona(e.target.value)}
            placeholder="Instruções só para este WhatsApp. Vazio = persona geral da empresa."
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
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button size="sm" onClick={submit} loading={saving} disabled={!encryptionOk}>
          Salvar instância
        </Button>
      </div>
    </div>
  );
}

function StatusRow({ label, check }: { label: string; check?: ServiceCheck }) {
  const ok = check?.ok ?? false;
  // Serviço opcional fora do ar é aviso, não falha: o sistema segue funcionando
  // sem transcrição ou sem CDN, só com menos recurso.
  const tone = !check ? 'warning' : ok ? 'success' : check.optional ? 'warning' : 'danger';
  const badgeText = !check ? '...' : ok ? 'OK' : check.optional ? 'Inativo' : 'Falha';

  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm text-text-primary">{label}</span>
          {check?.provider ? (
            <span className="text-sm font-bold text-text-primary">{check.provider}</span>
          ) : (
            check && <span className="text-sm text-text-secondary">não configurado</span>
          )}
        </div>
        {check?.detail && (
          <p className="mt-0.5 truncate text-xs text-text-secondary" title={check.detail}>
            {check.detail}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Badge tone={tone}>{badgeText}</Badge>
        {check?.latencyMs != null && (
          <span className="text-[10px] tabular-nums text-text-secondary">{check.latencyMs}ms</span>
        )}
      </div>
    </li>
  );
}
