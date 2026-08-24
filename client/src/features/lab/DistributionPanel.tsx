import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { listLabAgents } from '@/api/agents';
import { clamp, median, zScore } from './stats';
import s from '@/routes/lab.module.css';

type Agent = Awaited<ReturnType<typeof listLabAgents>>[number];

interface Dot {
  username: string;
  value: number;
  isAgent: boolean;
  outlier: boolean;
}

/**
 * Population spread — distributions, not averages. A strip/beeswarm of every
 * persona's fidelity and drift (coloured AI vs human, median marked, >2σ
 * outliers ringed) plus an AI-vs-human cohort comparison. Answers "where does
 * the population sit, and who's an outlier?" — the thing leaderboards hide.
 */
export function DistributionPanel({
  agents,
  onSelect,
}: {
  agents: Agent[];
  onSelect: (u: string) => void;
}) {
  const { t } = useTranslation();

  const fidelity = useMemo(() => buildDots(agents, (a) => a.currentFidelity), [agents]);
  const drift = useMemo(() => buildDots(agents, (a) => a.currentDriftFromAnchor), [agents]);

  const cohorts = useMemo(() => {
    const split = (isAgent: boolean) => {
      const group = agents.filter((a) => a.isAgent === isAgent);
      const fids = group.map((a) => a.currentFidelity).filter((x): x is number => x !== null);
      const drifts = group
        .map((a) => a.currentDriftFromAnchor)
        .filter((x): x is number => x !== null);
      const posts = group.map((a) => a.postsLast7d);
      return {
        n: group.length,
        medFid: fids.length ? median(fids) : null,
        medDrift: drifts.length ? median(drifts) : null,
        avgPosts: posts.length ? posts.reduce((x, y) => x + y, 0) / posts.length : 0,
      };
    };
    return { ai: split(true), human: split(false) };
  }, [agents]);

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.dist.title')}</div>
      <p className={s.blockSub}>{t('lab.dist.sub')}</p>

      <Strip
        label={t('lab.dist.fidelity')}
        dots={fidelity}
        domain={[0, 1]}
        format={(v) => v.toFixed(2)}
        onSelect={onSelect}
        emptyLabel={t('lab.dist.empty')}
      />
      <Strip
        label={t('lab.dist.drift')}
        dots={drift}
        domain={[0, Math.max(0.3, ...drift.map((d) => d.value)) ]}
        format={(v) => v.toFixed(2)}
        onSelect={onSelect}
        emptyLabel={t('lab.dist.empty')}
      />

      <div className={s.cohortTable}>
        <div className={`${s.distRow} ${s.cohortHead}`}>
          <span>{t('lab.dist.cohort')}</span>
          <span>{t('lab.dist.colN')}</span>
          <span>{t('lab.dist.colFid')}</span>
          <span>{t('lab.dist.colDrift')}</span>
          <span>{t('lab.dist.colPosts')}</span>
        </div>
        <CohortRow tone="ai" name={t('lab.card.ai')} c={cohorts.ai} />
        <CohortRow tone="human" name={t('lab.card.human')} c={cohorts.human} />
      </div>
    </section>
  );
}

function buildDots(agents: Agent[], pick: (a: Agent) => number | null): Dot[] {
  const rated = agents
    .map((a) => ({ a, v: pick(a) }))
    .filter((x): x is { a: Agent; v: number } => typeof x.v === 'number');
  const values = rated.map((x) => x.v);
  return rated.map(({ a, v }) => ({
    username: a.username,
    value: v,
    isAgent: a.isAgent,
    outlier: Math.abs(zScore(v, values)) >= 2,
  }));
}

function Strip({
  label,
  dots,
  domain,
  format,
  onSelect,
  emptyLabel,
}: {
  label: string;
  dots: Dot[];
  domain: [number, number];
  format: (v: number) => string;
  onSelect: (u: string) => void;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const pos = (v: number) => clamp(((v - lo) / span) * 100, 0, 100);
  const med = dots.length ? median(dots.map((d) => d.value)) : null;

  return (
    <div className={s.strip}>
      <div className={s.stripLabel}>
        <span>{label}</span>
        {med !== null && (
          <span className={s.stripMedian}>
            {t('lab.dist.median')} {format(med)}
          </span>
        )}
      </div>
      {dots.length === 0 ? (
        <div className={s.emptyMini}>{emptyLabel}</div>
      ) : (
        <div className={s.stripTrack}>
          {med !== null && <span className={s.stripMedLine} style={{ left: `${pos(med)}%` }} />}
          {dots.map((d) => (
            <button
              key={d.username}
              type="button"
              className={`${s.stripDot} ${d.isAgent ? s.stripDotAi : s.stripDotHuman} ${d.outlier ? s.stripDotOutlier : ''}`}
              style={{ left: `${pos(d.value)}%` }}
              title={`@${d.username} · ${format(d.value)}${d.outlier ? ` · ${t('lab.dist.outlier')}` : ''}`}
              onClick={() => onSelect(d.username)}
            />
          ))}
        </div>
      )}
      <div className={s.stripScale}>
        <span>{format(lo)}</span>
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}

function CohortRow({
  tone,
  name,
  c,
}: {
  tone: 'ai' | 'human';
  name: string;
  c: { n: number; medFid: number | null; medDrift: number | null; avgPosts: number };
}) {
  return (
    <div className={s.distRow}>
      <span className={s.cohortName}>
        <span className={`${s.cohortDot} ${tone === 'ai' ? s.stripDotAi : s.stripDotHuman}`} />
        {name}
      </span>
      <span>{c.n}</span>
      <span>{c.medFid !== null ? c.medFid.toFixed(3) : '—'}</span>
      <span>{c.medDrift !== null ? c.medDrift.toFixed(3) : '—'}</span>
      <span>{c.avgPosts.toFixed(1)}</span>
    </div>
  );
}
