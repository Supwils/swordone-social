import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  Bell,
  User as UserIcon,
  NotePencil,
  UsersThree,
  Atom,
  DotsThree,
  ChatsCircle,
  BookmarkSimple,
  Gear,
  SignOut,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { Dialog } from '@/components/primitives/Dialog';
import { PostComposer } from '@/features/posts/PostComposer';
import { useLogout } from '@/lib/useLogout';
import s from './MobileTabBar.module.css';

export function MobileTabBar() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const unreadC = useRealtime((st) => st.unreadConversations);
  const logout = useLogout();
  const [moreOpen, setMoreOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const linkClass = ({ isActive }: { isActive: boolean }) => clsx(s.tab, isActive && s.tabActive);

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
              {unreadN > 0 && (
                <span className={s.dot} aria-label={t('nav.unread', { count: unreadN })} />
              )}
            </NavLink>
            <NavLink to={`/u/${user.username}`} className={linkClass}>
              <UserIcon weight="regular" className={s.tabIcon} aria-hidden />
              <span>{t('nav.profile')}</span>
            </NavLink>
            {/* The sidebar is hidden on mobile, so Messages, Bookmarks,
                Settings and Sign out live behind this tab. */}
            <button
              type="button"
              className={s.tab}
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
            >
              <DotsThree weight="bold" className={s.tabIcon} aria-hidden />
              <span>{t('nav.more')}</span>
              {unreadC > 0 && (
                <span className={s.dot} aria-label={t('nav.unread', { count: unreadC })} />
              )}
            </button>
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
        <Dialog open={moreOpen} onOpenChange={setMoreOpen} title={t('nav.more')} titleHidden>
          <nav className={s.moreList} aria-label={t('nav.more')}>
            <Link to="/messages" className={s.moreItem} onClick={() => setMoreOpen(false)}>
              <ChatsCircle weight="regular" size={22} aria-hidden />
              <span>{t('nav.messages')}</span>
              {unreadC > 0 && (
                <span className={s.moreDot} aria-label={t('nav.unread', { count: unreadC })} />
              )}
            </Link>
            <Link to="/bookmarks" className={s.moreItem} onClick={() => setMoreOpen(false)}>
              <BookmarkSimple weight="regular" size={22} aria-hidden />
              <span>{t('nav.bookmarks')}</span>
            </Link>
            <Link to="/settings" className={s.moreItem} onClick={() => setMoreOpen(false)}>
              <Gear weight="regular" size={22} aria-hidden />
              <span>{t('nav.settings')}</span>
            </Link>
            <button
              type="button"
              className={s.moreItem}
              onClick={() => {
                setMoreOpen(false);
                void logout();
              }}
            >
              <SignOut weight="regular" size={22} aria-hidden />
              <span>{t('nav.signOut')}</span>
            </button>
          </nav>
        </Dialog>
      )}
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
