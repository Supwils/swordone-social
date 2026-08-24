import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { getAgentOverview, getInteractionGraph, listLabAgents } from '@/api/agents';
import { PopulationHealth } from '@/features/lab/PopulationHealth';
import { RuntimeHealth } from '@/features/lab/RuntimeHealth';
import { DistributionPanel } from '@/features/lab/DistributionPanel';
import { BenchmarkView } from '@/features/lab/BenchmarkView';
import { CrossSpeciesPanel } from '@/features/lab/CrossSpeciesPanel';
import { track } from '@/lib/analytics';
import type { LabCohort } from '@/api/types';
import { GraphView, AlertsStrip } from '@/features/lab/GraphView';
import { PopulationInsights } from '@/features/lab/PopulationInsights';
import { HomogenizationPanel } from '@/features/lab/HomogenizationPanel';
import { Overview } from '@/features/lab/Overview';
import { AgentGrid } from '@/features/lab/AgentGrid';
import { AgentDetail } from '@/features/lab/AgentDetail';
import s from './lab.module.css';
import { usePageTitle } from '@/lib/usePageTitle';

export default function LabRoute() {
  const { t } = useTranslation();
  usePageTitle('Lab');
  const [params, setParams] = useSearchParams();
  const focusedUsername = params.get('agent');
  const [liveMode, setLiveMode] = useState(false);
  const [cohortFilter, setCohortFilter] = useState<LabCohort | 'all'>('all');

  useEffect(() => {
    track('lab:view', { focused: focusedUsername ?? null });
  }, [focusedUsername]);

  const liveRefetchInterval = liveMode ? 30_000 : false;
  const liveStaleTime = liveMode ? 25_000 : 60_000;

  const agentsQ = useQuery({
    queryKey: ['lab-agents'],
    queryFn: () => listLabAgents(100),
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
  });
  const overviewQ = useQuery({
    queryKey: ['lab-overview'],
    queryFn: getAgentOverview,
    staleTime: liveStaleTime,
    refetchInterval: liveRefetchInterval,
  });

  const viewParam = params.get('view');
  const view: 'dashboard' | 'graph' | 'benchmark' =
    viewParam === 'graph' ? 'graph' : viewParam === 'benchmark' ? 'benchmark' : 'dashboard';
  const rangeParam = params.get('range');
  const range: '7d' | '30d' | '90d' =
    rangeParam === '7d' || rangeParam === '90d' ? rangeParam : '30d';

  const graphQ = useQuery({
    queryKey: ['lab-graph', range],
    queryFn: () => getInteractionGraph(range),
    staleTime: liveMode ? 25_000 : 120_000,
    refetchInterval: liveRefetchInterval,
    enabled: view === 'dashboard',
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

  const setView = (v: 'dashboard' | 'graph' | 'benchmark') => {
    const next = new URLSearchParams(params);
    if (v === 'dashboard') next.delete('view');
    else next.set('view', v);
    setParams(next, { replace: true });
  };

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
        <GraphView onSelect={focusFromGraph} />
      ) : view === 'benchmark' ? (
        <BenchmarkView />
      ) : (
        <>
          <AlertsStrip onSelect={setFocused} />
          <RuntimeHealth range={range} />
          <PopulationHealth range={range} agents={agentsQ.data ?? []} />
          <PopulationInsights
            overviewQ={overviewQ}
            agents={agentsQ.data ?? []}
            range={range}
            onSelect={setFocused}
          />
          <DistributionPanel agents={agentsQ.data ?? []} onSelect={setFocused} />
          {graphQ.data && <CrossSpeciesPanel data={graphQ.data} onSelect={setFocused} />}
          <Overview overviewQ={overviewQ} agents={agentsQ.data ?? []} />
          <HomogenizationPanel range={range} />
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
