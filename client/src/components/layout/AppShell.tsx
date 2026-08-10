import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { BottomNav } from './BottomNav';
import { BlockFab } from '@/components/features/BlockAccess';
import { cn } from '@/utils/cn';

interface AppShellProps {
  children: ReactNode;
}

/** Chat aberto: /conversas/:id — ou tela “colar conversa” (mesmo layout fixo). */
function isChatLikePath(pathname: string): boolean {
  return /^\/conversas\/[^/]+\/?$/.test(pathname) || pathname === '/colar-conversa';
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const chatOpen = isChatLikePath(location.pathname);

  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  return (
    <div className={cn('flex', chatOpen ? 'h-dvh max-h-dvh overflow-hidden' : 'h-full min-h-screen')}>
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <main
          className={cn(
            'min-h-0 flex-1',
            chatOpen ? 'relative overflow-hidden' : 'no-scrollbar overflow-y-auto pb-24 md:pb-6',
          )}
        >
          <div
            key={location.pathname}
            className={cn(
              'mx-auto w-full max-w-3xl',
              chatOpen ? 'h-full overflow-hidden' : 'animate-rise',
            )}
          >
            {children}
          </div>
        </main>
        {/* Menu inferior só na lista / outras telas — some no chat aberto. */}
        {!chatOpen && <BottomNav />}
      </div>
      {/* Cadeado some no chat (cobria o botão enviar). */}
      {!chatOpen && <BlockFab />}
    </div>
  );
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  leading?: ReactNode;
  sticky?: boolean;
}

export function PageHeader({ title, subtitle, action, leading, sticky = true }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'safe-top glass z-20 shrink-0 border-x-0 border-t-0 border-b border-border/70',
        sticky && 'sticky top-0',
      )}
    >
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
