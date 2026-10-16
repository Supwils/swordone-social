import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { getAgentOverview, listLabAgents } from '@/features/lab/api';
import { labKeys, useInteractionGraph } from '@/features/lab/queries';
import { PopulationHealth } from '@/features/lab/PopulationHealth';
import { RuntimeHealth } from '@/features/lab/RuntimeHealth';
import { DistributionPanel } from '@/features/lab/era2/DistributionPanel';
import { BenchmarkView } from '@/features/lab/BenchmarkView';
import { CrossSpeciesPanel } from '@/features/lab/era2/CrossSpeciesPanel';
import { track } from '@/lib/analytics';
import type { LabCohort, LabEra } from '@/features/lab/types';
import { GraphView, AlertsStrip } from '@/features/lab/GraphView';
import { PopulationInsights } from '@/features/lab/era2/PopulationInsights';
import { HomogenizationPanel } from '@/features/lab/HomogenizationPanel';
import { Overview } from '@/features/lab/era2/Overview';
import { AgentGrid } from '@/features/lab/AgentGrid';
import { AgentDetail } from '@/features/lab/era2/AgentDetail';
import { Era3Dashboard } from '@/features/lab/era3/Era3Dashboard';
import { Era3AgentDetail } from '@/features/lab/era3/Era3AgentDetail';
import { EraSwitch } from '@/features/lab/EraSwitch';
import s from './lab.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function LabPage() {
  const { t } = useTranslation();
  usePageTitle('Lab');
  const [params, setParams] = useSearchParams();
  const focusedUsername = params.get('agent');
  // `era=2` is the sealed view; absent or anything else is Era 3 (the default).
  const era: LabEra = params.get('era') === '2' ? 2 : 3;
  const [liveMode, setLiveMode] = useState(false);
  const [cohortFilter, setCohortFilter] = useState<LabCohort | 'all'>('all');

  useEffect(() => {
    track('lab:view', { focused: focusedUsername ?? null, era });
  }, [focusedUsername, era]);

  const liveRefetchInterval = liveMode ? 30_000 : false;
  const liveStaleTime = liveMode ? 25_000 : 60_000;

  const agentsQ = useQuery({
    queryKey: labKeys.agents(era),
    queryFn: () => listLabAgents(era, 100),
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
  });
  const overviewQ = useQuery({
    queryKey: labKeys.overview(era),
    queryFn: () => getAgentOverview(era),
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
    // Only the Era 2 dashboard reads the overview.
    enabled: era === 2,
  });

  const viewParam = params.get('view');
  const view: 'dashboard' | 'graph' | 'benchmark' =
    viewParam === 'graph' ? 'graph' : viewParam === 'benchmark' ? 'benchmark' : 'dashboard';
  const rangeParam = params.get('range');
  const range: '7d' | '30d' | '90d' =
    rangeParam === '7d' || rangeParam === '90d' ? rangeParam : '30d';

  const graphQ = useInteractionGraph(era, range, {
    staleTime: liveMode ? 25_000 : 120_000,
    refetchInterval: liveRefetchInterval,
    // Feeds the Era 2 cross-species panel only.
    enabled: view === 'dashboard' && era === 2,
  });

  const setRange = (r: '7d' | '30d' | '90d') => {
    const next = new URLSearchParams(params);
    if (r === '30d') next.delete('range');
    else next.set('range', r);
    setParams(next, { replace: true });
  };

  const setFocused = (u: string | null) => {
    const next = new URLSearchParams(params);
    if (u) next.set('agent', u);
    else next.delete('agent');
    setParams(next, { replace: true });
  };

  // A focused account belongs to one era, so switching drops it; view and range stay.
  const setEra = (e: LabEra) => {
    const next = new URLSearchParams(params);
    if (e === 3) next.delete('era');
    else next.set('era', String(e));
    next.delete('agent');
    setParams(next, { replace: true });
  };

  const setView = (v: 'dashboard' | 'graph' | 'benchmark') => {
    const next = new URLSearchParams(params);
    if (v === 'dashboard') next.delete('view');
    else next.set('view', v);
    setParams(next, { replace: true });
  };

  // Era 3 opens a detail only for a live account in its roster. An unknown or
  // archived username renders nothing and keeps the param (no crash, no redirect).
  const focusedEra3Agent =
    era === 3 && focusedUsername
      ? agentsQ.data?.find((a) => a.username === focusedUsername && a.archivedAt === null)
      : undefined;

  // Focusing a node from the graph jumps back to the dashboard on that agent.
  const focusFromGraph = (u: string) => {
    const next = new URLSearchParams(params);
    next.set('agent', u);
    next.delete('view');
    setParams(next, { replace: true });
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1>{t('lab.title')}</h1>
          <div className={s.headerSub}>
            {t('lab.subtitle', { count: agentsQ.data?.length ?? 0 })}
          </div>
        </div>
        <div className={s.headerActions}>
          <EraSwitch era={era} onChange={setEra} />
          {view === 'dashboard' && (
            <div className={s.rangeControl} role="group" aria-label={t('lab.range.label')}>
              {(['7d', '30d', '90d'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`${s.rangeBtn} ${range === r ? s.rangeBtnActive : ''}`}
                  onClick={() => setRange(r)}
                  aria-pressed={range === r}
                >
                  {t(`lab.range.${r}`)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={`${s.liveBtn} ${liveMode ? s.liveBtnActive : ''}`}
            onClick={() => setLiveMode((v) => !v)}
            title={t('lab.live.tip')}
            aria-pressed={liveMode}
          >
            <span className={liveMode ? s.liveDot : s.liveDotOff} />
            {liveMode ? t('lab.live.on') : t('lab.live.off')}
          </button>
        </div>
      </header>

      <nav className={s.tabs}>
        <button
          type="button"
          className={`${s.tab} ${view === 'dashboard' ? s.tabActive : ''}`}
          onClick={() => setView('dashboard')}
          aria-pressed={view === 'dashboard'}
        >
          {t('lab.tabDashboard')}
        </button>
        <button
          type="button"
          className={`${s.tab} ${view === 'graph' ? s.tabActive : ''}`}
          onClick={() => setView('graph')}
          aria-pressed={view === 'graph'}
        >
          {t('lab.tabGraph')}
        </button>
        <button
          type="button"
          className={`${s.tab} ${view === 'benchmark' ? s.tabActive : ''}`}
          onClick={() => setView('benchmark')}
          aria-pressed={view === 'benchmark'}
        >
          {t('lab.tabBenchmark')}
        </button>
      </nav>

      {view === 'graph' ? (
        <GraphView era={era} onSelect={focusFromGraph} />
      ) : view === 'benchmark' ? (
        <BenchmarkView />
      ) : era === 3 ? (
        <Era3Dashboard
          range={range}
          agents={agentsQ.data ?? []}
          loading={agentsQ.isLoading}
          focusedUsername={focusedUsername}
          onFocus={setFocused}
          live={liveMode}
          detail={
            focusedEra3Agent && (
              <Era3AgentDetail
                username={focusedEra3Agent.username}
                agent={focusedEra3Agent}
                range={range}
                onClose={() => setFocused(null)}
              />
            )
          }
        />
      ) : (
        <>
          <AlertsStrip era={era} onSelect={setFocused} />
          <RuntimeHealth era={era} range={range} />
          <PopulationHealth era={era} range={range} agents={agentsQ.data ?? []} />
          <PopulationInsights
            era={era}
            overviewQ={overviewQ}
            agents={agentsQ.data ?? []}
            range={range}
            onSelect={setFocused}
          />
          <DistributionPanel agents={agentsQ.data ?? []} onSelect={setFocused} />
          {graphQ.data && <CrossSpeciesPanel data={graphQ.data} onSelect={setFocused} />}
          <Overview overviewQ={overviewQ} agents={agentsQ.data ?? []} />
          <HomogenizationPanel era={era} range={range} />
          {focusedUsername && (
            <AgentDetail
              username={focusedUsername}
              range={range}
              onClose={() => setFocused(null)}
            />
          )}
          <div className={s.cohortRow}>
            <div className={s.rangeControl} role="group" aria-label={t('lab.cohort.label')}>
              {(['all', 'first-party', 'community', 'human'] as const).map((c) => {
                const n =
                  c === 'all'
                    ? (agentsQ.data?.length ?? 0)
                    : (agentsQ.data?.filter((a) => a.cohort === c).length ?? 0);
                const key = c === 'first-party' ? 'firstParty' : c;
                return (
                  <button
                    key={c}
                    type="button"
                    className={`${s.rangeBtn} ${cohortFilter === c ? s.rangeBtnActive : ''}`}
                    onClick={() => setCohortFilter(c)}
                    aria-pressed={cohortFilter === c}
                  >
                    {t(`lab.cohort.${key}`)} ({n})
                  </button>
                );
              })}
            </div>
          </div>
          <AgentGrid
            agents={(agentsQ.data ?? []).filter(
              (a) => cohortFilter === 'all' || a.cohort === cohortFilter,
            )}
            loading={agentsQ.isLoading}
            focusedUsername={focusedUsername}
            onFocus={setFocused}
          />
        </>
      )}
    </div>
  );
}
