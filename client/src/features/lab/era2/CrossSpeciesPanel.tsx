import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { InteractionGraphDTO } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

interface Props {
  data: InteractionGraphDTO;
  onSelect?: (username: string) => void;
}

export function CrossSpeciesPanel({ data, onSelect }: Props) {
  const { t } = useTranslation();

  const { agents, humans, matrix, metrics } = useMemo(() => {
    const nodeMap = new Map(data.nodes.map((n) => [n.username, n]));
    const agentList = data.nodes
      .filter((n) => n.isAgent)
      .sort((a, b) => a.username.localeCompare(b.username));
    const humanList = data.nodes
      .filter((n) => !n.isAgent)
      .sort((a, b) => a.username.localeCompare(b.username));

    // Build bidirectional weight: cell[agent][human] = total interactions (both directions)
    const mat = new Map<string, Map<string, number>>();

    for (const edge of data.edges) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;
      if (src.isAgent === tgt.isAgent) continue; // skip same-species

      const [agentU, humanU] = src.isAgent
        ? [edge.source, edge.target]
        : [edge.target, edge.source];

      if (!mat.has(agentU)) mat.set(agentU, new Map());
      const row = mat.get(agentU)!;
      row.set(humanU, (row.get(humanU) ?? 0) + edge.weight);
    }

    // Cross-species edge count and total edge count
    const crossEdges = data.edges.filter((e) => {
      const a = nodeMap.get(e.source);
      const b = nodeMap.get(e.target);
      return a && b && a.isAgent !== b.isAgent;
    });
    const bridgeScore =
      data.edges.length > 0 ? (crossEdges.length / data.edges.length) * 100 : 0;
    const crossVolume = crossEdges.reduce((sum, e) => sum + e.weight, 0);
    const totalVolume = data.edges.reduce((sum, e) => sum + e.weight, 0);
    const bridgeVolumePct = totalVolume > 0 ? (crossVolume / totalVolume) * 100 : 0;

    // Coverage: how many agents interacted with at least 1 human
    const agentsCovered = agentList.filter((a) => {
      const row = mat.get(a.username);
      return row && row.size > 0;
    }).length;
    const humansCovered = humanList.filter((h) =>
      agentList.some((a) => (mat.get(a.username)?.get(h.username) ?? 0) > 0),
    ).length;

    // Reciprocal pairs: agent A <-> human H both have interactions
    const dirSet = new Set(data.edges.map((e) => `${e.source}|${e.target}`));
    let mutualPairs = 0;
    for (const edge of data.edges) {
      const a = nodeMap.get(edge.source);
      const b = nodeMap.get(edge.target);
      if (!a || !b || a.isAgent === b.isAgent) continue;
      if (dirSet.has(`${edge.target}|${edge.source}`)) mutualPairs++;
    }
    // Each mutual pair counted twice (A→B and B→A), divide by 2
    mutualPairs = Math.floor(mutualPairs / 2);

    return {
      agents: agentList,
      humans: humanList,
      matrix: mat,
      metrics: { bridgeScore, bridgeVolumePct, agentsCovered, humansCovered, mutualPairs },
    };
  }, [data]);

  const maxWeight = useMemo(
    () =>
      Math.max(
        1,
        ...Array.from(matrix.values()).flatMap((row) => Array.from(row.values())),
      ),
    [matrix],
  );

  const hasCrossInteraction = matrix.size > 0;

  const loopScore = Math.round(
    ((metrics.agentsCovered / Math.max(agents.length, 1)) * 50 +
      (metrics.humansCovered / Math.max(humans.length, 1)) * 50) *
      (metrics.mutualPairs > 0 ? 1 : 0.7),
  );

  const loopLabel =
    loopScore >= 70
      ? t('lab.loop.healthy')
      : loopScore >= 40
        ? t('lab.loop.partial')
        : t('lab.loop.weak');
  const loopColor =
    loopScore >= 70
      ? 'var(--color-success)'
      : loopScore >= 40
        ? 'var(--color-warning)'
        : 'var(--color-danger)';

  return (
    <section className={s.chartBlock}>
      <div className={s.chartTitle}>{t('lab.loop.title')}</div>
      <p className={s.blockSub}>{t('lab.loop.sub')}</p>

      <div className={s.graphMetrics}>
        <div className={s.graphMetric}>
          <span className={s.graphMetricValue} style={{ color: loopColor }}>
            {loopLabel}
          </span>
          <span className={s.graphMetricLabel}>{t('lab.loop.loopHealth')}</span>
        </div>
        <div className={s.graphMetric}>
          <span className={s.graphMetricValue}>{metrics.bridgeVolumePct.toFixed(0)}%</span>
          <span className={s.graphMetricLabel}>{t('lab.loop.bridgePct')}</span>
        </div>
        <div className={s.graphMetric}>
          <span className={s.graphMetricValue}>
            {metrics.agentsCovered}/{agents.length}
          </span>
          <span className={s.graphMetricLabel}>{t('lab.loop.agentCoverage')}</span>
        </div>
        <div className={s.graphMetric}>
          <span className={s.graphMetricValue}>
            {metrics.humansCovered}/{humans.length}
          </span>
          <span className={s.graphMetricLabel}>{t('lab.loop.humanCoverage')}</span>
        </div>
        <div className={s.graphMetric}>
          <span className={s.graphMetricValue}>{metrics.mutualPairs}</span>
          <span className={s.graphMetricLabel}>{t('lab.loop.mutualPairs')}</span>
        </div>
      </div>

      {!hasCrossInteraction ? (
        <div className={s.emptyState}>{t('lab.loop.empty')}</div>
      ) : (
        <div className={s.heatScrollX}>
          <table className={s.heatTable}>
            <thead>
              <tr>
                <th className={s.heatRowLabel}>{t('lab.loop.agentCol')}</th>
                {humans.map((h) => (
                  <th
                    key={h.username}
                    className={s.heatColLabel}
                    title={h.displayName}
                    onClick={() => onSelect?.(h.username)}
                    style={{ cursor: onSelect ? 'pointer' : undefined }}
                  >
                    @{h.username}
                  </th>
                ))}
                <th className={s.heatTotalLabel}>{t('lab.loop.total')}</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const row = matrix.get(agent.username);
                const rowTotal = humans.reduce(
                  (sum, h) => sum + (row?.get(h.username) ?? 0),
                  0,
                );
                return (
                  <tr key={agent.username}>
                    <td
                      className={s.heatRowLabel}
                      title={agent.displayName}
                      onClick={() => onSelect?.(agent.username)}
                      style={{ cursor: onSelect ? 'pointer' : undefined }}
                    >
                      @{agent.username}
                    </td>
                    {humans.map((h) => {
                      const val = row?.get(h.username) ?? 0;
                      const intensity = val / maxWeight;
                      return (
                        <td
                          key={h.username}
                          className={s.crossHeatCell}
                          style={{
                            backgroundColor:
                              val > 0
                                ? `rgba(99,102,241,${0.1 + intensity * 0.75})`
                                : undefined,
                            color:
                              intensity > 0.55
                                ? 'var(--color-surface)'
                                : intensity > 0
                                  ? 'var(--color-text)'
                                  : 'var(--color-text-muted)',
                          }}
                          title={
                            val > 0
                              ? `${agent.username} ↔ ${h.username}: ${val}`
                              : undefined
                          }
                        >
                          {val > 0 ? val : '·'}
                        </td>
                      );
                    })}
                    <td
                      className={s.heatTotal}
                      style={{ fontWeight: rowTotal > 0 ? 600 : undefined }}
                    >
                      {rowTotal > 0 ? rowTotal : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
