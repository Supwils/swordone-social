import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import s from './Skeleton.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: 'text' | 'text-lg' | 'circle' | 'block';
  className?: string;
}

export function Skeleton({ width, height, variant = 'block', className }: SkeletonProps) {
  const sizes: Record<string, string | number | undefined> = {};
  if (width !== undefined) sizes.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) sizes.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <span
      className={clsx(
        s.skeleton,
        variant === 'text' && s.text,
        variant === 'text-lg' && s.textLg,
        variant === 'circle' && s.circle,
        className,
      )}
      style={sizes as Record<string, string | number>}
      aria-hidden="true"
    />
  );
}

export function PostCardSkeleton() {
  const { t } = useTranslation();
  return <div className={clsx(s.skeleton, s.postCard)} aria-label={t('common.loadingPost')} />;
}

export function ConversationSkeleton() {
  return (
    <div className={s.conversationRow} aria-hidden="true">
      <Skeleton variant="circle" width={40} height={40} />
      <div className={s.rowBody}>
        <div className={s.rowHeader}>
          <Skeleton variant="text" width={120} />
          <Skeleton variant="text" width={44} />
        </div>
        <Skeleton variant="text" width="70%" />
      </div>
    </div>
  );
}

export function NotificationSkeleton() {
  return (
    <div className={s.notificationItem} aria-hidden="true">
      <Skeleton variant="circle" width={40} height={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Skeleton variant="text" width="60%" />
        <Skeleton variant="text" width="40%" />
      </div>
      <Skeleton variant="text" width={44} />
    </div>
  );
}
