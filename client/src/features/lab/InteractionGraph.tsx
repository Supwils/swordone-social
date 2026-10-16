import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphEdgeDTO, GraphNodeDTO, InteractionGraphDTO } from '@/features/lab/types';
import s from '@/features/lab/lab.module.css';

/**
 * Dependency-free force-directed interaction graph. We deliberately avoid a
 * graph-viz library (keeps the bundle + dep surface lean for ~20–30 nodes): the
 * Fruchterman-Reingold layout below runs once in a useMemo, seeded so positions
 * are deterministic across renders. Edges are coloured by their dominant
 * interaction type; hovering a node highlights its ties (with direction arrows)
 * and fades the rest. A header surfaces the metrics that matter: total volume,
 * the most-connected persona, AI↔person ties, and mutual (reciprocated) pairs.
 */

interface Positioned extends GraphNodeDTO {
  x: number;
  y: number;
}

type EdgeKind = 'comment' | 'reply' | 'echo' | 'like';

const VIEW_W = 820;
const VIEW_H = 600;
const PAD = 48;
const MAX_EDGES = 90; // declutter: only draw the strongest ties past this

const KIND_COLOR: Record<EdgeKind, string> = {
  comment: 'var(--color-accent)',
  reply: 'var(--color-info)',
  echo: 'var(--color-success)',
  like: 'var(--color-border-strong)',
};
const KIND_ORDER: EdgeKind[] = ['comment', 'reply', 'echo', 'like'];

function dominantKind(e: GraphEdgeDTO): EdgeKind {
  let best: EdgeKind = 'like';
  let bestN = -1;
  for (const k of KIND_ORDER) {
    if (e.kinds[k] > bestN) {
      bestN = e.kinds[k];
      best = k;
    }
  }
  return best;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeLayout(nodes: GraphNodeDTO[], edges: GraphEdgeDTO[]): Positioned[] {
  const n = nodes.length;
  if (n === 0) return [];
  const rand = mulberry32(0x9e3779b9 ^ n);
  const idx = new Map(nodes.map((node, i) => [node.username, i]));

  const pos = nodes.map((_, i) => ({
    x: VIEW_W / 2 + Math.cos((2 * Math.PI * i) / n) * 200 + (rand() - 0.5) * 20,
    y: VIEW_H / 2 + Math.sin((2 * Math.PI * i) / n) * 200 + (rand() - 0.5) * 20,
  }));

  const e = edges
    .map((edge) => ({ a: idx.get(edge.source), b: idx.get(edge.target), w: edge.weight }))
    .filter(
      (x): x is { a: number; b: number; w: number } => x.a !== undefined && x.b !== undefined,
    );

  const area = (VIEW_W - PAD * 2) * (VIEW_H - PAD * 2);
  const k = Math.sqrt(area / n);
  let temp = (VIEW_W - PAD * 2) / 8;

  for (let it = 0; it < 320; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy) || 0.01;
        if (dist < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dist = 0.01;
        }
        const force = (k * k) / dist;
        disp[i].x += (dx / dist) * force;
        disp[i].y += (dy / dist) * force;
        disp[j].x -= (dx / dist) * force;
        disp[j].y -= (dy / dist) * force;
      }
    }
    for (const edge of e) {
      const dx = pos[edge.a].x - pos[edge.b].x;
      const dy = pos[edge.a].y - pos[edge.b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const pull = 1 + Math.log1p(edge.w) / 3;
      const force = ((dist * dist) / k) * pull;
      disp[edge.a].x -= (dx / dist) * force;
      disp[edge.a].y -= (dy / dist) * force;
      disp[edge.b].x += (dx / dist) * force;
      disp[edge.b].y += (dy / dist) * force;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      pos[i].x += (disp[i].x / d) * Math.min(d, temp);
      pos[i].y += (disp[i].y / d) * Math.min(d, temp);
    }
    temp = Math.max(temp * 0.95, 1);
  }

  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  return nodes.map((node, i) => ({
    ...node,
    x: PAD + ((pos[i].x - minX) / spanX) * (VIEW_W - PAD * 2),
    y: PAD + ((pos[i].y - minY) / spanY) * (VIEW_H - PAD * 2),
  }));
}

