import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe, useSetupStatus } from '../api/hooks.ts';
import { ErrorState, LoadingBlock } from './ui.tsx';

/**
 * Decides where the user belongs:
 *  - setup not complete → /setup
 *  - not signed in      → /login?next=<current path>
 *  - otherwise          → render children / nested routes
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const setup = useSetupStatus();
  const me = useMe();
  const location = useLocation();

  if (setup.isPending || me.isPending) return <LoadingBlock />;
  if (setup.isError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorState
          error={setup.error}
          title="Could not reach the server"
          onRetry={() => void setup.refetch()}
        />
      </div>
    );
  }
  if (!setup.data.completed) return <Navigate to="/setup" replace />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) {
    const next = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'}
        replace
      />
    );
  }
  return <>{children ?? <Outlet />}</>;
}

export function RequireAdmin({ children }: { children?: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <LoadingBlock />;
  if (me.data?.user.role !== 'admin') {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorState
          error={new Error('Only admins can open this page. Ask an admin if you need access.')}
          title="Admins only"
        />
      </div>
    );
  }
  return <>{children ?? <Outlet />}</>;
}

/** Only allows `next` targets inside this app (prevents open redirects). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
