import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  User as UserIcon,
  UsersThree,
  Gear,
  SignOut,
  Bell,
  ChatsCircle,
  NotePencil,
  BookmarkSimple,
  Newspaper,
  ArrowSquareOut,
  Atom,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { Avatar } from '@/components/primitives/Avatar';
import { Button } from '@/components/primitives/Button';
import { Dialog } from '@/components/primitives/Dialog';
import { PostComposer } from '@/features/posts/PostComposer';
import { useLogout } from '@/lib/useLogout';
import s from './Sidebar.module.css';

export function Sidebar() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const unreadC = useRealtime((st) => st.unreadConversations);
  const nav = useNavigate();
  const [composerOpen, setComposerOpen] = useState(false);
  const qc = useQueryClient();

  const handleBrandClick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    void qc.invalidateQueries();
    nav(user ? '/feed' : '/global');
  };

  const handleLogout = useLogout();

  const linkClass = ({ isActive }: { isActive: boolean }) => clsx(s.link, isActive && s.linkActive);

  return (
    <aside className={s.sidebar} aria-label={t('nav.primary')}>
      <button
        type="button"
        className={s.brand}
        onClick={handleBrandClick}
        aria-label={t('nav.refresh')}
      >
        <span className={s.brandDot} aria-hidden />
        <span>swordone</span>
      </button>

      <nav className={s.nav}>
        {/* Personal destinations — hidden when signed out, since the routes
            themselves bounce anonymous visitors to /login. */}
        {user && (
          <NavLink to="/feed" className={linkClass} end>
            <HouseSimple weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.following')}</span>
          </NavLink>
        )}
        <NavLink to="/global" className={linkClass}>
          <Globe weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.global')}</span>
        </NavLink>
        {user && (
          <NavLink to="/notifications" className={linkClass}>
            <Bell weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.notifications')}</span>
            {unreadN > 0 && (
              <span className={s.dot} aria-label={t('nav.unread', { count: unreadN })} />
            )}
          </NavLink>
        )}
        {user && (
          <NavLink to="/messages" className={linkClass}>
            <ChatsCircle weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.messages')}</span>
            {unreadC > 0 && (
              <span className={s.dot} aria-label={t('nav.unread', { count: unreadC })} />
            )}
          </NavLink>
        )}
        {user && (
          <NavLink to={`/u/${user.username}`} className={linkClass}>
            <UserIcon weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.profile')}</span>
          </NavLink>
        )}
        {user && (
          <NavLink to="/bookmarks" className={linkClass}>
            <BookmarkSimple weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.bookmarks')}</span>
          </NavLink>
        )}
        <NavLink to="/explore" className={linkClass}>
          <UsersThree weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.people')}</span>
        </NavLink>
        <NavLink to="/lab" className={linkClass}>
          <Atom weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.lab')}</span>
        </NavLink>
        {user && (
          <NavLink to="/settings" className={linkClass}>
            <Gear weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.settings')}</span>
          </NavLink>
        )}

        <div className={s.navDivider} />

        <a
          href="https://swil-news.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className={s.link}
        >
          <Newspaper weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.news')}</span>
          <ArrowSquareOut size={12} className={s.externalIcon} aria-hidden />
        </a>
      </nav>

      {user && (
        <>
          <button className={s.postBtn} onClick={() => setComposerOpen(true)}>
            <NotePencil weight="regular" size={20} aria-hidden />
            <span>{t('nav.newPost')}</span>
          </button>
          <Dialog
            open={composerOpen}
            onOpenChange={setComposerOpen}
            title={t('nav.newPost')}
            titleHidden
          >
            <PostComposer bare onSuccess={() => setComposerOpen(false)} />
          </Dialog>
        </>
      )}

      <div className={s.footer}>
        {user && (
          <NavLink to={`/u/${user.username}`} className={s.userCard}>
            <Avatar src={user.avatarUrl} name={user.displayName || user.username} size="md" />
            <div className={s.userMeta}>
              <span className={s.userName}>{user.displayName || user.username}</span>
              <span className={s.userHandle}>@{user.username}</span>
            </div>
          </NavLink>
        )}

        {user ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            leadingIcon={<SignOut size={16} aria-hidden />}
            fullWidth
          >
            {t('nav.signOut')}
          </Button>
        ) : (
          // Anonymous visitors reach the shell now that the global feed, posts,
          // profiles and the lab are readable without an account — so the
          // footer has to offer a way in, not a way out.
          <Button variant="primary" size="sm" fullWidth onClick={() => nav('/login')}>
            {t('auth.signIn')}
          </Button>
        )}
      </div>
    </aside>
  );
}
