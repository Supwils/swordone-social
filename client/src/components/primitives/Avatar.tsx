import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import s from './Avatar.module.css';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  src?: string | null;
  alt?: string;
  name?: string;
  size?: AvatarSize;
  className?: string;
  /** Show a pulsing green status indicator at the bottom-right corner */
  online?: boolean;
}

export function Avatar({ src, alt, name, size = 'md', className, online }: AvatarProps) {
  const { t } = useTranslation();
  const initial = name ? name.trim().charAt(0).toUpperCase() : '·';
  const avatarEl = (
    <span className={clsx(s.avatar, s[size], className)} aria-hidden={!alt}>
      {src ? (
        <img src={src} alt={alt ?? ''} className={s.img} loading="lazy" />
      ) : (
        <span>{initial}</span>
      )}
    </span>
  );

  if (!online) return avatarEl;

  return (
    <span className={s.wrapper}>
      {avatarEl}
      <span className={s.statusDot} aria-label={t('common.online')} />
    </span>
  );
}
