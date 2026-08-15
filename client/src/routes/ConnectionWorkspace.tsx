import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/States';
import {
  BackIcon,
  ChatIcon,
  DashboardIcon,
  EditIcon,
  KeyIcon,
  SettingsIcon,
  SparklesIcon,
  TextIcon,
} from '@/components/ui/Icons';
import { SectionList, type SectionListItem } from '@/components/connection/SectionList';
import { OverviewSection } from '@/components/connection/OverviewSection';
import { AiBehaviorSection } from '@/components/connection/AiBehaviorSection';
import { KeywordsSection } from '@/components/connection/KeywordsSection';
import { RemindersSection } from '@/components/connection/RemindersSection';
import { SecretaryPlaybookSection } from '@/components/connection/SecretaryPlaybookSection';
import { AdvancedSection } from '@/components/connection/AdvancedSection';
import { getConnectionStatus } from '@/components/connection/connectionStatus';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { useAuth } from '@/hooks/useAuth';
import { formatPhone } from '@/utils/formatters';

type SectionId = 'overview' | 'playbook' | 'ai' | 'keywords' | 'reminders' | 'advanced';

const ESSENTIAL_SECTIONS: SectionListItem[] = [
  {
    id: 'reminders',
    label: 'Números e horários',
    description: 'Quem usa a secretária e em quais dias/horas',
    icon: TextIcon,
  },
  {
    id: 'overview',
    label: 'Visão geral',
    description: 'Atendente, status e credenciais',
    icon: DashboardIcon,
  },
  {
    id: 'playbook',
    label: 'Treino da secretária',
    description: 'Escreva regras; ela interpreta e executa',
    icon: EditIcon,
  },
  {
    id: 'ai',
    label: 'Como a IA atende',
    description: 'Instruções e tom de voz',
    icon: SparklesIcon,
  },
  {
    id: 'keywords',
    label: 'Palavras que chamam a IA',
    description: 'Disparos sem gastar IA',
    icon: KeyIcon,
  },
  {
    id: 'reminders',
    label: 'Números e horários',
    description: 'Quem usa a secretária e em quais dias/horas',
    icon: TextIcon,
  },
];

const ADVANCED_SECTION: SectionListItem = {
  id: 'advanced',
  label: 'Avançado',
  description: 'Modelo de IA e ajuste fino',
  icon: SettingsIcon,
};

function isSectionId(value: string | null): value is SectionId {
  return (
    value === 'overview' ||
    value === 'playbook' ||
    value === 'ai' ||
    value === 'keywords' ||
    value === 'reminders' ||
    value === 'advanced'
  );
}

export default function ConnectionWorkspace() {
  const { connectionId = '' } = useParams<{ connectionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'superadmin';
  const { data, isLoading } = useWhatsappConnections();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const sectionParam = searchParams.get('section');
  const activeSection = isSectionId(sectionParam) ? sectionParam : null;

  const conn = useMemo(
    () => data?.connections.find((c) => c.id === connectionId),
    [data, connectionId],
  );

  function openSection(id: string) {
    setSearchParams({ section: id }, { replace: false });
  }

  function closeSection() {
    setSearchParams({}, { replace: false });
  }

  if (!connectionId) return <Navigate to="/" replace />;

  if (isLoading) {
    return (
      <>
        <PageHeader title="Conexão" />
        <Spinner label="Carregando..." />
      </>
    );
  }

  if (!conn) {
    return <Navigate to="/" replace />;
  }

  const status = getConnectionStatus(conn);
  const phone = conn.phoneNumber?.replace(/\D/g, '') ?? '';
  const phoneLabel =
    phone.length >= 10 ? formatPhone(phone) : conn.phoneNumber || 'Número não detectado';

  const sectionTitle =
    activeSection === 'overview'
      ? 'Visão geral'
      : activeSection === 'playbook'
        ? 'Treino da secretária'
        : activeSection === 'ai'
        ? 'Como a IA atende'
        : activeSection === 'keywords'
          ? 'Palavras que chamam a IA'
          : activeSection === 'reminders'
            ? 'Números e horários'
            : activeSection === 'advanced'
              ? 'Avançado'
              : conn.label;

  return (
    <>
      <PageHeader
        title={activeSection ? sectionTitle : conn.label}
        subtitle={activeSection ? conn.label : phoneLabel}
        leading={
          <Button
            size="sm"
            variant="ghost"
            aria-label="Voltar"
            onClick={() => (activeSection ? closeSection() : navigate('/'))}
          >
            <BackIcon width={20} height={20} />
          </Button>
        }
        action={!activeSection ? <Badge tone={status.tone}>{status.label}</Badge> : undefined}
      />

      <div className="flex flex-col gap-4 p-4">
        {!activeSection && (
          <>
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{phoneLabel}</p>
                <p className="text-xs text-text-secondary">Status desta conexão</p>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>

            <SectionList items={ESSENTIAL_SECTIONS} onSelect={openSection} />

            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="tap-scale flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-black/[0.03]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg text-text-secondary">
                  <SettingsIcon width={20} height={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text-primary">Avançado</p>
                  <p className="truncate text-xs text-text-secondary">
                    Modelo de IA e ajuste fino
                  </p>
                </div>
                <span className="text-lg text-text-secondary" aria-hidden>
                  {advancedOpen ? '▾' : '›'}
                </span>
              </button>
              {advancedOpen && (
                <div className="border-t border-border px-2 pb-2">
                  <SectionList
                    items={[ADVANCED_SECTION]}
                    onSelect={openSection}
                    className="border-0"
                  />
                </div>
              )}
            </div>

            <Link
              to="/conversas"
              className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:border-primary/40 hover:text-text-primary"
            >
              <ChatIcon width={18} height={18} />
              Ver contatos / conversas
            </Link>
          </>
        )}

        {activeSection === 'overview' && (
          <OverviewSection connectionId={connectionId} canEdit={canEdit} />
        )}
        {activeSection === 'playbook' && (
          <SecretaryPlaybookSection connectionId={connectionId} canEdit={canEdit} />
        )}
        {activeSection === 'ai' && (
          <AiBehaviorSection connectionId={connectionId} canEdit={canEdit} />
        )}
        {activeSection === 'keywords' && (
          <KeywordsSection connectionId={connectionId} canEdit={canEdit} />
        )}
        {activeSection === 'reminders' && canEdit && (
          <RemindersSection connectionId={connectionId} canEdit={canEdit} />
        )}
        {activeSection === 'reminders' && !canEdit && (
          <p className="text-sm text-text-secondary">Apenas administradores gerenciam lembretes.</p>
        )}
        {activeSection === 'advanced' && (
          <AdvancedSection connectionId={connectionId} canEdit={canEdit} />
        )}
      </div>
    </>
  );
}
