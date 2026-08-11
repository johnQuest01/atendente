import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { Spinner, ErrorState } from '@/components/ui/States';
import { SparklesIcon, PlusIcon, EditIcon, TrashIcon } from '@/components/ui/Icons';
import {
  useAiProviders,
  useCreateAiProvider,
  useUpdateAiProvider,
  useDeleteAiProvider,
  useTestAiCreds,
  useTestSavedAiProvider,
  useListAiModels,
  useListSavedAiModels,
  type AiKind,
  type AiProviderDto,
  type AiScope,
  type ChainSource,
} from '@/hooks/useAiProviders';
import { useWhatsappConnections, type WhatsappConnectionView } from '@/hooks/useWhatsappConnection';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone } from '@/utils/formatters';

/** Número que a IA atende (badge da lista). */
function formatPhoneBadge(p: AiProviderDto): string {
  if (!p.connection_id) return 'Todos os números';
  const phone = p.connection_phone?.trim();
  if (phone) return formatPhone(phone);
  return p.connection_label?.trim() || 'Número ainda não detectado';
}

/** Opção do select: prioriza o telefone real; a instância vem junto via connection_id. */
function formatPhoneOption(c: WhatsappConnectionView): string {
  const phone = c.phoneNumber?.trim();
  const label = c.label?.trim();
  const status = c.isActive && c.configured ? ' · conectado' : '';
  if (phone) {
    const formatted = formatPhone(phone);
    // Mostra o nome só se for diferente do número (ex.: "Vendas").
    if (label && label.toLowerCase() !== phone.toLowerCase() && !label.includes(phone)) {
      return `${formatted} · ${label}${status}`;
    }
    return `${formatted}${status}`;
  }
  return `${label || 'WhatsApp'} (número ainda não detectado)${status}`;
}

/**
 * Gestão de provedores de IA reaproveitada em dois lugares (modelo híbrido):
 *   - scope="global": padrão da plataforma (super-admin, em /admin)
 *   - scope="tenant": IA da própria empresa (admin, em Configurações)
 * A lógica de failover/ordem é a mesma; muda só o endpoint (via hooks) e a cópia.
 */

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
// O `model` de cada preset é o 1º item da lista de MODELS_BY_PRESET (default).
const AI_PRESETS: AiPreset[] = [
  { id: 'claude', kind: 'anthropic', label: 'Claude (Anthropic)', baseUrl: '', model: 'claude-sonnet-4-6' },
  { id: 'gemini', kind: 'gemini', label: 'Gemini (Google)', baseUrl: '', model: 'gemini-3.5-flash', free: true },
  { id: 'groq', kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', free: true },
  { id: 'openai', kind: 'openai', label: 'ChatGPT (OpenAI)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
  { id: 'openrouter', kind: 'openai', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', free: true },
  { id: 'custom', kind: 'openai', label: 'Personalizado', baseUrl: '', model: '' },
];

interface AiModelOption {
  id: string;
  label: string;
  free?: boolean;
  /** Modelo multimodal: "enxerga" as fotos/vídeos que o cliente enviar. */
  vision?: boolean;
}

/**
 * Modelos disponíveis por provedor (jun/2026) para o seletor de "Modelo".
 * Mantemos sempre a opção "Outro (digitar)…" no formulário para não travar
 * quando um modelo novo for lançado ou um antigo for descontinuado.
 */
const MODELS_BY_PRESET: Record<string, AiModelOption[]> = {
  claude: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — equilíbrio (recomendado)', vision: true },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — mais capaz', vision: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — rápido e barato', vision: true },
    { id: 'claude-fable-5', label: 'Claude Fable 5 — topo de linha', vision: true },
  ],
  gemini: [
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — recomendado', free: true, vision: true },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite — econômico', free: true, vision: true },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', vision: true },
  ],
  groq: [
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout — vê imagens', free: true, vision: true },
    { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick — vê imagens', free: true, vision: true },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B — recomendado (texto)', free: true },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B — mais rápido (texto)', free: true },
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B — texto (até ago/2026)', free: true },
  ],
  openai: [
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini — econômico (recomendado)', vision: true },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano — mais barato', vision: true },
    { id: 'gpt-5.5', label: 'GPT-5.5 — flagship', vision: true },
    { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro — máximo', vision: true },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B — grátis (texto)', free: true },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (texto)' },
    { id: 'google/gemini-flash-1.5:free', label: 'Gemini Flash — grátis, vê imagens', free: true, vision: true },
  ],
  custom: [],
};

