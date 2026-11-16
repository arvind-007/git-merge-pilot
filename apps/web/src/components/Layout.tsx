import { clsx } from 'clsx';
import {
  Bell,
  FolderKanban,
  GitMerge,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldAlert,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLogout, useMe, useNotifications, useOverview } from '../api/hooks.ts';
import { AiBudgetBanner } from './banners.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  adminOnly?: boolean;
  badge?: number;
}

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-50',
        className,
      )}
    >
      <span className="grid size-7 place-items-center rounded-lg bg-indigo-600 text-white">
        <GitMerge className="size-4" aria-hidden />
      </span>
      git-merge-pilot
    </span>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end ?? false}
            onClick={onNavigate}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-500',
                isActive
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                  : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )
            }
          >
            <span className="[&_svg]:size-4">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span
                className="rounded-full bg-indigo-600 px-1.5 text-xs text-white tabular-nums"
                aria-label={`${item.badge} unread`}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            ) : null}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Layout() {
  const me = useMe();
  const isAdmin = me.data?.user.role === 'admin';
  const overview = useOverview();
  const unread = useNotifications(true);
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const items: NavItem[] = [
    { to: '/', label: 'Overview', icon: <LayoutDashboard />, end: true },
    { to: '/projects', label: 'Projects', icon: <FolderKanban /> },
    { to: '/risk', label: 'Risk center', icon: <ShieldAlert /> },
    { to: '/developers', label: 'Developers', icon: <Users /> },
    {
      to: '/notifications',
      label: 'Notifications',
      icon: <Bell />,
      badge: unread.data?.length ?? 0,
    },
    { to: '/settings', label: 'Settings', icon: <Settings />, adminOnly: true },
  ].filter((i) => !i.adminOnly || isAdmin);

  const onLogout = () =>
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });

  const userBlock = (
    <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
      <div className="px-3 text-sm">
        <div className="truncate font-medium text-slate-900 dark:text-slate-100">
          {me.data?.user.name}
        </div>
        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
          {me.data?.user.email} · {me.data?.user.role}
        </div>
      </div>
      <button
        type="button"
        onClick={onLogout}
        className="mt-2 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <LogOut className="size-4" aria-hidden /> Sign out
      </button>
    </div>
  );

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-white px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 dark:bg-slate-900"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white p-3 lg:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="px-3 py-2">
          <Logo />
          {me.data?.org.name && (
            <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
              {me.data.org.name}
            </div>
          )}
        </div>
        <nav aria-label="Main" className="mt-4 flex-1 overflow-y-auto">
          <NavList items={items} />
        </nav>
        {userBlock}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/90">
        <Logo />
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          className="rounded-lg p-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {menuOpen ? (
            <X className="size-5" aria-hidden />
          ) : (
            <Menu className="size-5" aria-hidden />
          )}
          <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
        </button>
      </header>
      {menuOpen && (
        <div
          id="mobile-nav"
          className="fixed inset-x-0 top-[53px] bottom-0 z-20 overflow-y-auto bg-white p-3 lg:hidden dark:bg-slate-900"
        >
          <nav aria-label="Main">
            <NavList items={items} onNavigate={() => setMenuOpen(false)} />
          </nav>
          <div className="mt-4">{userBlock}</div>
        </div>
      )}

      <main id="main" className="lg:pl-60">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
          <div className="mb-4 empty:hidden">
            {/* Budget exhaustion is shown everywhere; the "AI off" notice lives on Overview and PR pages. */}
            {overview.data?.ai?.enabled && overview.data.ai.budgetExhausted ? (
              <AiBudgetBanner status={overview.data.ai} isAdmin={isAdmin} />
            ) : null}
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
