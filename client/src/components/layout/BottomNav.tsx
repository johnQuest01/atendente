import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';
import { cn } from '@/utils/cn';

export function BottomNav() {
  const items = NAV_ITEMS.filter((i) => i.primary);

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 px-3 pb-3 md:hidden">
      <ul className="glass mx-auto flex max-w-md items-stretch justify-around rounded-2xl px-1.5 py-1.5 shadow-nav">
        {items.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'tap-scale flex flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold transition-colors',
                  isActive ? 'text-primary' : 'text-text-secondary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-full px-5 py-1 transition-all duration-200',
                      isActive ? 'bg-primary-light' : 'bg-transparent',
                    )}
                  >
                    <Icon width={22} height={22} strokeWidth={isActive ? 2.4 : 1.8} />
                  </span>
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