/**
 * Junta os modelos REAIS do provedor (buscados na API) com os rótulos curados.
 * Os reais mandam (é a lista atual do provedor); quando um deles bate com um
 * curado, usa o rótulo bonito ("recomendado", "vê imagens"). Sem lista real,
 * cai nos curados.
 */
function mergeModelOptions(
  real: string[] | null,
  curated: AiModelOption[],
  kind: AiKind,
): AiModelOption[] {
  if (!real || real.length === 0) return curated;
  const byId = new Map(curated.map((c) => [c.id, c]));
  return real.map((id) => byId.get(id) ?? { id, label: id, vision: modelSeesImages(kind, id) });
}

/** Deriva qual provedor (preset) corresponde ao kind + base URL — para listar os modelos certos. */
function presetIdFor(kind: AiKind, baseUrl: string): string {
  if (kind === 'anthropic') return 'claude';
  if (kind === 'gemini') return 'gemini';
  const u = (baseUrl || '').toLowerCase();
  if (u.includes('groq')) return 'groq';
  if (u.includes('openrouter')) return 'openrouter';
  if (u.includes('openai')) return 'openai';
  return 'custom';
}

/** Distância de edição (Levenshtein) — base para sugerir o modelo certo num typo. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Os `limit` modelos do catálogo mais parecidos com o que foi digitado. */
function closestModels(target: string, list: string[], limit = 4): string[] {
  const t = target.trim().toLowerCase();
  if (!t || list.length === 0) return [];
  const max = Math.max(4, Math.ceil(t.length * 0.6));
  return list
    .map((id) => {
      const c = id.toLowerCase();
      const score = c === t ? 0 : c.includes(t) || t.includes(c) ? 1 : levenshtein(t, c);
      return { id, score };
    })
    .filter((x) => x.score <= max)
    .sort((a, b) => a.score - b.score || a.id.length - b.id.length || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

/**
 * Checagem OFFLINE e instantânea (sem chave): o ID digitado parece fora do
 * padrão do provedor? Retorna uma dica curta ou null se parecer ok.
 */
function modelHeuristicWarning(presetId: string, kind: AiKind, model: string): string | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  if (kind === 'anthropic') {
    return /^claude-/.test(m) ? null : 'Dica: modelos da Anthropic começam com “claude-”.';
  }
  if (kind === 'gemini') {
    return /^(gemini|gemma|learnlm)/.test(m) ? null : 'Dica: modelos do Google começam com “gemini-”.';
  }
  if (presetId === 'openai') {
    return /^(gpt-|o\d|chatgpt|text-|davinci)/.test(m)
      ? null
      : 'Dica: a OpenAI usa “gpt-…” ou “o…” (ex.: gpt-5.4-mini).';
  }
  if (presetId === 'groq') {
    return /(llama|mixtral|gemma|qwen|gpt-oss|deepseek|whisper|kimi|moonshot)/.test(m)
      ? null
      : 'Dica: no Groq use algo como “openai/gpt-oss-120b” ou “llama-3.3-70b-versatile”.';
  }
  return null; // OpenRouter/personalizado: formato livre (provedor/modelo).
}

/**
 * O modelo "enxerga" imagens? Espelha a heurística do backend (services/ai/vision.ts)
 * para indicar visão na UI sem depender de chamada de rede. Usado tanto no campo
 * "Outro (digitar)" quanto no selo da lista de provedores.
 */
function modelSeesImages(kind: AiKind, model: string): boolean {
  const m = (model || '').toLowerCase().trim();
  if (!m) return false;
  if (kind === 'anthropic') {
    if (m.includes('claude-2') || m.includes('instant')) return false;
    return m.startsWith('claude-');
  }
  if (kind === 'gemini') {
    if (m === 'gemini-pro' || m.startsWith('gemini-1.0')) return false;
    return m.startsWith('gemini') || m.startsWith('gemma-3') || m.startsWith('learnlm') || m.includes('vision');
  }
  if (/(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o)/.test(m)) return true;
  if (/^o[1-9]/.test(m)) return true;
  return /(vision|llava|pixtral|llama-?3\.2|llama-?4|qwen.*vl|qwen2-vl|gemini|claude-3|moondream|internvl|minicpm-v|phi-3.*vision|phi-4.*vision|grok.*vision)/.test(
    m,
  );
}

function statusBadge(p: AiProviderDto) {
  if (!p.is_active) return <Badge tone="neutral">Inativa</Badge>;
  if (p.in_cooldown) return <Badge tone="warning">Em cooldown</Badge>;
  if (p.last_status === 'ok') return <Badge tone="success">OK</Badge>;
  if (p.last_status) return <Badge tone="danger">{p.last_status}</Badge>;
  // Ativa, mas ainda não processou/testou nada. "Ativa" é mais claro que
  // "Não usada" (que dava a impressão de que o modelo não valia).
  return <Badge tone="primary">Ativa</Badge>;
}

/** Aviso de qual corrente está ativa (relevante para a empresa). */
function SourceHint({ scope, source, hasOwn }: { scope: AiScope; source: ChainSource; hasOwn: boolean }) {
  if (scope !== 'tenant') return null;
  if (hasOwn && source === 'tenant') {
    return (
      <p className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
        Usando <strong>suas próprias chaves</strong>. O uso não conta no seu limite mensal do plano.
      </p>
    );
  }
  return (
    <p className="rounded-lg bg-primary-light px-3 py-2 text-xs text-text-secondary">
      Você está usando a <strong>IA padrão da plataforma</strong>. Conecte suas próprias chaves abaixo
      para escolher o modelo, ter prioridade e não depender do limite mensal.
    </p>
  );
}

export function AiProvidersManager({
  scope,
  suggestedConnectionId,
}: {
  scope: AiScope;
  /** Pré-seleciona / prioriza este número ao criar provedor (workspace da conexão). */
  suggestedConnectionId?: string;
}) {
  const { data, isLoading, isError, refetch } = useAiProviders(scope);
  const allProviders = data?.providers;
  const providers = suggestedConnectionId
    ? allProviders?.filter(
        (p) => !p.connection_id || p.connection_id === suggestedConnectionId,
      )
    : allProviders;
  const source = data?.source ?? null;
  const [modal, setModal] = useState<AiProviderDto | 'new' | null>(null);

  const nextPriority =
    providers && providers.length > 0 ? Math.max(...providers.map((p) => p.priority)) + 10 : 0;

  const desc =
    scope === 'global'
      ? 'Tentadas na ordem de prioridade. Se a cota/token de uma acabar, o sistema troca automaticamente para a próxima (failover) — a automação nunca para.'
      : 'Conecte suas próprias chaves e defina a ordem de atendimento. Quando os tokens de uma acabam, o sistema passa para a próxima sozinho (failover).';

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-bold text-text-primary">
            <SparklesIcon width={16} height={16} /> Inteligência Artificial
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">{desc}</p>
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

      {providers && (
        <div className="mb-2">
          <SourceHint scope={scope} source={source} hasOwn={providers.length > 0} />
        </div>
      )}

      {providers && providers.length === 0 && (
        <Card>
          <p className="text-sm text-text-secondary">
            {scope === 'global'
              ? 'Nenhuma IA cadastrada. Adicione uma (ex.: Claude, Gemini ou Groq) para ligar as respostas automáticas — e cadastre mais de uma para o failover.'
              : 'Nenhuma chave própria cadastrada. Adicione uma (ex.: Gemini ou Groq têm cota grátis) para usar seu próprio modelo. Cadastre mais de uma para ter failover.'}
          </p>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {providers?.map((p) => (
          <AiProviderRow key={p.id} scope={scope} provider={p} onEdit={() => setModal(p)} />
        ))}
      </div>

      <AiProviderModal
        scope={scope}
        open={modal !== null}
        onClose={() => setModal(null)}
        provider={modal && modal !== 'new' ? modal : undefined}
        suggestedPriority={nextPriority}
        suggestedConnectionId={suggestedConnectionId}
      />
    </div>
  );
}

function AiProviderRow({
  scope,
  provider,
  onEdit,
}: {
  scope: AiScope;
  provider: AiProviderDto;
  onEdit: () => void;
}) {
  const update = useUpdateAiProvider(scope);
  const del = useDeleteAiProvider(scope);
  const test = useTestSavedAiProvider(scope);

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

  const showError =
    provider.is_active && provider.last_status && provider.last_status !== 'ok' && provider.last_error;

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
            {modelSeesImages(provider.kind, provider.model) && <Badge tone="success">👁 visão</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {KIND_LABEL[provider.kind]} · {provider.model}
            {provider.key_masked ? ` · chave ${provider.key_masked}` : ' · sem chave'}
          </p>
          {scope === 'tenant' && (
            <p className="mt-0.5 truncate text-xs text-text-secondary">
              Atende no: <span className="font-medium text-text-primary">{formatPhoneBadge(provider)}</span>
            </p>
          )}
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
  scope,
  open,
  onClose,
  provider,
  suggestedPriority,
  suggestedConnectionId,
}: {
  scope: AiScope;
  open: boolean;
  onClose: () => void;
  provider?: AiProviderDto;
  suggestedPriority: number;
  suggestedConnectionId?: string;
}) {
  const isEdit = Boolean(provider);
  const create = useCreateAiProvider(scope);
  const update = useUpdateAiProvider(scope);
  const testCreds = useTestAiCreds(scope);
  const listCreds = useListAiModels(scope);
  const listSaved = useListSavedAiModels(scope);

  const [presetId, setPresetId] = useState('claude');
  const [kind, setKind] = useState<AiKind>('anthropic');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [priority, setPriority] = useState(0);
  const [isActive, setIsActive] = useState(true);
  /** '' = todos os números; uuid = conexão (número + instância) escolhida. */
  const [connectionId, setConnectionId] = useState('');
  const { data: waData, refetch: refetchWa, isFetching: waFetching } = useWhatsappConnections();
  const waConnections = scope === 'tenant' ? (waData?.connections ?? []) : [];
  // Modelos REAIS do provedor (buscados na API) para o seletor.
  const [realModels, setRealModels] = useState<string[] | null>(null);
  const modelsTagRef = useRef('');

  // Ao abrir o modal, atualiza números reais das instâncias (Z-API /device).
  useEffect(() => {
    if (!open || scope !== 'tenant') return;
    void refetchWa();
  }, [open, scope, refetchWa]);

  useEffect(() => {
    if (!open) return;
    setRealModels(null);
    modelsTagRef.current = '';
    if (provider) {
      setKind(provider.kind);
      setLabel(provider.label);
      setModel(provider.model);
      setBaseUrl(provider.base_url ?? '');
      setApiKey('');
      setPriority(provider.priority);
      setIsActive(provider.is_active);
      setConnectionId(provider.connection_id ?? '');
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
      // Preferência: conexão do workspace; senão número conectado; senão o primeiro.
      const preferred =
        (suggestedConnectionId &&
          waConnections.find((c) => c.id === suggestedConnectionId)) ||
        waConnections.find((c) => c.isActive && c.configured) ||
        waConnections[0];
      setConnectionId(preferred?.id ?? '');
    }
  }, [open, provider, suggestedPriority, suggestedConnectionId]); // eslint-disable-line react-hooks/exhaustive-deps -- só ao abrir modal

  // Editar provedor conectado: busca os modelos reais com a chave JÁ salva
  // (o front não a tem) — é o que permite trocar de modelo sem redigitar a chave.
  useEffect(() => {
    if (!open || !provider || !provider.has_key) return;
    const tag = `saved:${provider.id}`;
    if (modelsTagRef.current === tag) return;
    modelsTagRef.current = tag;
    listSaved.mutate(provider.id, {
      onSuccess: (r) => setRealModels(r.ok ? r.models : null),
      onError: () => setRealModels(null),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider]);

  // Nova chave digitada (provedor novo ou troca de chave): lista com a chave.
  useEffect(() => {
    if (!open) return;
    const key = apiKey.trim();
    if (key.length < 8) return;
    const tag = `creds:${kind}|${baseUrl.trim()}|${key}`;
    if (modelsTagRef.current === tag) return;
    const timer = setTimeout(() => {
      modelsTagRef.current = tag;
      listCreds.mutate(
        { kind, apiKey: key, baseUrl: baseUrl.trim() || undefined },
        {
          onSuccess: (r) => setRealModels(r.ok ? r.models : null),
          onError: () => setRealModels(null),
        },
      );
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, apiKey, kind, baseUrl]);

  function applyPreset(id: string) {
    setPresetId(id);
    const p = AI_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    setLabel(p.label);
    setModel(p.model);
    setBaseUrl(p.baseUrl);
  }

  // Modelos disponíveis: os REAIS do provedor (se já buscados) com os rótulos
  // curados por cima; sem lista real, cai nos curados (kind + base URL).
  const effectivePreset = presetIdFor(kind, baseUrl);
  const modelOptions = mergeModelOptions(realModels, MODELS_BY_PRESET[effectivePreset] ?? [], kind);
  const modelInList = modelOptions.some((m) => m.id === model);
  const loadingModels = listSaved.isPending || listCreds.isPending;

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
          ...(scope === 'tenant' ? { connectionId: connectionId || null } : {}),
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
          ...(scope === 'tenant' ? { connectionId: connectionId || null } : {}),
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
        {modelOptions.length > 0 ? (
          <>
            <Select
              label="Modelo"
              value={modelInList ? model : '__custom__'}
              onChange={(e) => setModel(e.target.value === '__custom__' ? '' : e.target.value)}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.free ? ' (cota grátis)' : ''}
                  {m.vision ? ' · 👁 vê imagens' : ''}
                </option>
              ))}
              <option value="__custom__">Outro (digitar)…</option>
            </Select>
            {loadingModels ? (
              <span className="text-xs text-text-secondary">Buscando os modelos reais do provedor…</span>
            ) : realModels && realModels.length > 0 ? (
              <span className="text-xs text-success">
                {realModels.length} modelos reais do provedor — escolha e salve para trocar.
              </span>
            ) : null}
            {!modelInList && (
              <CustomModelField
                label="Modelo (personalizado)"
                scope={scope}
                kind={kind}
                baseUrl={baseUrl}
                presetId={effectivePreset}
                apiKey={apiKey}
                model={model}
                onModel={setModel}
              />
            )}
          </>
        ) : (
          <CustomModelField
            label="Modelo"
            scope={scope}
            kind={kind}
            baseUrl={baseUrl}
            presetId={effectivePreset}
            apiKey={apiKey}
            model={model}
            onModel={setModel}
          />
        )}
        <p className="-mt-1 rounded-lg bg-primary-light px-3 py-2 text-xs text-text-secondary">
          👁 Modelos com esse selo <strong>enxergam fotos e vídeos</strong> que o cliente enviar e
          respondem com base no seu catálogo (ex.: cliente manda a foto de um produto perguntando se
          você tem).
        </p>
        {scope === 'tenant' && (
          <div className="flex flex-col gap-1">
            <Select
              label="Número usado no atendimento"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              disabled={waFetching && waConnections.length === 0}
            >
              <option value="">Todos os números cadastrados</option>
              {waConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatPhoneOption(c)}
                </option>
              ))}
            </Select>
            <p className="text-xs text-text-secondary">
              {waFetching
                ? 'Buscando o número real da instância WhatsApp…'
                : 'Escolha o telefone com que a IA vai falar com os clientes. A conexão técnica fica vinculada automaticamente.'}
            </p>
          </div>
        )}
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

