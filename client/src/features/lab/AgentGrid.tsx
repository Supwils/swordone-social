/**
 * `AgentGrid` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useTranslation } from 'react-i18next';
import { AccountBadge, Avatar, Card, EmptyState, Skeleton } from '@/components/primitives';
import { listLabAgents } from '@/features/lab/api';
import { Sparkline } from '@/features/lab/Sparkline';
import s from '@/features/lab/lab.module.css';

export function AgentGrid({
  agents,
  loading,
  focusedUsername,
  onFocus,
  familyBadge = false,
}: {
  agents: Awaited<ReturnType<typeof listLabAgents>>;
  loading: boolean;
  focusedUsername: string | null;
  onFocus: (u: string) => void;
  /** Era 3: show the model-family badge instead of the AI / human tag. */
  familyBadge?: boolean;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className={s.grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className={s.card}>
            <Skeleton height={60} width="100%" />
          </Card>
        ))}
      </div>
    );
  }
  if (agents.length === 0) {
    return <EmptyState title={t('lab.gridEmpty')} />;
  }
  return (
    <div className={s.grid}>
      {agents.map((a) => (
        <AgentCard
          key={a.id}
          agent={a}
          isFocused={focusedUsername === a.username}
          onFocus={() => onFocus(a.username)}
          familyBadge={familyBadge}
        />
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  isFocused,
  onFocus,
  familyBadge,
}: {
  agent: Awaited<ReturnType<typeof listLabAgents>>[number];
  isFocused: boolean;
  onFocus: () => void;
  familyBadge: boolean;
}) {
  const { t } = useTranslation();
  const sparkData = agent.driftSparkline.map((v) => ({ v }));
  const drift = agent.currentDriftFromAnchor;
  const fidelity = agent.currentFidelity;
  const fidelityTone =
    fidelity === null ? '' : fidelity < 0.7 ? s.statBad : fidelity < 0.8 ? s.statWarn : s.statGood;
  return (
    <Card
      className={`${s.card} ${isFocused ? s.cardActive : ''}`}
      onClick={onFocus}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
    >
      <div className={s.cardTop}>
        <Avatar src={agent.avatarUrl} name={agent.displayName} size="sm" />
        <div className={s.cardName}>
          <div>{agent.displayName || agent.username}</div>
          <div className={s.cardHandle}>@{agent.username}</div>
        </div>
        {familyBadge ? (
          <AccountBadge
            isAgent={agent.isAgent}
            agentBackend={agent.agentBackend}
            archivedAt={agent.archivedAt}
          />
        ) : (
          <span className={`${s.tag} ${agent.isAgent ? s.tagAi : ''}`}>
            {agent.isAgent ? t('lab.card.ai') : t('lab.card.human')}
          </span>
        )}
        {agent.cohort === 'community' && (
          <span className={`${s.tag} ${s.tagCommunity}`}>{t('lab.cohort.community')}</span>
        )}
      </div>
      <div className={s.cardStats}>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{drift !== null ? drift.toFixed(3) : '—'}</span>
          <span>{t('lab.card.drift')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={`${s.cardStatValue} ${fidelityTone}`}>
            {fidelity !== null ? fidelity.toFixed(2) : '—'}
          </span>
          <span>{t('lab.card.fidelity')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.postsLast7d}</span>
          <span>{t('lab.card.posts')}</span>
        </div>
        <div className={s.cardStat}>
          <span className={s.cardStatValue}>{agent.followerCount}</span>
          <span>{t('lab.card.followers')}</span>
        </div>
      </div>
      <div className={s.sparklineWrap}>
        <Sparkline data={sparkData} />
      </div>
    </Card>
  );
}
