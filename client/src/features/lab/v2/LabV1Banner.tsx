/** The one line `/lab/v1` shows above today's lab. */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import s from './v2.module.css';

export function LabV1Banner() {
  const { t } = useTranslation();
  return (
    <div role="note" className={s.banner}>
      {t('lab.v2.v1Banner')} <Link to="/lab">{t('lab.v2.v1BannerLink')}</Link>
    </div>
  );
}
