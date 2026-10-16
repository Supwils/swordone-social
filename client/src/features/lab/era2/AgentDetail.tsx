/**
 * `AgentDetail` — extracted verbatim from the former `routes/lab.tsx`, which had
 * reached 1406 lines across 12 components. No logic was changed in the move.
 * The lab's composition root is now `features/lab/LabPage.tsx`.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, Skeleton } from '@/components/primitives';
import {
  getAgentDrift,
  getAgentEvents,
  getAgentFidelity,
  getAgentStats,
  getInfluences,
} from '@/features/lab/api';
import type { AgentEventDTO } from '@/features/lab/types';
import { CollapsePanel } from '../CollapsePanel';
import {
  DriftCountdownPanel,
  aspectThresholdsFrom,
  useDriftCountdown,
} from './DriftCountdownPanel';
import s from '@/features/lab/lab.module.css';

/**
 * `range` reaches this component for the two panels at the bottom ONLY, and
 * deliberately so. The charts above are pinned to 30 days by their own labels
 * ("Daily activity (last 30 days)", "Attention it got · 30d"); the countdown and
 * the collapse watch instead honour the page's range control, because for them
 * the window is not a display preference — measured on `liushang`'s real posts,
 * the same collapse reads slope -0.792 ch/day over its own 14 days, -0.046 over
 * 30 (invisible), and +0.761 over 7 (the sign flips).
 *
 * There is no `ASPECT_THRESHOLDS` constant here any more. It was a third copy of
 * the drift thresholds whose comment said to keep it in sync with the Era 1
 * Bash dream script (deleted; Era 3 has no drift gate, 2026-10-14). The
 * thresholds now travel beside each measurement and are read off the wire by
 * `aspectThresholdsFrom`; an aspect whose newest measurement carried none gets
 * no reference line rather than a line drawn at a guess.
 */
