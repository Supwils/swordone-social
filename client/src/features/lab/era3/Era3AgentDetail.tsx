/**
 * `Era3AgentDetail` — one live Era 3 account (S2 §9): its rounds from
 * `GET /agents/:u/rounds`, two sparklines over them, the 最近 history from the
 * drift snapshots, and the collapse watch. Archived accounts keep the Era 2
 * detail; LabPage decides which one renders.
 *
 * Descriptive only. Per-account convergence here is against every other roster
 * account in the round, so it can differ slightly from the arms report, which
 * also drops model-mismatch comparators.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, Skeleton } from '@/components/primitives';
import { getAccountRounds } from '@/features/lab/api';
import { labKeys, useAgentDrift } from '@/features/lab/queries';
import { CollapsePanel } from '@/features/lab/CollapsePanel';
import { Sparkline } from '@/features/lab/Sparkline';
import type { AccountRoundDTO, AgentSummaryDTO, LabRange } from '@/features/lab/types';
import labStyles from '@/features/lab/lab.module.css';
import { ARM_COLOR } from './armColors';
import { ArmName } from './ArmName';
import { fmtNum } from './format';
import s from './era3.module.css';

const DASH = '—';

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const count = (v: number | null): string => (finite(v) ? String(v) : DASH);

/** Oldest-first `{v}` rows of one per-round value, skipping rounds without it. */
function series(
  rounds: readonly AccountRoundDTO[],
  pick: (r: AccountRoundDTO) => number | null | undefined,
): Array<{ v: number }> {
  return rounds
    .slice()
    .reverse()
    .map(pick)
    .filter(finite)
    .map((v) => ({ v }));
}

