import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/utils/cn';
import { initials } from '@/utils/formatters';

export function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-black text-white">
          M
        </div>
        <div>
          <p className="text-sm font-bold leading-tight text-text-primary">Mayra AI</p>
          <p className="text-xs text-text-secondary">Sales</p>
        </div>
      </div>

      <nav className="flex-1 px-3">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary-light text-primary'
                      : 'text-text-secondary hover:bg-black/5',
                  )
                }
              >
                <Icon width={20} height={20} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
            {initials(user?.name ?? null)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary">{user?.name ?? 'Usuário'}</p>
            <p className="truncate text-xs text-text-secondary">{user?.email}</p>
          </div>
          <button onClick={logout} className="tap-scale text-xs font-semibold text-danger">
            Sair
          </button>
        </div>
      </div>
    </aside>
  );
}