export function AgentDetail({
  username,
  range,
  onClose,
}: {
  username: string;
  range: '7d' | '30d' | '90d';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const statsQ = useQuery({
    queryKey: ['agent-stats', username, '30d'],
    queryFn: () => getAgentStats(username, '30d'),
    staleTime: 60_000,
  });
  const driftQ = useQuery({
    queryKey: ['agent-drift', username],
    queryFn: () => getAgentDrift(username),
    staleTime: 60_000,
  });
  const eventsQ = useQuery({
    queryKey: ['agent-events', username],
    queryFn: () => getAgentEvents(username, 20),
    staleTime: 30_000,
  });
  const fidelityQ = useQuery({
    queryKey: ['agent-fidelity', username],
    queryFn: () => getAgentFidelity(username),
    staleTime: 60_000,
  });
  const adherenceQ = useQuery({
    queryKey: ['agent-adherence', username],
    queryFn: () => getAgentEvents(username, 12, 'rule_check'),
    staleTime: 60_000,
  });
  const influencesQ = useQuery({
    queryKey: ['agent-influences', username, '30d'],
    queryFn: () => getInfluences(username, '30d'),
    staleTime: 60_000,
  });
  // Same query key as `DriftCountdownPanel` below, so React Query serves both
  // from one request: the panel needs the projection, the aspect chart needs
  // only the thresholds that travel with it.
  const countdownQ = useDriftCountdown(username, range);
  const aspectThresholds = aspectThresholdsFrom(countdownQ.data);
  const partners = influencesQ.data?.partners ?? [];
  const totalActions = (influencesQ.data?.activity ?? []).reduce((sum, p) => sum + p.actions, 0);

  // Causal overlay: merge daily activity (bars) with drift-from-anchor (line) on
  // a shared date axis so activity spikes can be read against drift movement.
  const causalSeries = useMemo(() => {
    const inf = influencesQ.data;
    if (!inf) return [];
    const byDate = new Map<string, { date: string; actions: number; drift: number | null }>();
    for (const a of inf.activity)
      byDate.set(a.date, { date: a.date, actions: a.actions, drift: null });
    for (const d of inf.drift) {
      const day = d.capturedAt.slice(0, 10);
      const row = byDate.get(day) ?? { date: day, actions: 0, drift: null };
      row.drift = d.distanceFromAnchor;
      byDate.set(day, row);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [influencesQ.data]);
  const causalHasDrift = causalSeries.some((p) => p.drift !== null);

  // Keep only the most recent rule_check per rule (events arrive newest-first).
  const adherence = useMemo(() => {
    const byRule = new Map<string, AgentEventDTO>();
    for (const e of adherenceQ.data ?? []) {
      const rule = typeof e.metrics?.rule === 'string' ? e.metrics.rule : '';
      if (rule && !byRule.has(rule)) byRule.set(rule, e);
    }
    return [...byRule.values()];
  }, [adherenceQ.data]);

  const fidelitySeries = useMemo(
    () =>
      (fidelityQ.data?.points ?? [])
        .filter((p): p is { capturedAt: string; fidelity: number } => p.fidelity !== null)
        .map((p) => ({ x: p.capturedAt.slice(0, 10), fidelity: p.fidelity })),
    [fidelityQ.data],
  );
  const currentFidelity = fidelityQ.data?.current ?? null;

  const driftSeries = useMemo(
    () =>
      (driftQ.data ?? []).map((p) => ({
        x: p.capturedAt.slice(0, 10),
        anchor: p.distanceFromAnchor,
        prev: p.distanceFromPrev,
      })),
    [driftQ.data],
  );
  // Per-aspect sim trajectory — only points that carry aspect data (new dreams).
  const aspectSeries = useMemo(
    () =>
      (driftQ.data ?? [])
        .filter((p) => p.aspects)
        .map((p) => ({
          x: p.capturedAt.slice(0, 10),
          values: p.aspects!.values,
          style: p.aspects!.style,
          topic: p.aspects!.topic,
        })),
    [driftQ.data],
  );
  const aspectMode = useMemo(() => {
    const withAspects = (driftQ.data ?? []).filter((p) => p.aspects);
    return withAspects.length > 0 ? withAspects[withAspects.length - 1].aspects!.mode : null;
  }, [driftQ.data]);
  const cadence = statsQ.data?.cadence ?? [];
  const eng = statsQ.data?.engagement;
  const driftPoints = driftQ.data ?? [];
  const latestSnapshot = driftPoints[driftPoints.length - 1];
  const topInteractors = statsQ.data?.topInteractors ?? [];
  const events = eventsQ.data ?? [];

  const snapType = (type: 'anchor' | 'dream') =>
    type === 'anchor' ? t('lab.snapshotAnchor') : t('lab.snapshotDream');

  return (
    <Card className={s.detailPanel}>
      <div className={s.detailHeader}>
        <h2 className={s.detailTitle}>
          <Link to={`/u/${username}`}>@{username}</Link>
        </h2>
        <button onClick={onClose} aria-label={t('lab.detail.close')}>
          {t('lab.detail.close')} ✕
        </button>
      </div>

      <section className={s.readoutGrid}>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.driftLabel')}</span>
          <span className={s.tileValue}>
            {latestSnapshot ? latestSnapshot.distanceFromAnchor.toFixed(3) : '—'}
          </span>
          <span className={s.tileHint}>
            {latestSnapshot
              ? `${snapType(latestSnapshot.snapshotType)} · ${latestSnapshot.capturedAt.slice(0, 10)}`
              : t('lab.detail.driftWaiting')}
          </span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.fidelity')}</span>
          <span className={s.tileValue}>
            {currentFidelity !== null ? currentFidelity.toFixed(3) : '—'}
          </span>
          <span className={s.tileHint}>
            {currentFidelity !== null
              ? t('lab.detail.fidelityHint')
              : t('lab.detail.fidelityWaiting')}
          </span>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.pull')}</span>
          {eng ? (
            <>
              <div className={s.miniRow}>
                <span>{t('lab.detail.pullAi')}</span>
                <span>
                  {eng.selfPostsReceived.likes.byAi + eng.selfPostsReceived.comments.byAi}
                </span>
              </div>
              <div className={s.miniRow}>
                <span>{t('lab.detail.pullHuman')}</span>
                <span>
                  {eng.selfPostsReceived.likes.byHuman + eng.selfPostsReceived.comments.byHuman}
                </span>
              </div>
            </>
          ) : (
            <Skeleton height={48} width="100%" />
          )}
        </Card>
        <Card className={`${s.tile} ${s.excerptTile}`}>
          <span className={s.tileLabel}>{t('lab.detail.excerpt')}</span>
          <p>{latestSnapshot?.excerpt || t('lab.detail.excerptEmpty')}</p>
        </Card>
        <Card className={s.tile}>
          <span className={s.tileLabel}>{t('lab.detail.topIn')}</span>
          {topInteractors.length > 0 ? (
            <div className={s.compactList}>
              {topInteractors.slice(0, 5).map((item) => (
                <Link key={item.username} to={`/u/${item.username}`} className={s.compactRow}>
                  <span>{item.displayName || `@${item.username}`}</span>
                  <span>{item.count}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className={s.emptyMini}>{t('lab.detail.topInEmpty')}</div>
          )}
        </Card>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.driftChart')}</div>
        <p className={s.blockSub}>{t('lab.detail.driftSub')}</p>
        <div className={s.chartHeight}>
          {driftSeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.driftChartEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={driftSeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="anchor"
                  name={t('lab.detail.driftFromAnchor')}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="prev"
                  name={t('lab.detail.driftFromPrev')}
                  stroke="var(--color-text-muted)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {aspectMode && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>
            {t('lab.detail.aspectChart')}{' '}
            <span className={s.modeBadge}>
              {aspectMode === 'aspect'
                ? t('lab.detail.aspectModeAspect')
                : t('lab.detail.aspectModeShadow')}
            </span>
          </div>
          <p className={s.blockSub}>{t('lab.detail.aspectSub')}</p>
          {/*
            The thresholds as TEXT as well as as reference lines. They are the
            numbers the gate actually used on the newest measurement, and a
            reader should be able to read them off without measuring a dashed
            line — especially since an aspect with none recorded has no line at
            all, which is indistinguishable from a line off the top of the axis.
          */}
          <p className={s.blockSub}>
            {t('lab.detail.aspectThresholds', {
              values: fmtThreshold(aspectThresholds.values, t),
              style: fmtThreshold(aspectThresholds.style, t),
              topic: fmtThreshold(aspectThresholds.topic, t),
            })}
          </p>
          <div className={s.chartHeight}>
            {aspectSeries.length < 2 ? (
              <div className={s.emptyState}>{t('lab.detail.aspectEmpty')}</div>
            ) : (
              <ResponsiveContainer>
                <LineChart data={aspectSeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
                  <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[0, 1]} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {/*
                    Reject thresholds, read off the newest measurement rather than
                    from a constant. A hardcoded copy here drew the ORIGINAL
                    "guard values strictest" values (0.88/0.80/0.70), which the
                    2026-07-03 calibration refuted, and then a second hand-synced
                    copy of the symmetric ones. Both were wrong the moment
                    `agent/.env` moved. An aspect with no recorded threshold gets
                    no line — a missing line is honest, a guessed one is not.
                  */}
                  {aspectThresholds.values !== null && (
                    <ReferenceLine
                      y={aspectThresholds.values}
                      stroke="var(--color-accent)"
                      strokeDasharray="4 4"
                      strokeOpacity={0.5}
                    />
                  )}
                  {aspectThresholds.style !== null && (
                    <ReferenceLine
                      y={aspectThresholds.style}
                      stroke="#e0a458"
                      strokeDasharray="4 4"
                      strokeOpacity={0.5}
                    />
                  )}
                  {aspectThresholds.topic !== null && (
                    <ReferenceLine
                      y={aspectThresholds.topic}
                      stroke="var(--color-text-muted)"
                      strokeDasharray="4 4"
                      strokeOpacity={0.5}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="values"
                    name={t('lab.detail.aspectValues')}
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="style"
                    name={t('lab.detail.aspectStyle')}
                    stroke="#e0a458"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="topic"
                    name={t('lab.detail.aspectTopic')}
                    stroke="var(--color-text-muted)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      )}

      <DriftCountdownPanel username={username} range={range} />
      <CollapsePanel username={username} range={range} />

      {driftPoints.some((p) => p.diffNarrative) && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.diffTitle')}</div>
          <p className={s.blockSub}>{t('lab.detail.diffSub')}</p>
          <div className={s.timeline}>
            {driftPoints
              .filter((p) => p.diffNarrative)
              .slice()
              .reverse()
              .slice(0, 8)
              .map((p) => (
                <div key={p.capturedAt} className={s.diffRow}>
                  <span className={s.diffMeta}>
                    {snapType(p.snapshotType)} · {p.capturedAt.slice(0, 10)}
                  </span>
                  <span className={s.timelineSummary}>{p.diffNarrative}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.fidelityChart')}</div>
        <p className={s.blockSub}>{t('lab.detail.fidelitySub')}</p>
        <div className={s.chartHeight}>
          {fidelitySeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.fidelityChartEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <LineChart data={fidelitySeries} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis dataKey="x" stroke="var(--color-text-muted)" fontSize={11} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} domain={[-1, 1]} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="fidelity"
                  name={t('lab.detail.fidelityLegend')}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.cadence')}</div>
        <p className={s.blockSub}>{t('lab.detail.cadenceSub')}</p>
        <div className={s.chartHeight}>
          {cadence.length === 0 ? (
            <Skeleton height="100%" width="100%" />
          ) : (
            <ResponsiveContainer>
              <BarChart data={cadence} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis dataKey="date" stroke="var(--color-text-muted)" fontSize={10} interval={4} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="posts"
                  stackId="a"
                  fill="var(--color-accent)"
                  name={t('lab.detail.cadencePosts')}
                />
                <Bar
                  dataKey="comments"
                  stackId="a"
                  fill="var(--color-text-muted)"
                  name={t('lab.detail.cadenceComments')}
                />
                <Bar
                  dataKey="likesGiven"
                  stackId="a"
                  fill="var(--color-border)"
                  name={t('lab.detail.cadenceLikes')}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {eng && (
        <section className={s.engagement}>
          <Card className={s.tile}>
            <span className={s.tileLabel}>{t('lab.detail.engReceived')}</span>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesFromAi')}</span>
              <span>{eng.selfPostsReceived.likes.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesFromHuman')}</span>
              <span>{eng.selfPostsReceived.likes.byHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsFromAi')}</span>
              <span>{eng.selfPostsReceived.comments.byAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsFromHuman')}</span>
              <span>{eng.selfPostsReceived.comments.byHuman}</span>
            </div>
          </Card>
          <Card className={s.tile}>
            <span className={s.tileLabel}>{t('lab.detail.engGiven')}</span>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesToAi')}</span>
              <span>{eng.given.likes.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.likesToHuman')}</span>
              <span>{eng.given.likes.toHuman}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsToAi')}</span>
              <span>{eng.given.comments.toAi}</span>
            </div>
            <div className={s.miniRow}>
              <span>{t('lab.detail.commentsToHuman')}</span>
              <span>{eng.given.comments.toHuman}</span>
            </div>
          </Card>
        </section>
      )}

      {adherence.length > 0 && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.rules')}</div>
          <p className={s.blockSub}>{t('lab.detail.rulesSub')}</p>
          <section className={s.readoutGrid}>
            {adherence.map((e) => {
              const rate = typeof e.metrics?.passRate === 'number' ? e.metrics.passRate : null;
              const rule = typeof e.metrics?.rule === 'string' ? e.metrics.rule : 'rule';
              return (
                <Card key={e.id} className={s.tile}>
                  <span className={s.tileLabel}>{rule}</span>
                  <span className={s.tileValue}>
                    {rate !== null ? `${Math.round(rate * 100)}%` : '—'}
                  </span>
                  <span className={s.tileHint}>{e.summary}</span>
                </Card>
              );
            })}
          </section>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.causal')}</div>
        <p className={s.blockSub}>{t('lab.detail.causalSub')}</p>
        <div className={s.chartHeight}>
          {causalSeries.length < 2 ? (
            <div className={s.emptyState}>{t('lab.detail.causalEmpty')}</div>
          ) : (
            <ResponsiveContainer>
              <ComposedChart data={causalSeries} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  stroke="var(--color-text-muted)"
                  fontSize={10}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="actions"
                  stroke="var(--color-text-muted)"
                  fontSize={11}
                  allowDecimals={false}
                />
                <YAxis
                  yAxisId="drift"
                  orientation="right"
                  stroke="var(--color-text-muted)"
                  fontSize={11}
                  domain={[0, 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  yAxisId="actions"
                  dataKey="actions"
                  name={t('lab.detail.causalActions')}
                  fill="var(--color-border-strong)"
                  isAnimationActive={false}
                />
                {causalHasDrift && (
                  <Line
                    yAxisId="drift"
                    type="monotone"
                    dataKey="drift"
                    name={t('lab.detail.causalDrift')}
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {partners.length > 0 && (
        <section className={s.chartBlock}>
          <div className={s.chartTitle}>{t('lab.detail.pulled', { count: totalActions })}</div>
          <p className={s.blockSub}>{t('lab.detail.pulledSub')}</p>
          <div className={s.timeline}>
            {partners.map((p) => (
              <div key={p.username} className={s.diffRow}>
                <span className={s.diffMeta}>
                  @{p.username} · {t('lab.detail.pulledMeta', { count: p.interactions })}
                  {p.proximity !== null ? ` · ${p.proximity.toFixed(3)}` : ''}
                </span>
                <span className={s.proxBar}>
                  <span
                    className={s.proxFill}
                    style={{ width: `${Math.max(0, Math.min(1, p.proximity ?? 0)) * 100}%` }}
                  />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.detail.timeline')}</div>
        <p className={s.blockSub}>{t('lab.detail.timelineSub')}</p>
        <EventTimeline events={events} loading={eventsQ.isLoading} />
      </section>
    </Card>
  );
}

/** A recorded threshold, or the reason there is none. Never a guessed number. */
function fmtThreshold(value: number | null, t: TFunction): string {
  return value === null ? t('lab.countdown.thresholdAbsent') : value.toFixed(3);
}

function EventTimeline({ events, loading }: { events: AgentEventDTO[]; loading: boolean }) {
  const { t } = useTranslation();
  if (loading) return <Skeleton height={120} width="100%" />;
  if (events.length === 0) {
    return <div className={s.emptyState}>{t('lab.detail.timelineEmpty')}</div>;
  }
  return (
    <div className={s.timeline}>
      {events.map((event) => (
        <div key={event.id} className={s.timelineRow}>
          <div className={`${s.statusDot} ${s[`status_${event.outcome}`] ?? ''}`} />
          <div className={s.timelineBody}>
            <div className={s.timelineTop}>
              <span className={s.timelineKind}>
                {event.phase}
                {event.action ? ` · ${event.action}` : ''}
              </span>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
            <div className={s.timelineSummary}>{event.summary}</div>
            {event.reason && <div className={s.timelineReason}>{event.reason}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
