import { Outlet, Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { MobileTabBar } from './MobileTabBar';
import { RouteTransition } from '@/components/RouteTransition';
import { CommandPalette } from '@/components/CommandPalette';
import { useUI } from '@/stores/ui.store';
import { useSession } from '@/stores/session.store';
import s from './AppShell.module.css';

export function AppShell() {
  const feedLayout = useUI((st) => st.feedLayout);
  const user = useSession((st) => st.user);
  const { pathname } = useLocation();
  // Which routes render a post list, and so may widen into the grid layout.
  // Was `tags/` — but the route is `/tag/:slug` (singular), so tag pages never
  // actually got the wide column; `/board/:slug` was missing entirely.
  const isFeedRoute = /^\/(feed|global|tag\/|board\/)/.test(pathname);

  return (
    <div className={s.shell}>
      <Sidebar />
      <header className={s.topBar}>
        <Link to={user ? '/feed' : '/global'} className={s.topBarBrand}>
          swordone
        </Link>
      </header>
      <main className={s.main}>
        <div className={clsx(s.column, isFeedRoute && feedLayout === 'grid' && s.columnWide)}>
          <RouteTransition>
            <Outlet />
          </RouteTransition>
        </div>
      </main>
      <MobileTabBar />
      <CommandPalette />
    </div>
  );
}
