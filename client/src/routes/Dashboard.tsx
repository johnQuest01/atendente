import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/Card';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { useDashboard } from '@/hooks/useDashboard';
import { useAuth } from '@/hooks/useAuth';

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card className="card-hover flex flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      <span className={`text-3xl font-extrabold tracking-tight ${tone}`}>{value}</span>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useDashboard();

  return (
    <>
      <PageHeader
        title={`Olá, ${user?.name?.split(' ')[0] ?? 'bem-vindo(a)'} 👋`}
        subtitle="Resumo de hoje"
      />

      {isLoading && <Spinner label="Carregando métricas..." />}
      {isError && <ErrorState message="Não foi possível carregar o dashboard." onRetry={() => void refetch()} />}

      {data && (
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="Conversas abertas" value={data.metrics.open_conversations} tone="text-primary" />
            <MetricCard label="Aguardando" value={data.metrics.waiting_conversations} tone="text-warning" />
            <MetricCard label="Enviadas hoje" value={data.metrics.messages_sent_today} tone="text-success" />
            <MetricCard label="Recebidas hoje" value={data.metrics.messages_received_today} tone="text-text-primary" />
          </div>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Atividade (24h)</h2>
            {data.activity.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-secondary">Sem atividade nas últimas 24h.</p>
            ) : (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.activity} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="in" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6D4AFF" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#6D4AFF" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="out" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#16B364" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#16B364" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ECEDF3" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#6A7385' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#6A7385' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="inbound" stroke="#6D4AFF" fill="url(#in)" strokeWidth={2.5} name="Recebidas" />
                    <Area type="monotone" dataKey="outbound" stroke="#16B364" fill="url(#out)" strokeWidth={2.5} name="Enviadas" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold text-text-primary">Áudios mais usados</h2>
            {data.topAudios.length === 0 ? (
              <EmptyState title="Nenhum áudio usado ainda" description="Os áudios mais enviados aparecerão aqui." />
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {data.topAudios.map((a, idx) => (
                  <li key={a.id} className="flex items-center gap-3 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-light text-xs font-bold text-primary">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{a.title}</p>
                      <p className="text-xs text-text-secondary">{a.category}</p>
                    </div>
                    <span className="text-sm font-semibold text-text-secondary">{a.usage_count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
