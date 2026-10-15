import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  getBenchmarkCompare,
  getBenchmarkLeaderboard,
  getBenchmarkMatrix,
} from '@/features/lab/api';
import { Skeleton } from '@/components/primitives';
import s from '@/features/lab/lab.module.css';

const MODEL_LABEL: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  codex: 'Codex',
};

const modelName = (m: string) => MODEL_LABEL[m] ?? m;
const fmt = (v: number | null, n = 3) => (v === null ? '—' : v.toFixed(n));
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Map a fidelity score to a red→amber→green tint (cosine ~0.4..0.9 useful band). */
function fidTint(v: number | null): string {
  if (v === null) return 'transparent';
  const t = Math.max(0, Math.min(1, (v - 0.4) / 0.5));
  return `hsl(${Math.round(t * 140)} 60% 45% / 0.20)`;
}

/**
 * Persona Bench — the model-comparison eval lane. Three views: a model
 * leaderboard (who stays most in-character), a persona×model fidelity heatmap,
 * and a side-by-side output comparison where the "duplicate content" is the
 * point. Nothing here is a social-feed post — it's the controlled experiment.
 */
export function BenchmarkView() {
  const { t } = useTranslation();
  const lbQ = useQuery({
    queryKey: ['bench-leaderboard'],
    queryFn: getBenchmarkLeaderboard,
    staleTime: 30_000,
  });
  const mxQ = useQuery({ queryKey: ['bench-matrix'], queryFn: getBenchmarkMatrix, staleTime: 30_000 });

  const personas = lbQ.data?.personas ?? [];
  const tasks = lbQ.data?.tasks ?? [];
  const [persona, setPersona] = useState<string | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const curPersona = persona ?? personas[0]?.persona ?? null;
  const curTask = task ?? tasks[0]?.taskId ?? null;

  const cmpQ = useQuery({
    queryKey: ['bench-compare', curPersona, curTask],
    queryFn: () => getBenchmarkCompare(curPersona as string, curTask as string),
    enabled: Boolean(curPersona && curTask),
    staleTime: 30_000,
  });

  const cellMap = useMemo(() => {
    const m = new Map<string, { fidelity: number | null; n: number }>();
    for (const c of mxQ.data?.cells ?? []) m.set(`${c.persona}|${c.model}`, c);
    return m;
  }, [mxQ.data]);

  // Hoisted out of the memo: `typeof cmpQ.data` inside the generic reads as a
  // member access on `cmpQ`, so exhaustive-deps demanded the whole query object
  // as a dependency — which changes identity on every render.
  const compareItems = cmpQ.data?.items;
  const compareCols = useMemo(() => {
    const byModel = new Map<string, NonNullable<typeof compareItems>>();
    for (const it of compareItems ?? []) {
      if (!byModel.has(it.model)) byModel.set(it.model, []);
      byModel.get(it.model)!.push(it);
    }
    return [...byModel.entries()];
  }, [compareItems]);

  if (lbQ.isLoading) return <Skeleton height={420} width="100%" />;

  if (!lbQ.data || lbQ.data.totalRuns === 0) {
    return (
      <section className={s.benchEmpty}>
        <div className={s.chartTitle}>{t('lab.bench.empty')}</div>
        <p className={s.blockSub}>{t('lab.bench.emptySub')}</p>
        <pre className={s.benchCmd}>bash agent/scripts/benchmark-all.sh</pre>
      </section>
    );
  }

  const models = mxQ.data?.models ?? lbQ.data.rows.map((r) => r.model);

  return (
    <div className={s.benchWrap}>
      {/* 1 — Model leaderboard */}
      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.bench.lbTitle')}</div>
        <p className={s.blockSub}>{t('lab.bench.lbSub', { runs: lbQ.data.totalRuns })}</p>
        <div className={s.benchTable}>
          <div className={`${s.benchRow} ${s.benchHead}`}>
            <span>{t('lab.bench.model')}</span>
            <span>{t('lab.bench.fidelity')}</span>
            <span>{t('lab.bench.judge')}</span>
            <span>{t('lab.bench.rule')}</span>
            <span>{t('lab.bench.consistency')}</span>
            <span>{t('lab.bench.latency')}</span>
            <span>{t('lab.bench.runs')}</span>
          </div>
          {lbQ.data.rows.map((r, i) => (
            <div className={s.benchRow} key={r.model}>
              <span className={s.benchModel}>
                <span className={s.benchRank}>{i + 1}</span>
                {modelName(r.model)}
              </span>
              <span style={{ background: fidTint(r.fidelity) }}>{fmt(r.fidelity)}</span>
              <span>{r.judge !== null ? Math.round(r.judge) : '—'}</span>
              <span>{pct(r.rule)}</span>
              <span>{fmt(r.consistency, 2)}</span>
              <span>{r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}</span>
              <span>{r.runs}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 2 — Persona × Model heatmap */}
      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.bench.mxTitle')}</div>
        <p className={s.blockSub}>{t('lab.bench.mxSub')}</p>
        <div
          className={s.heatmap}
          style={{ gridTemplateColumns: `minmax(96px,1.4fr) repeat(${models.length}, 1fr)` }}
        >
          <div className={s.heatCorner} />
          {models.map((m) => (
            <div key={m} className={s.heatColHead}>
              {modelName(m)}
            </div>
          ))}
          {personas.map((p) => (
            <Fragment key={p.persona}>
              <div className={s.heatRowHead} title={`@${p.persona}`}>
                {p.display || p.persona}
              </div>
              {models.map((m) => {
                const cell = cellMap.get(`${p.persona}|${m}`);
                const v = cell?.fidelity ?? null;
                const active = curPersona === p.persona;
                return (
                  <button
                    key={m}
                    className={`${s.heatCell} ${active ? s.heatCellActive : ''}`}
                    style={{ background: fidTint(v) }}
                    title={`@${p.persona} × ${modelName(m)}: ${fmt(v)} (n=${cell?.n ?? 0})`}
                    onClick={() => setPersona(p.persona)}
                  >
                    {v !== null ? v.toFixed(2) : '·'}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      </section>

      {/* 3 — Side-by-side comparison */}
      <section className={s.chartBlock}>
        <div className={s.chartTitle}>{t('lab.bench.cmpTitle')}</div>
        <p className={s.blockSub}>{t('lab.bench.cmpSub')}</p>
        <div className={s.benchSelectors}>
          <select
            className={s.benchSelect}
            value={curPersona ?? ''}
            onChange={(e) => setPersona(e.target.value)}
          >
            {personas.map((p) => (
              <option key={p.persona} value={p.persona}>
                {p.display || p.persona}
              </option>
            ))}
          </select>
          <select
            className={s.benchSelect}
            value={curTask ?? ''}
            onChange={(e) => setTask(e.target.value)}
          >
            {tasks.map((tk) => (
              <option key={tk.taskId} value={tk.taskId}>
                {tk.taskId}
                {tk.kind ? ` · ${tk.kind}` : ''}
              </option>
            ))}
          </select>
        </div>
        {cmpQ.isLoading ? (
          <Skeleton height={200} width="100%" />
        ) : compareCols.length === 0 ? (
          <div className={s.emptyState}>{t('lab.bench.cmpEmpty')}</div>
        ) : (
          <div
            className={s.compareGrid}
            style={{ gridTemplateColumns: `repeat(${compareCols.length}, minmax(180px,1fr))` }}
          >
            {compareCols.map(([model, items]) => (
              <div key={model} className={s.compareCol}>
                <div className={s.compareColHead}>{modelName(model)}</div>
                {items.map((it) => (
                  <div key={`${model}-${it.runIndex}`} className={s.compareCard}>
                    <p className={s.compareText}>{it.output}</p>
                    <div className={s.compareScores}>
                      <span style={{ background: fidTint(it.vectorFidelity) }}>
                        fid {fmt(it.vectorFidelity, 2)}
                      </span>
                      {it.ruleScore !== null && <span>rule {pct(it.ruleScore)}</span>}
                      {it.judgeScore !== null && <span>judge {Math.round(it.judgeScore)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
