import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

const tones: Record<Tone, string> = {
  primary: 'bg-primary-light text-primary ring-1 ring-primary/15',
  success: 'bg-success/12 text-success ring-1 ring-success/20',
  warning: 'bg-warning/12 text-warning ring-1 ring-warning/20',
  danger: 'bg-danger/12 text-danger ring-1 ring-danger/20',
  neutral: 'bg-black/[0.04] text-text-secondary ring-1 ring-black/[0.06]',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
