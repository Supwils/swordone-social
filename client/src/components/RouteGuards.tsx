import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '@/stores/session.store';
import { Spinner } from '@/components/primitives';
import s from './RouteGuards.module.css';

function BootstrapGate({ children }: { children: ReactNode }) {
  const bootstrap = useSession((st) => st.bootstrap);
  if (bootstrap === 'pending') {
    // No role="status" on the wrapper: Spinner already declares one, and
    // nesting two live regions makes a screen reader announce the same load
    // twice.
    return (
      <div className={s.bootstrap}>
        <Spinner />
      </div>
    );
  }
  return <>{children}</>;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  return (
    <BootstrapGate>
      <RequireAuth>{children}</RequireAuth>
    </BootstrapGate>
  );
}

/**
 * Sends anonymous visitors to /login. With no children it is a pathless layout
 * route (`<Route element={<RequireAuth />}>`) that renders the matched child via
 * `<Outlet />`, so it can nest INSIDE the one AppShell layout: the shell then
 * stays mounted when a visitor crosses between open and personal pages.
 * Assumes an ancestor already waited on the bootstrap probe (`OpenRoute`).
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const user = useSession((st) => st.user);
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children ?? <Outlet />}</>;
}

/**
 * Renders for signed-out visitors as well as members. Still waits on the
 * bootstrap probe, so a signed-in user never flashes the anonymous view before
 * `/auth/me` resolves — the reason this cannot just be the bare element.
 *
 * Used for the routes whose whole value is being linkable without an account:
 * the global feed, single posts, profiles, and the observation lab. The server
 * serves these with `optionalUser`, so an anonymous request simply sees public
 * content.
 */
export function OpenRoute({ children }: { children: ReactNode }) {
  return <BootstrapGate>{children}</BootstrapGate>;
}

export function PublicRoute({
  children,
  redirectIfAuthed = '/feed',
}: {
  children: ReactNode;
  redirectIfAuthed?: string;
}) {
  return (
    <BootstrapGate>
      <RedirectIfAuthed to={redirectIfAuthed}>{children}</RedirectIfAuthed>
    </BootstrapGate>
  );
}

function RedirectIfAuthed({ children, to }: { children: ReactNode; to: string }) {
  const user = useSession((st) => st.user);
  if (user) return <Navigate to={to} replace />;
  return <>{children}</>;
}
