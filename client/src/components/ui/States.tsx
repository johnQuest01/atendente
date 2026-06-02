import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/** Bloco de "esqueleto" com brilho deslizante para estados de carregamento. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

/** Lista de placeholders (avatar + 2 linhas) — usada ao carregar conversas. */
export function ListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-secondary">
      <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-primary/70">{icon}</div>}
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {description && <p className="max-w-xs text-sm text-text-secondary">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-sm font-semibold text-primary">
          Tentar novamente
        </button>
      )}
    </div>
  );
}
