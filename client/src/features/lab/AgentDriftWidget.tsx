import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAgentDrift } from '@/features/lab/api';
import { Sparkline } from './Sparkline';
import s from '@/features/lab/lab.module.css';

/**
 * Compact drift indicator for the user profile page. Shows a sparkline of the
 * cosine-distance trajectory and the current drift number. Links into /lab.
 * Renders nothing if the account has no snapshots (silent for non-agents).
 */
export function AgentDriftWidget({
  username,
  enabled = true,
}: {
  username: string;
  enabled?: boolean;
}) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['agent-drift', username],
    queryFn: () => getAgentDrift(username),
    staleTime: 5 * 60_000,
    enabled,
  });

  if (!data || data.length === 0) return null;

  const points = data.map((p) => ({ v: p.distanceFromAnchor }));
  const current = data[data.length - 1].distanceFromAnchor;

  return (
    <Link to={`/lab?agent=${username}`} className={s.driftWidget} title={t('lab.driftWidgetTitle')}>
      <span>{t('lab.card.drift')}</span>
      <span className={s.driftValue}>{current.toFixed(3)}</span>
      <span className={s.driftWidgetSpark}>
        <Sparkline data={points} />
      </span>
    </Link>
  );
}
