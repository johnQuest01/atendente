import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/utils/cn';

export interface SectionListItem {
  id: string;
  label: string;
  description?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export function SectionList({
  items,
  onSelect,
  className,
}: {
  items: SectionListItem[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  return (
    <ul className={cn('flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface', className)}>
      {items.map(({ id, label, description, icon: Icon }) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => onSelect(id)}
            className="tap-scale flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-black/[0.03]"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
              <Icon width={20} height={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary">{label}</p>
              {description && (
                <p className="truncate text-xs text-text-secondary">{description}</p>
              )}
            </div>
            <span className="text-lg text-text-secondary" aria-hidden>
              ›
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
