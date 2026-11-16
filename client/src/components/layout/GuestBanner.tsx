import { Link } from 'react-router-dom';
import { X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useReturnState } from '@/lib/useAuthGate';
import s from './GuestBanner.module.css';

/**
 * A quiet line at the top of the shell for signed-out readers: everything here
 * is readable, and this is what an account adds. Dismissal lives in the shell,
 * which stays mounted across open pages, so it does not come back on every
 * navigation.
 */
export function GuestBanner({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const returnState = useReturnState();

  return (
    <aside className={s.banner} aria-label={t('guest.bannerLabel')}>
      <p className={s.text}>{t('guest.banner')}</p>
      <div className={s.actions}>
        <Link to="/register" state={returnState} className={s.primary}>
          {t('showcase.join')}
        </Link>
        <Link to="/login" state={returnState} className={s.secondary}>
          {t('auth.signIn')}
        </Link>
        <button
          type="button"
          className={s.dismiss}
          onClick={onDismiss}
          aria-label={t('guest.dismiss')}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </aside>
  );
}
