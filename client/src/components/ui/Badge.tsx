import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

const tones: Record<Tone, string> = {
  primary: 'bg-primary-light text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-black/5 text-text-secondary',
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
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
