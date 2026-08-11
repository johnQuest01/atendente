import { Select } from '@/components/ui/Input';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { formatPhone } from '@/utils/formatters';
import { cn } from '@/utils/cn';

function labelFor(phone: string | null, name: string): string {
  const digits = phone?.replace(/\D/g, '') ?? '';
  if (digits.length >= 10) return `${formatPhone(digits)} · ${name}`;
  if (digits) return `${digits} · ${name}`;
  return name;
}

interface ConnectionNumberPickerProps {
  value: string;
  onChange: (connectionId: string) => void;
  label?: string;
  className?: string;
  /** Se true, mostra cards grandes em vez de select. */
  cards?: boolean;
}

/** Escolha obrigatória do WhatsApp (instância) para export/import/colar/lista. */
export function ConnectionNumberPicker({
  value,
  onChange,
  label = 'Número WhatsApp',
  className,
  cards = false,
}: ConnectionNumberPickerProps) {
  const { data, isLoading } = useWhatsappConnections();
  const connections = (data?.connections ?? []).filter((c) => c.isActive !== false);

  if (isLoading) {
    return <p className="text-xs text-text-secondary">Carregando números…</p>;
  }

  if (connections.length === 0) {
    return (
      <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
        Cadastre um WhatsApp em Configurações → Números WhatsApp antes de continuar.
      </p>
    );
  }

  if (cards) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        <p className="text-xs text-text-secondary">
          Cada número tem conversas e histórico isolados — nada vaza entre instâncias.
        </p>
        {connections.map((c) => {
          const selected = value === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(c.id)}
              className={cn(
                'tap-scale rounded-2xl border px-4 py-3 text-left transition',
                selected
                  ? 'border-primary bg-primary-light shadow-glow'
                  : 'border-border bg-surface hover:border-primary/40',
              )}
            >
              <p className="text-sm font-bold text-text-primary">
                {c.phoneNumber?.replace(/\D/g, '') || c.label}
              </p>
              <p className="text-xs text-text-secondary">{labelFor(c.phoneNumber, c.label)}</p>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={className}>
      <Select
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        hint="Só este número/instância usa o que você cadastrar aqui."
      >
        <option value="">Selecione o número…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {labelFor(c.phoneNumber, c.label)}
          </option>
        ))}
      </Select>
    </div>
  );
}
