/**
 * `PopulationInsights` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/primitives';
import { getAgentOverview, getAlerts, getHomogenization, getPopulationPulse, listLabAgents } from '@/features/lab/api';
import { mean, median, zScore } from '@/features/lab/stats';
import type { LabEra } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

type ConclusionTone = 'good' | 'warn' | 'bad' | 'neutral';
interface Conclusion {
  key: string;
  tone: ConclusionTone;
  rank: number;
  tag: string;
  title: string;
  detail: string;
  focus?: string | null;
}

const TONE_RANK: Record<ConclusionTone, number> = { bad: 4, warn: 3, good: 2, neutral: 1 };

/**
 * Population Insights — a Watchdog-style insight feed. An auto-generated, ranked
 * set of typed conclusions (monoculture trend, AI↔human cohort gap, fidelity /
 * drift outliers via z-score, activity anomalies, rejected-dream clusters, echo
 * chambers) each phrased as a plain-language verdict with evidence + severity.
 * The ecosystem verdict (monoculture) is pinned first; the rest sort by severity
 * and cap so the feed reads as intelligent signal, not noise.
 */
export function PopulationInsights({
  era,
  overviewQ,
  agents,
  range,
  onSelect,
}: {
  era: LabEra;
  overviewQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAgentOverview>>>>;
  agents: Awaited<ReturnType<typeof listLabAgents>>;
  range: '7d' | '30d' | '90d';
  onSelect: (u: string) => void;
}) {
  const { t } = useTranslation();
  const homogQ = useQuery({
    queryKey: ['lab-homogenization', era, range],
    queryFn: () => getHomogenization(era, range),
    staleTime: 60_000,
  });
  const pulseQ = useQuery({
    queryKey: ['lab-pulse', era, range],
    queryFn: () => getPopulationPulse(era, range),
    staleTime: 60_000,
  });
  const alertsQ = useQuery({
    queryKey: ['lab-alerts', era, range],
    queryFn: () => getAlerts(era, range),
    staleTime: 60_000,
  });

  const conclusions = useMemo<Conclusion[]>(() => {
    let mono: Conclusion;
    const rest: Conclusion[] = [];

    // — Ecosystem verdict: monoculture watch (behavior-cohesion trend), pinned.
    const pts = homogQ.data?.points ?? [];
    const monoTag = t('lab.conclusions.monoTag');
    if (pts.length >= 2) {
      const first = pts[0].behaviorCohesion;
      const last = pts[pts.length - 1].behaviorCohesion;
      const delta = last - first;
      const deltaStr = `${delta >= 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(3)}`;
      const detail = t('lab.conclusions.monoDetail', { value: last.toFixed(3), delta: deltaStr });
      if (delta > 0.01) {
        mono = { key: 'mono', tone: delta > 0.04 ? 'bad' : 'warn', rank: 5, tag: monoTag, title: t('lab.conclusions.convergingTitle'), detail };
      } else if (delta < -0.01) {
        mono = { key: 'mono', tone: 'good', rank: 5, tag: monoTag, title: t('lab.conclusions.divergingTitle'), detail };
      } else {
        mono = { key: 'mono', tone: 'neutral', rank: 5, tag: monoTag, title: t('lab.conclusions.steadyTitle'), detail };
      }
    } else {
      mono = { key: 'mono', tone: 'neutral', rank: 5, tag: monoTag, title: t('lab.conclusions.steadyTitle'), detail: t('lab.conclusions.monoWaiting') };
    }

    const rated = agents.filter(
      (a): a is typeof a & { currentFidelity: number } => typeof a.currentFidelity === 'number',
    );
    const fids = rated.map((a) => a.currentFidelity);

    // — Fidelity outlier / most off-character (z-score against peers).
    if (rated.length > 0) {
      const worst = rated.reduce((m, a) => (a.currentFidelity < m.currentFidelity ? a : m));
      const z = zScore(worst.currentFidelity, fids);
      const isOutlier = z <= -1.5;
      rest.push({
        key: 'fidelity',
        tone: worst.currentFidelity < 0.7 ? 'bad' : worst.currentFidelity < 0.8 ? 'warn' : 'good',
        rank: isOutlier ? 4 : 3,
        tag: t('lab.conclusions.fidelityTag'),
        title: isOutlier
          ? t('lab.conclusions.fidOutlierTitle', { username: worst.username, sigma: Math.abs(z).toFixed(1) })
          : t('lab.conclusions.offCharTitle', { username: worst.username }),
        detail: t('lab.conclusions.offCharDetail', { value: worst.currentFidelity.toFixed(3) }),
        focus: worst.username,
      });
    }

    // — AI ↔ human cohort fidelity gap.
    const aiFids = rated.filter((a) => a.isAgent).map((a) => a.currentFidelity);
    const humanFids = rated.filter((a) => !a.isAgent).map((a) => a.currentFidelity);
    if (aiFids.length >= 2 && humanFids.length >= 2) {
      const ma = median(aiFids);
      const mh = median(humanFids);
      const gap = ma - mh;
      if (Math.abs(gap) >= 0.03) {
        rest.push({
          key: 'cohort',
          tone: Math.abs(gap) >= 0.08 ? 'warn' : 'neutral',
          rank: Math.abs(gap) >= 0.08 ? 3 : 2,
          tag: t('lab.conclusions.cohortTag'),
          title: gap < 0 ? t('lab.conclusions.cohortAiLower') : t('lab.conclusions.cohortAiHigher'),
          detail: t('lab.conclusions.cohortDetail', { ai: ma.toFixed(3), human: mh.toFixed(3) }),
        });
      }
    }

    // — Drift outlier / biggest mover (z-score against peers).
    const driftRated = agents
      .map((a) => ({ a, d: a.currentDriftFromAnchor }))
      .filter((x): x is { a: (typeof agents)[number]; d: number } => typeof x.d === 'number');
    if (driftRated.length > 0) {
      const top = driftRated.reduce((m, x) => (x.d > m.d ? x : m));
      const z = zScore(top.d, driftRated.map((x) => x.d));
      const isOutlier = z >= 1.5;
      rest.push({
        key: 'drift',
        tone: isOutlier ? 'warn' : top.d > 0.15 ? 'warn' : 'neutral',
        rank: isOutlier ? 4 : 2,
        tag: t('lab.conclusions.driftTag'),
        title: isOutlier
          ? t('lab.conclusions.driftOutlierTitle', { username: top.a.username, sigma: z.toFixed(1) })
          : t('lab.conclusions.drifterTitle', { username: top.a.username }),
        detail: t('lab.conclusions.drifterDetail', { value: top.d.toFixed(3) }),
        focus: top.a.username,
      });
    }

    // — Activity anomaly (recent day vs trailing baseline).
    const acts = (pulseQ.data?.points ?? []).map((p) => p.actions);
    const nonZero = acts.filter((x) => x > 0);
    if (nonZero.length >= 4) {
      const recent = acts[acts.length - 1];
      const baseline = mean(acts.slice(0, -1).filter((x) => x > 0));
      if (baseline > 0 && recent >= baseline * 1.5) {
        rest.push({
          key: 'activity',
          tone: 'neutral',
          rank: 2,
          tag: t('lab.conclusions.activityTag'),
          title: t('lab.conclusions.activityUp', { pct: Math.round((recent / baseline - 1) * 100) }),
          detail: t('lab.conclusions.activityDetail', { recent, baseline: Math.round(baseline) }),
        });
      } else if (baseline > 0 && recent > 0 && recent <= baseline * 0.5) {
        rest.push({
          key: 'activity',
          tone: 'neutral',
          rank: 2,
          tag: t('lab.conclusions.activityTag'),
          title: t('lab.conclusions.activityDown', { pct: Math.round((1 - recent / baseline) * 100) }),
          detail: t('lab.conclusions.activityDetail', { recent, baseline: Math.round(baseline) }),
        });
      }
    }

    // — Rejected-dream cluster (anchor strain across the population).
    const dreamFails = (alertsQ.data?.alerts ?? []).filter((a) => a.kind === 'dream_rejected');
    if (dreamFails.length >= 3) {
      rest.push({
        key: 'dreams',
        tone: 'warn',
        rank: 3,
        tag: t('lab.conclusions.dreamTag'),
        title: t('lab.conclusions.dreamTitle', { count: dreamFails.length }),
        detail: dreamFails.slice(0, 4).map((a) => `@${a.username}`).join(' · '),
        focus: dreamFails[0].username,
      });
    }

    // — Echo-chamber roll-up.
    const flags = overviewQ.data?.echoChamberFlags ?? [];
    if (flags.length > 0) {
      rest.push({
        key: 'echo',
        tone: 'warn',
        rank: 3,
        tag: t('lab.conclusions.echoTag'),
        title: t('lab.conclusions.echoTitle', { count: flags.length }),
        detail: flags.map((u) => `@${u}`).join(' · '),
        focus: flags[0],
      });
    } else {
      rest.push({
        key: 'echo',
        tone: 'good',
        rank: 2,
        tag: t('lab.conclusions.echoTag'),
        title: t('lab.conclusions.echoNone'),
        detail: '',
      });
    }

    rest.sort((a, b) => b.rank - a.rank || TONE_RANK[b.tone] - TONE_RANK[a.tone]);
    return [mono, ...rest].slice(0, 6);
  }, [homogQ.data, pulseQ.data, alertsQ.data, overviewQ.data, agents, t]);

  if (overviewQ.isLoading) {
    return <Skeleton height={96} width="100%" />;
  }

  return (
    <section className={s.conclusions}>
      {conclusions.map((c) => {
        const clickable = Boolean(c.focus);
        return (
          <button
            key={c.key}
            type="button"
            className={`${s.conclusion} ${s[`conc_${c.tone}`] ?? ''} ${clickable ? s.concClickable : ''}`}
            onClick={() => c.focus && onSelect(c.focus)}
            disabled={!clickable}
          >
            <span className={s.concTag}>{c.tag}</span>
            <span className={s.concTitle}>{c.title}</span>
            {c.detail && <span className={s.concDetail}>{c.detail}</span>}
          </button>
        );
      })}
    </section>
  );
}