export function InteractionGraph({
  data,
  onSelect,
  crossSpeciesOnly = false,
}: {
  data: InteractionGraphDTO;
  onSelect: (username: string) => void;
  crossSpeciesOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<string | null>(null);

  const nodeByName = useMemo(() => new Map(data.nodes.map((n) => [n.username, n])), [data.nodes]);

  // Metrics from the FULL dataset (not the decluttered draw set).
  const metrics = useMemo(() => {
    const totalInteractions = data.edges.reduce((sum, e) => sum + e.weight, 0);
    const central = data.nodes[0]?.username ?? null; // nodes are strength-sorted
    const agentCount = data.nodes.filter((n) => n.isAgent).length;
    const humanCount = data.nodes.length - agentCount;
    let aiHumanTies = 0;
    const dirSet = new Set(data.edges.map((e) => `${e.source}|${e.target}`));
    let mutualPairs = 0;
    for (const e of data.edges) {
      const a = nodeByName.get(e.source);
      const b = nodeByName.get(e.target);
      if (a && b && a.isAgent !== b.isAgent) aiHumanTies++;
      if (e.source < e.target && dirSet.has(`${e.target}|${e.source}`)) mutualPairs++;
    }
    return { totalInteractions, central, aiHumanTies, mutualPairs, agentCount, humanCount };
  }, [data.edges, data.nodes, nodeByName]);

  // Declutter: draw only the strongest MAX_EDGES ties, keep their incident nodes.
  const { drawNodes, drawEdges, shown } = useMemo(() => {
    const sorted = [...data.edges].sort((a, b) => b.weight - a.weight);
    const edges = sorted.slice(0, MAX_EDGES);
    const names = new Set<string>();
    for (const e of edges) {
      names.add(e.source);
      names.add(e.target);
    }
    const nodes = data.nodes.filter((n) => names.has(n.username));
    return { drawNodes: nodes, drawEdges: edges, shown: edges.length };
  }, [data.edges, data.nodes]);

  const layout = useMemo(() => computeLayout(drawNodes, drawEdges), [drawNodes, drawEdges]);
  const byName = useMemo(() => new Map(layout.map((p) => [p.username, p])), [layout]);

  // Neighbours of the hovered node (for highlight).
  const neighbours = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const e of drawEdges) {
      if (e.source === hover) set.add(e.target);
      if (e.target === hover) set.add(e.source);
    }
    return set;
  }, [hover, drawEdges]);

  if (layout.length === 0 || data.edges.length === 0) {
    return <div className={s.emptyState}>{t('lab.graph.empty')}</div>;
  }

  const maxStrength = Math.max(...layout.map((p) => p.strength), 1);
  const maxWeight = Math.max(...drawEdges.map((e) => e.weight), 1);
  const radius = (strength: number) => 6 + (strength / maxStrength) * 16;

  const metricItems = [
    { label: t('lab.graph.metricInteractions'), value: String(metrics.totalInteractions) },
    {
      label: t('lab.graph.metricNodes'),
      value: `${metrics.agentCount} / ${metrics.humanCount}`,
    },
    { label: t('lab.graph.metricCentral'), value: metrics.central ? `@${metrics.central}` : '—' },
    { label: t('lab.graph.metricMix'), value: String(metrics.aiHumanTies) },
    { label: t('lab.graph.metricReciprocity'), value: String(metrics.mutualPairs) },
  ];

  return (
    <div>
      <div className={s.graphMetrics}>
        {metricItems.map((m) => (
          <div key={m.label} className={s.graphMetric}>
            <span className={s.graphMetricValue}>{m.value}</span>
            <span className={s.graphMetricLabel}>{m.label}</span>
          </div>
        ))}
      </div>

      <svg
        className={s.graphCanvas}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={t('lab.graph.title')}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <marker
            id="lab-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="var(--color-text-muted)" />
          </marker>
        </defs>

        {drawEdges.map((e) => {
          const a = byName.get(e.source);
          const b = byName.get(e.target);
          if (!a || !b) return null;
          const isCrossSpecies = a.isAgent !== b.isAgent;
          const highlighted = neighbours
            ? neighbours.has(e.source) && neighbours.has(e.target)
            : false;
          const dimmedByHover = neighbours ? !highlighted : false;
          const dimmedByCross = crossSpeciesOnly && !isCrossSpecies;
          const dimmed = dimmedByHover || dimmedByCross;
          const boosted = crossSpeciesOnly && isCrossSpecies && !dimmedByHover;
          const color =
            isCrossSpecies && crossSpeciesOnly
              ? 'var(--color-warning)'
              : KIND_COLOR[dominantKind(e)];
          return (
            <line
              key={`${e.source}-${e.target}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color}
              strokeWidth={
                boosted ? 1.2 + (e.weight / maxWeight) * 4.8 : 0.6 + (e.weight / maxWeight) * 3.4
              }
              strokeOpacity={
                dimmed ? 0.04 : highlighted || boosted ? 0.9 : 0.22 + (e.weight / maxWeight) * 0.4
              }
              markerEnd={highlighted || boosted ? 'url(#lab-arrow)' : undefined}
            />
          );
        })}

        {layout.map((p) => {
          const faded = neighbours ? !neighbours.has(p.username) : false;
          return (
            <g
              key={p.username}
              transform={`translate(${p.x},${p.y})`}
              className={s.graphNode}
              role="button"
              tabIndex={0}
              aria-label={t('lab.graph.tooltip', { username: p.username, count: p.strength })}
              opacity={faded ? 0.3 : 1}
              onMouseEnter={() => setHover(p.username)}
              onFocus={() => setHover(p.username)}
              onClick={() => onSelect(p.username)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onSelect(p.username);
                }
              }}
            >
              <title>{t('lab.graph.tooltip', { username: p.username, count: p.strength })}</title>
              <circle
                r={radius(p.strength)}
                fill={p.isAgent ? 'var(--color-accent)' : 'var(--color-success)'}
                fillOpacity={0.85}
                stroke="var(--color-surface)"
                strokeWidth={1.5}
              />
              <text
                y={radius(p.strength) + 12}
                textAnchor="middle"
                fontSize={11}
                fill="var(--color-text-muted)"
              >
                @{p.username}
              </text>
            </g>
          );
        })}
      </svg>

      {shown < data.edges.length && (
        <div className={s.graphShowing}>
          {t('lab.graph.showing', { shown, total: data.edges.length })}
        </div>
      )}

      <div className={s.graphLegend}>
        <span>
          <span className={s.graphDotAgent} /> {t('lab.graph.legendAi')}
        </span>
        <span>
          <span className={s.graphDotHuman} /> {t('lab.graph.legendHuman')}
        </span>
        <span className={s.graphLegendSep} />
        {KIND_ORDER.map((k) => (
          <span key={k}>
            <span className={s.graphLine} style={{ background: KIND_COLOR[k] }} />{' '}
            {t(`lab.graph.kind${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
          </span>
        ))}
        <span className={s.graphLegendSep} />
        <span>{t('lab.graph.legendSize')}</span>
        <span>{t('lab.graph.legendWidth')}</span>
        <span>{t('lab.graph.legendClick')}</span>
      </div>
    </div>
  );
}
