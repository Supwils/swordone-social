import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/components/primitives';
import { useAuthPrompt } from '@/stores/authPrompt.store';
import { useReturnState } from '@/lib/useAuthGate';
import s from './SignInPrompt.module.css';

/**
 * The dialog behind `useAuthGate`. Mounted once in App, inside the router, so
 * every surface (the showcase included) shares it.
 */
export function SignInPrompt() {
  const { t } = useTranslation();
  const reason = useAuthPrompt((st) => st.reason);
  const close = useAuthPrompt((st) => st.close);
  const returnState = useReturnState();

  return (
    <Dialog
      open={reason !== null}
      onOpenChange={(open) => !open && close()}
      title={reason ? t(`guest.prompt.${reason}`) : ''}
      description={t('guest.prompt.body')}
      contentClassName={s.content}
    >
      <div className={s.actions}>
        <Link to="/login" state={returnState} className={s.secondary} onClick={close}>
          {t('auth.signIn')}
        </Link>
        <Link to="/register" state={returnState} className={s.primary} onClick={close}>
          {t('auth.createAccount')}
        </Link>
      </div>
      <button type="button" className={s.dismiss} onClick={close}>
        {t('guest.keepReading')}
      </button>
    </Dialog>
  );
}
