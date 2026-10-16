import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useUI, type FeedLayout } from '@/stores/ui.store';
import { useSetLanguage } from '@/lib/useSetLanguage';
import { useSession } from '@/stores/session.store';
import { useDebounce } from '@/lib/useDebounce';
import * as usersApi from '@/api/users.api';
import type { UserLiteDTO } from '@/api/types';
import s from './CommandPalette.module.css';

/**
 * Dependency-free ⌘K command palette. The original shipped on `cmdk` and was
 * removed with it; the store kept `cmdkOpen` waiting for this to come back.
 *
 * One flat list: navigation + preference commands, then people matches from
 * the user directory once the query is 2+ chars. Keyboard-first: ⌘K / Ctrl+K
 * toggles, arrows move, Enter runs, Esc closes.
 */

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const open = useUI((st) => st.cmdkOpen);
  const openCmdK = useUI((st) => st.openCmdK);
  const closeCmdK = useUI((st) => st.closeCmdK);
  const setTheme = useUI((st) => st.setTheme);
  const setLanguage = useSetLanguage();
  const language = useUI((st) => st.language);
  const feedLayout = useUI((st) => st.feedLayout);
  const setFeedLayout = useUI((st) => st.setFeedLayout);
  const user = useSession((st) => st.user);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [people, setPeople] = useState<UserLiteDTO[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounce(query.trim(), 200);

  // Global shortcut — this component mounts once in AppShell, so the listener
  // lives exactly as long as the shell does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) closeCmdK();
        else openCmdK();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openCmdK, closeCmdK]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery('');
      setPeople([]);
      setActive(0);
    }
  }, [open]);

  // People search — plain effect with a staleness guard; the palette sits
  // outside any query cache on purpose (nothing here should be cached).
  useEffect(() => {
    if (!open || debouncedQuery.length < 2) {
      setPeople([]);
      return;
    }
    let stale = false;
    usersApi
      .searchUsers(debouncedQuery)
      .then((items) => {
        if (!stale) setPeople(items.slice(0, 5));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [open, debouncedQuery]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => nav(path);
    const list: Command[] = [];
    if (user)
      list.push({ id: 'nav-feed', label: t('nav.following'), hint: '/feed', run: go('/feed') });
    list.push({ id: 'nav-global', label: t('nav.global'), hint: '/global', run: go('/global') });
    list.push({ id: 'nav-explore', label: t('nav.people'), hint: '/explore', run: go('/explore') });
    if (user) {
      list.push(
        {
          id: 'nav-notifications',
          label: t('nav.notifications'),
          hint: '/notifications',
          run: go('/notifications'),
        },
        { id: 'nav-messages', label: t('nav.messages'), hint: '/messages', run: go('/messages') },
        {
          id: 'nav-bookmarks',
          label: t('nav.bookmarks'),
          hint: '/bookmarks',
          run: go('/bookmarks'),
        },
        {
          id: 'nav-profile',
          label: t('nav.profile'),
          hint: `/u/${user.username}`,
          run: go(`/u/${user.username}`),
        },
        { id: 'nav-settings', label: t('nav.settings'), hint: '/settings', run: go('/settings') },
      );
    }
    list.push({ id: 'nav-lab', label: t('nav.lab'), hint: '/lab', run: go('/lab') });
    list.push(
      { id: 'theme-light', label: t('cmdk.themeLight'), hint: '', run: () => setTheme('light') },
      { id: 'theme-dark', label: t('cmdk.themeDark'), hint: '', run: () => setTheme('dark') },
      { id: 'theme-system', label: t('cmdk.themeSystem'), hint: '', run: () => setTheme('system') },
      {
        id: 'language',
        label: t('cmdk.language'),
        hint: '',
        run: () => setLanguage(language === 'zh' ? 'en' : 'zh'),
      },
    );
    // Every layout except the one already in effect — with three of them, a
    // single toggle command could no longer reach all of them.
    const layouts: Array<[FeedLayout, string]> = [
      ['list', t('cmdk.layoutList')],
      ['grid', t('cmdk.layoutGrid')],
      ['immersive', t('cmdk.layoutImmersive')],
    ];
    for (const [id, label] of layouts) {
      if (id === feedLayout) continue;
      list.push({ id: `layout-${id}`, label, hint: '', run: () => setFeedLayout(id) });
    }
    return list;
  }, [user, language, feedLayout, nav, setTheme, setLanguage, setFeedLayout, t]);

  const q = query.trim().toLowerCase();
  const visible = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  const peopleItems: Command[] = people.map((p) => ({
    id: `user-${p.username}`,
    label: `${p.displayName || p.username} — @${p.username}`,
    hint: '@',
    run: () => nav(`/u/${p.username}`),
  }));
  const items = [...visible, ...peopleItems];
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  if (!open) return null;

  const runItem = (item: Command | undefined) => {
    if (!item) return;
    closeCmdK();
    item.run();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(items[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCmdK();
    }
  };

  return (
    <div className={s.overlay} onMouseDown={closeCmdK}>
      <div
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('cmdk.ariaLabel')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className={s.input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={t('cmdk.placeholder')}
          aria-label={t('cmdk.placeholder')}
          aria-controls="cmdk-list"
          aria-activedescendant={items[activeIndex] ? `cmdk-${items[activeIndex].id}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <ul className={s.list} role="listbox" id="cmdk-list">
          {items.length === 0 && <li className={s.empty}>{t('cmdk.empty')}</li>}
          {items.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === activeIndex}
              id={`cmdk-${item.id}`}
            >
              <button
                type="button"
                className={`${s.item} ${i === activeIndex ? s.itemActive : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // mousedown beats the overlay's close-on-mousedown ordering
                  // and the input blur; same trick as the DM user search.
                  e.preventDefault();
                  runItem(item);
                }}
              >
                <span className={s.itemLabel}>{item.label}</span>
                {item.hint && <span className={s.itemHint}>{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