/**
 * Campo de modelo "Outro" com inteligência:
 *   - autocompleta a partir do catálogo REAL do provedor (datalist);
 *   - detecta ao vivo quando o modelo digitado NÃO existe e sugere o nome certo
 *     (corrige typos por similaridade);
 *   - sem chave, cai numa checagem offline de formato (heurística por provedor).
 * O catálogo é buscado uma vez por credencial (cache) e revalidado localmente
 * a cada tecla — sem martelar a API do provedor.
 */
function CustomModelField({
  label,
  scope,
  kind,
  baseUrl,
  presetId,
  apiKey,
  model,
  onModel,
}: {
  label: string;
  scope: AiScope;
  kind: AiKind;
  baseUrl: string;
  presetId: string;
  apiKey: string;
  model: string;
  onModel: (value: string) => void;
}) {
  const list = useListAiModels(scope);
  const [models, setModels] = useState<string[] | null>(null);
  const [authError, setAuthError] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const loadedKeyRef = useRef('');

  const key = apiKey.trim();
  const canList = key.length >= 8;
  const credKey = `${kind}|${baseUrl.trim()}|${key}`;

  useEffect(() => {
    if (!canList) {
      setModels(null);
      setAuthError(false);
      setListError(null);
      loadedKeyRef.current = '';
      return;
    }
    if (credKey === loadedKeyRef.current) return; // já temos esse catálogo
    const timer = setTimeout(() => {
      list.mutate(
        { kind, apiKey: key, baseUrl: baseUrl.trim() || undefined },
        {
          onSuccess: (r) => {
            loadedKeyRef.current = credKey;
            setAuthError(r.authError);
            setListError(r.ok ? null : r.error ?? 'não foi possível listar');
            setModels(r.ok ? r.models : null);
          },
          onError: () => {
            setModels(null);
            setAuthError(false);
            setListError('falha de rede');
          },
        },
      );
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credKey, canList]);

  const trimmed = model.trim();
  const inCatalog = models?.includes(trimmed) ?? false;
  const suggestions = models && trimmed && !inCatalog ? closestModels(trimmed, models, 4) : [];
  const heuristic = modelHeuristicWarning(presetId, kind, trimmed);
  const datalistId = `ai-models-${scope}`;

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        label={label}
        value={model}
        onChange={(e) => onModel(e.target.value)}
        placeholder="Cole o identificador exato do modelo"
        list={models && models.length ? datalistId : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {models && models.length > 0 && (
        <datalist id={datalistId}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}

      {modelSeesImages(kind, trimmed) && (
        <span className="text-xs text-primary">👁 Este modelo enxerga imagens/vídeos enviados pelo cliente.</span>
      )}

      {list.isPending ? (
        <span className="text-xs text-text-secondary">Buscando modelos disponíveis no provedor…</span>
      ) : !canList ? (
        <span className={heuristic ? 'text-xs text-warning' : 'text-xs text-text-secondary'}>
          {heuristic ?? 'Informe a chave de API para validar o modelo automaticamente.'}
        </span>
      ) : authError ? (
        <span className="text-xs text-danger">Chave inválida — não foi possível listar os modelos.</span>
      ) : !models ? (
        <span className={heuristic ? 'text-xs text-warning' : 'text-xs text-text-secondary'}>
          {heuristic ??
            `Não consegui listar os modelos${listError ? ` (${listError})` : ''}; confira o ID no painel do provedor.`}
        </span>
      ) : !trimmed ? (
        <span className="text-xs text-text-secondary">
          {models.length} modelos disponíveis — comece a digitar para autocompletar.
        </span>
      ) : inCatalog ? (
        <span className="text-xs text-success">✓ Modelo válido neste provedor.</span>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-danger">
            Modelo “{trimmed}” não existe neste provedor.
          </span>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-text-secondary">Você quis dizer:</span>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onModel(s)}
                  className="rounded-full border border-primary/40 bg-primary-light px-2 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/10"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
