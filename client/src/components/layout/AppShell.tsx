import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { BottomNav } from './BottomNav';
import { BlockFab } from '@/components/features/BlockAccess';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  // Desativa o menu de contexto do navegador (que aparece ao "segurar" a tela
  // em alguns dispositivos/Chrome), deixando os gestos de long-press do app.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="no-scrollbar flex-1 overflow-y-auto pb-24 md:pb-6">
          <div key={location.pathname} className="mx-auto w-full max-w-3xl animate-fade-in">
            {children}
          </div>
        </main>
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
    <header className="safe-top glass sticky top-0 z-20 border-x-0 border-t-0 border-b border-border/70">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3.5">
        {leading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-extrabold tracking-tight text-text-primary">
            {title}
          </h1>
          {subtitle && <p className="truncate text-xs font-medium text-text-secondary">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
