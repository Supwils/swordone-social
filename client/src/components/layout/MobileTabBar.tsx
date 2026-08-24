import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  Bell,
  User as UserIcon,
  NotePencil,
  UsersThree,
  Atom,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { Dialog } from '@/components/primitives/Dialog';
import { PostComposer } from '@/features/posts/PostComposer';
import s from './MobileTabBar.module.css';

export function MobileTabBar() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const [composerOpen, setComposerOpen] = useState(false);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(s.tab, isActive && s.tabActive);

  return (
    <>
      {/*
        The bar is auth-aware. Signed out, `Following` and `Notifications` are
        protected routes that bounce straight to /login, so offering them is a
        dead end; and because the sidebar is display:none under 720px, this bar
        was previously the ONLY nav on mobile — leaving the lab unreachable
        without typing the URL. Anonymous visitors get the public surfaces
        instead.
      */}
      <nav className={s.tabBar} aria-label={t('nav.bottom')}>
        {user ? (
          <>
            <NavLink to="/feed" className={linkClass} end>
              <HouseSimple weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.following')}</span>
            </NavLink>
            <NavLink to="/global" className={linkClass}>
              <Globe weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.global')}</span>
            </NavLink>
            <button
              className={s.composeBtn}
              onClick={() => setComposerOpen(true)}
              aria-label={t('nav.newPost')}
            >
              <span className={s.composeBtnInner}>
                <NotePencil weight="regular" size={20} aria-hidden />
              </span>
            </button>
            <NavLink to="/notifications" className={linkClass}>
              <Bell weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.notifications')}</span>
              {unreadN > 0 && <span className={s.dot} aria-label={t('nav.unread', { count: unreadN })} />}
            </NavLink>
            <NavLink to={`/u/${user.username}`} className={linkClass}>
              <UserIcon weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.profile')}</span>
            </NavLink>
          </>
        ) : (
          <>
            <NavLink to="/global" className={linkClass}>
              <Globe weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.global')}</span>
            </NavLink>
            <NavLink to="/explore" className={linkClass}>
              <UsersThree weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.people')}</span>
            </NavLink>
            <NavLink to="/lab" className={linkClass}>
              <Atom weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.lab')}</span>
            </NavLink>
            <NavLink to="/login" className={linkClass}>
              <UserIcon weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('auth.signIn')}</span>
            </NavLink>
          </>
        )}
      </nav>
      {user && (
        <Dialog
          open={composerOpen}
          onOpenChange={setComposerOpen}
          title={t('nav.newPost')}
          titleHidden
        >
          <PostComposer bare onSuccess={() => setComposerOpen(false)} />
        </Dialog>
      )}
    </>
  );
}
