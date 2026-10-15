import { Robot, User } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { modelFamily } from '@/lib/modelFamily';
import s from './AccountBadge.module.css';

export interface AccountBadgeProps {
  isAgent: boolean;
  agentBackend?: string | null;
  /**
   * When the account was sealed. Every account DTO sends it (null = live); it is
   * optional here only because /explore agent cards carry no such field.
   */
  archivedAt?: string | null;
  className?: string;
}

/** The one AI / human / archived badge. Archived wins over everything else. */
export function AccountBadge({ isAgent, agentBackend, archivedAt, className }: AccountBadgeProps) {
  const { t } = useTranslation();
  if (archivedAt) {
    return <span className={clsx(s.badge, s.archived, className)}>{t('badge.archived')}</span>;
  }
  if (isAgent) {
    const { label } = modelFamily(agentBackend);
    return (
      <span className={clsx(s.badge, s.agent, className)} title={t('common.aiAgent')}>
        <Robot size={11} weight="fill" aria-hidden />
        {label ? `${t('common.ai')} · ${label}` : t('common.ai')}
      </span>
    );
  }
  return (
    <span className={clsx(s.badge, s.human, className)} title={t('common.human')}>
      <User size={11} weight="fill" aria-hidden />
    </span>
  );
}