export function Era3AgentDetail({
  username,
  onClose,
  agent,
  range = '30d',
}: {
  username: string;
  onClose: () => void;
  /** The roster entry, for display name and model; the header degrades without it. */
  agent?: AgentSummaryDTO;
  /** Window for the collapse watch, which honours the page's range control. */
  range?: LabRange;
}) {
  const { t } = useTranslation();
  const roundsQ = useQuery({
    queryKey: labKeys.accountRounds(username),
    queryFn: () => getAccountRounds(username),
    staleTime: 60_000,
  });
  // Same key as the Era 2 detail, so a cached read is shared.
  const driftQ = useAgentDrift(username);

  const rounds = useMemo(() => roundsQ.data?.rounds ?? [], [roundsQ.data]);
  const cardSeries = useMemo(() => series(rounds, (r) => r.post?.cardSim), [rounds]);
  const selfSeries = useMemo(() => series(rounds, (r) => r.candidate?.maxSim), [rounds]);
  const snapshots = useMemo(() => (driftQ.data ?? []).slice().reverse(), [driftQ.data]);

  const arm = agent?.arm ?? roundsQ.data?.arm ?? null;
  const model = agent?.agentBackend ?? null;
  const sparkColor = arm ? ARM_COLOR[arm] : undefined;

  const dream = (v: boolean | null) =>
    v === true ? (
      <span title={t('lab.era3.detail.dreamAccepted')}>✓</span>
    ) : v === false ? (
      <span title={t('lab.era3.detail.dreamFailed')}>✗</span>
    ) : (
      DASH
    );

  return (
    <Card className={labStyles.detailPanel}>
      <div className={labStyles.detailHeader}>
        <div className={s.header}>
          <h2 className={labStyles.detailTitle}>
            {agent?.displayName ? `${agent.displayName} ` : ''}
            <Link to={`/u/${username}`}>@{username}</Link>
          </h2>
          <div className={s.hint}>
            {arm ? <ArmName arm={arm} /> : t('lab.era3.detail.noArm')}
            {model && (
              <>
                {' · '}
                <span className={s.chipModel}>{model}</span>
              </>
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label={t('lab.detail.close')}>
          {t('lab.detail.close')} ✕
        </button>
      </div>

      <section className={labStyles.chartBlock}>
        <div className={labStyles.chartTitle}>{t('lab.era3.detail.roundsTitle')}</div>
        <p className={labStyles.blockSub}>{t('lab.era3.detail.roundsSub')}</p>
        {roundsQ.isLoading ? (
          <Skeleton height={120} width="100%" />
        ) : roundsQ.isError ? (
          <div className={labStyles.emptyState}>{t('lab.era3.detail.roundsError')}</div>
        ) : rounds.length === 0 ? (
          <div className={labStyles.emptyState}>{t('lab.era3.detail.roundsEmpty')}</div>
        ) : (
          <div className={s.tableWrap} data-scroll="x">
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">{t('lab.era3.detail.col.round')}</th>
                  <th scope="col">{t('lab.era3.detail.col.kind')}</th>
                  <th scope="col">{t('lab.era3.detail.col.outcome')}</th>
                  <th scope="col">{t('lab.era3.detail.col.act')}</th>
                  <th scope="col">{t('lab.era3.detail.col.attemptedLanded')}</th>
                  <th scope="col">{t('lab.era3.detail.col.dream')}</th>
                  <th scope="col">{t('lab.era3.detail.col.candMaxSim')}</th>
                  <th scope="col">{t('lab.era3.detail.col.candCardSim')}</th>
                  <th scope="col">{t('lab.era3.detail.col.dropped')}</th>
                  <th scope="col">{t('lab.era3.detail.col.postCardSim')}</th>
                  <th scope="col">{t('lab.era3.detail.col.convergence')}</th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.roundId}>
                    <td className={s.token}>{r.roundId}</td>
                    <td>
                      {r.kind === 'sweep'
                        ? t('lab.era3.detail.kindSweep')
                        : t('lab.era3.detail.kindManual')}
                    </td>
                    <td>{r.outcome || DASH}</td>
                    <td>{r.actOutcome ?? DASH}</td>
                    <td>{`${count(r.attempted)} / ${count(r.landed)}`}</td>
                    <td>{dream(r.dreamAccepted)}</td>
                    <td>{fmtNum(r.candidate?.maxSim)}</td>
                    <td>{fmtNum(r.candidate?.cardSim)}</td>
                    <td>{r.candidate?.dropped ? t('lab.era3.detail.droppedYes') : DASH}</td>
                    <td>{fmtNum(r.post?.cardSim)}</td>
                    <td>{fmtNum(r.post?.convergence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={s.note}>{t('lab.era3.detail.convergenceNote')}</p>
      </section>

      <section className={s.exploratoryGrid}>
        <div className={s.subBlock}>
          <h3 className={s.subTitle}>{t('lab.era3.detail.cardSimTitle')}</h3>
          <p className={s.note}>{t('lab.era3.detail.cardSimSub')}</p>
          <div className={labStyles.sparklineWrap}>
            <Sparkline data={cardSeries} color={sparkColor} domain={[0, 1]} />
          </div>
        </div>
        <div className={s.subBlock}>
          <h3 className={s.subTitle}>{t('lab.era3.detail.selfSimTitle')}</h3>
          <p className={s.note}>{t('lab.era3.detail.selfSimSub')}</p>
          <div className={labStyles.sparklineWrap}>
            <Sparkline data={selfSeries} color={sparkColor} domain={[0, 1]} />
          </div>
        </div>
      </section>

      <section className={labStyles.chartBlock}>
        <div className={labStyles.chartTitle}>{t('lab.era3.detail.recentTitle')}</div>
        <p className={labStyles.blockSub}>{t('lab.era3.detail.recentSub')}</p>
        {driftQ.isLoading ? (
          <Skeleton height={80} width="100%" />
        ) : driftQ.isError ? (
          <div className={labStyles.emptyState}>{t('lab.era3.detail.recentError')}</div>
        ) : snapshots.length === 0 ? (
          <div className={labStyles.emptyState}>{t('lab.era3.detail.recentEmpty')}</div>
        ) : (
          <ul className={`${labStyles.timeline} ${s.plainList}`} data-testid="recent-history">
            {snapshots.map((p) => (
              <li key={`${p.capturedAt}-${p.snapshotType}`} className={labStyles.timelineRow}>
                <span className={labStyles.statusDot} aria-hidden />
                <div className={labStyles.timelineBody}>
                  <div className={labStyles.timelineTop}>
                    <span className={labStyles.timelineKind}>
                      {p.snapshotType === 'anchor'
                        ? t('lab.snapshotAnchor')
                        : t('lab.snapshotDream')}
                    </span>
                    <span>{p.capturedAt.slice(0, 10)}</span>
                  </div>
                  <div className={`${labStyles.timelineSummary} ${s.preWrap}`}>
                    {p.excerpt || DASH}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CollapsePanel username={username} range={range} />
    </Card>
  );
}
