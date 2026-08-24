import { useTranslation } from 'react-i18next';
import s from './Spinner.module.css';

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <span className={s.spinner} role="status" aria-label={label ?? t('common.loading')} />;
}
