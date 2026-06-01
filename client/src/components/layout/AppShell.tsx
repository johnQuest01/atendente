import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { BottomNav } from './BottomNav';
import { BlockFab } from '@/components/features/BlockAccess';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-full min-h-screen bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="no-scrollbar flex-1 overflow-y-auto pb-20 md:pb-0">{children}</main>
        <BottomNav />
      </div>
      <BlockFab />
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  leading?: ReactNode;
}

/** Cabeçalho de página com safe-area e sticky no topo. */
export function PageHeader({ title, subtitle, action, leading }: PageHeaderProps) {
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur-lg">
      <div className="flex items-center gap-3 px-4 py-3.5">
        {leading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-text-primary">{title}</h1>
          {subtitle && <p className="truncate text-xs text-text-secondary">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
