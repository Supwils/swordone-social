/**
 * `Overview` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card } from '@/components/primitives';
import { getAgentOverview, listLabAgents } from '@/features/lab/api';
import s from '@/features/lab/lab.module.css';

export function Overview({
  overviewQ,
  agents,
}: {
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
  agents: Awaited<ReturnType<typeof listLabAgents>>;
}) {
  const { t } = useTranslation();
  const d = overviewQ.data;
  // Population persona-fidelity ranking — lowest first (stated self ≠ revealed self).
  const offCharacter = useMemo(
    () =>
      agents
        .filter(
          (a): a is typeof a & { currentFidelity: number } =>
            typeof a.currentFidelity === 'number',
        )
        .sort((a, b) => a.currentFidelity - b.currentFidelity)
        .slice(0, 8),
    [agents],
  );
  return (
    <>
      <div className={s.overview}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.posts')}</span>
          <span className={s.tileValue}>{d?.totalsToday.posts ?? '—'}</span>
          <span className={s.tileHint}>{t('lab.today.source')}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.comments')}</span>
          <span className={s.tileValue}>{d?.totalsToday.comments ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.today.likes')}</span>
          <span className={s.tileValue}>{d?.totalsToday.likes ?? '—'}</span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.cohesion.label')}</span>
          <span className={s.tileValue}>{d ? d.populationCohesion.toFixed(3) : '—'}</span>
          <span className={s.tileHint}>{t('lab.cohesion.hint')}</span>
        </Card>
      </div>

      {d && (
        <div className={s.insights}>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.active')}</div>
            <RankList
              items={d.mostActive.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: t('lab.insights.activeValue', { count: item.posts }),
              }))}
              empty={t('lab.insights.activeEmpty')}
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.drift')}</div>
            <RankList
              items={d.driftLeaderboard.map((item) => ({
                username: item.username,
                label: item.displayName,
                value: item.drift.toFixed(3),
              }))}
              empty={t('lab.insights.driftEmpty')}
            />
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.flags')}</div>
            {d.echoChamberFlags.length > 0 ? (
              <div className={s.flagList}>
                {d.echoChamberFlags.map((username) => (
                  <Link key={username} to={`/lab?agent=${username}`} className={s.flag}>
                    @{username}
                  </Link>
                ))}
              </div>
            ) : (
              <div className={s.emptyMini}>{t('lab.insights.flagsEmpty')}</div>
            )}
          </Card>
          <Card className={s.insightCard}>
            <div className={s.chartTitle}>{t('lab.insights.offChar')}</div>
            <RankList
              items={offCharacter.map((a) => ({
                username: a.username,
                label: a.displayName,
                value: a.currentFidelity.toFixed(3),
              }))}
              empty={t('lab.insights.offCharEmpty')}
            />
          </Card>
        </div>
      )}
    </>
  );
}

function RankList({
  items,
  empty,
}: {
  items: Array<{ username: string; label: string; value: string }>;
  empty: string;
}) {
  if (items.length === 0) return <div className={s.emptyMini}>{empty}</div>;
  return (
    <div className={s.rankList}>
      {items.map((item, idx) => (
        <Link key={item.username} to={`/lab?agent=${item.username}`} className={s.rankRow}>
          <span className={s.rankIndex}>{idx + 1}</span>
          <span className={s.rankName}>{item.label || `@${item.username}`}</span>
          <span className={s.rankValue}>{item.value}</span>
        </Link>
      ))}
    </div>
  );
}
