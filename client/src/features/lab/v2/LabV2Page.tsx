/**
 * Lab v2 (docs/superpowers/specs/2026-10-17-lab-v2-design.md): narrative first —
 * the experiment strip, one round's digest (`?round=`, default the newest
 * sweep), storylines (`?agent=`), then the experiment metrics. The older lab
 * (Era 2, graph, Bench) lives unchanged at `/lab/v1`.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Skeleton } from '@/components/primitives';
import { getArmsReport, getRoundDigest, listLabAgents, listRounds } from '@/features/lab/api';
import { labKeys, LAB_STALE_MS } from '@/features/lab/queries';
import type { RoundListItem } from '@/features/lab/types';
import labStyles from '@/features/lab/lab.module.css';
import { ArmsMetrics } from '@/features/lab/metrics/ArmsMetrics';
import { usePageTitle } from '@/lib/usePageTitle';
import { ExperimentStrip } from './ExperimentStrip';
import { ObserverNote } from './ObserverNote';
import { RoundDigest } from './RoundDigest';
import { RoundPicker } from './RoundPicker';
import { Storylines } from './Storylines';
import s from './v2.module.css';

/** Newest sweep round, else the newest round of any kind (the list is newest first). */
export function defaultRoundId(rounds: RoundListItem[]): string | null {
  return rounds.find((r) => r.kind === 'sweep')?.roundId ?? rounds[0]?.roundId ?? null;
}

/** A malformed (400) or unknown (404) round id. */
export function isMissingRound(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 404 || status === 400;
}

/** A one-line notice with one way on (retry, or back to the newest round). */
function Notice({
  message,
  action,
  onAction,
}: {
  message: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className={labStyles.emptyState}>
      {message}{' '}
      <button type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

export default function LabV2Page() {
  const { t } = useTranslation();
  usePageTitle('Lab');
  const [params, setParams] = useSearchParams();
  // An empty `?round=` means no choice: `getRoundDigest('')` would hit the list route.
  const roundParam = params.get('round') || null;
  const focused = params.get('agent');

  const roundsQ = useQuery({
    queryKey: labKeys.rounds,
    queryFn: listRounds,
    staleTime: LAB_STALE_MS,
  });
  const armsQ = useQuery({
    queryKey: labKeys.arms,
    queryFn: getArmsReport,
    staleTime: LAB_STALE_MS,
  });
  const agentsQ = useQuery({
    queryKey: labKeys.agents(3),
    queryFn: () => listLabAgents(3, 100),
    staleTime: LAB_STALE_MS,
  });
  const rounds = roundsQ.data?.rounds ?? [];
  const selected = roundParam ?? defaultRoundId(rounds);
  const digestQ = useQuery({
    queryKey: labKeys.round(selected ?? ''),
    queryFn: () => getRoundDigest(selected as string),
    enabled: !!selected,
    staleTime: LAB_STALE_MS,
    // A missing round is an answer, not a blip; the error states offer their own way on.
    retry: false,
  });

  const setParam = (key: 'round' | 'agent', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Replace, not push: rounds and the focused account are views, not navigation history.
    setParams(next, { replace: true });
  };

  const status = (label: string) => (
    <div aria-label={label} role="status">
      <Skeleton height={160} width="100%" />
    </div>
  );

  let digestBody: ReactNode;
  if (roundParam === null && roundsQ.isLoading) {
    digestBody = status(t('lab.v2.digest.loading'));
  } else if (roundParam === null && roundsQ.isError) {
    digestBody = (
      <Notice
        message={t('lab.v2.digest.error')}
        action={t('lab.v2.digest.retry')}
        onAction={() => void roundsQ.refetch()}
      />
    );
  } else if (selected === null) {
    digestBody = <div className={labStyles.emptyState}>{t('lab.v2.digest.empty')}</div>;
  } else if (digestQ.isError && isMissingRound(digestQ.error)) {
    digestBody = (
      <Notice
        message={t('lab.v2.digest.notFound')}
        action={t('lab.v2.digest.backToNewest')}
        onAction={() => setParam('round', null)}
      />
    );
  } else if (digestQ.isError) {
    digestBody = (
      <Notice
        message={t('lab.v2.digest.error')}
        action={t('lab.v2.digest.retry')}
        onAction={() => void digestQ.refetch()}
      />
    );
  } else if (!digestQ.data) {
    digestBody = status(t('lab.v2.digest.loading'));
  } else {
    digestBody = (
      <>
        <RoundDigest digest={digestQ.data} />
        <ObserverNote observation={digestQ.data.observation} />
      </>
    );
  }

  return (
    <div className={`${labStyles.page} ${s.page}`}>
      <header className={labStyles.header}>
        <div>
          <h1>{t('lab.title')}</h1>
          <div className={labStyles.headerSub}>{t('lab.v2.sub')}</div>
        </div>
        <nav className={labStyles.headerActions} aria-label={t('lab.v2.nav')}>
          <Link to="/lab/v1?view=benchmark">{t('lab.v2.bench')}</Link>
          <Link to="/lab/v1">{t('lab.v2.olderView')}</Link>
        </nav>
      </header>

      {armsQ.data && <ExperimentStrip report={armsQ.data} rounds={rounds} now={Date.now()} />}

      {selected !== null && rounds.length > 0 && (
        <RoundPicker rounds={rounds} value={selected} onChange={(id) => setParam('round', id)} />
      )}
      {digestBody}

      <Storylines
        agents={agentsQ.data ?? []}
        loading={agentsQ.isLoading}
        focused={focused}
        onFocus={(u) => setParam('agent', u)}
        onClose={() => setParam('agent', null)}
      />

      <section className={s.digest}>
        <h2 className={s.sectionTitle}>{t('lab.v2.metrics.title')}</h2>
        {armsQ.data ? (
          <ArmsMetrics report={armsQ.data} />
        ) : armsQ.isError ? (
          <div className={labStyles.emptyState}>{t('lab.era3.error')}</div>
        ) : (
          status(t('lab.era3.loading'))
        )}
      </section>
    </div>
  );
}
