import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import type { GraphEdge, GraphNode, InteractionGraphDTO } from '@/api/types';
import { InteractionGraph } from './InteractionGraph';

/**
 * The layout is a seeded Fruchterman-Reingold pass (mulberry32), so renders
 * are deterministic without stubbing anything. Assertions target the metric
 * header, node/edge presence, hover fading, and the declutter note — never
 * coordinates.
 */
function node(username: string, isAgent: boolean, strength: number): GraphNode {
  return { username, displayName: username.toUpperCase(), isAgent, strength };
}

function edge(source: string, target: string, weight: number, kind = 'comment'): GraphEdge {
  return {
    source,
    target,
    weight,
    kinds: { comment: 0, reply: 0, echo: 0, like: 0, [kind]: weight } as GraphEdge['kinds'],
  };
}

function makeGraph(over: Partial<InteractionGraphDTO> = {}): InteractionGraphDTO {
  return {
    range: '30d',
    // nodes are strength-sorted by the API; the component relies on that.
    nodes: [node('hub', true, 9), node('h1', false, 4), node('a2', true, 2)],
    edges: [
      edge('hub', 'h1', 5, 'comment'),
      edge('h1', 'hub', 2, 'like'), // reciprocal + cross-species
      edge('hub', 'a2', 1, 'reply'),
    ],
    ...over,
  };
}

function metricValue(label: string): string {
  const labelEl = screen.getByText(label);
  return labelEl.parentElement?.firstChild?.textContent ?? '';
}

afterEach(cleanup);

describe('InteractionGraph', () => {
  it('computes the header metrics from the full graph', () => {
    render(<InteractionGraph data={makeGraph()} onSelect={() => undefined} />);

    expect(metricValue('interactions')).toBe('8'); // 5 + 2 + 1
    expect(metricValue('AI / people')).toBe('2 / 1');
    expect(metricValue('most connected')).toBe('@hub');
    expect(metricValue('AI ↔ person ties')).toBe('2'); // hub↔h1 both directions
    expect(metricValue('mutual pairs')).toBe('1');
  });

  it('draws one dot and label per account', () => {
    const { container } = render(
      <InteractionGraph data={makeGraph()} onSelect={() => undefined} />,
    );

    expect(container.querySelectorAll('circle')).toHaveLength(3);
    // '@hub' appears twice: the central-node metric and the svg label.
    expect(screen.getAllByText('@hub')).toHaveLength(2);
    expect(screen.getAllByText('@h1')).toHaveLength(1);
    expect(container.querySelectorAll('line')).toHaveLength(3);
  });

  it('reports node activation through onSelect (click and keyboard)', () => {
    const onSelect = vi.fn();
    render(<InteractionGraph data={makeGraph()} onSelect={onSelect} />);

    const h1 = screen.getByRole('button', { name: '@h1 · 4 interactions' });
    fireEvent.click(h1);
    expect(onSelect).toHaveBeenCalledWith('h1');

    fireEvent.keyDown(screen.getByRole('button', { name: '@a2 · 2 interactions' }), {
      key: 'Enter',
    });
    expect(onSelect).toHaveBeenCalledWith('a2');
  });

  it('fades the accounts outside the hovered neighbourhood', () => {
    render(<InteractionGraph data={makeGraph()} onSelect={() => undefined} />);

    // h1's neighbourhood is {h1, hub}; a2 must fade.
    fireEvent.mouseEnter(screen.getByRole('button', { name: '@h1 · 4 interactions' }));

    expect(
      screen.getByRole('button', { name: '@a2 · 2 interactions' }).getAttribute('opacity'),
    ).toBe('0.3');
    expect(
      screen.getByRole('button', { name: '@hub · 9 interactions' }).getAttribute('opacity'),
    ).toBe('1');
  });

  it('shows the empty state without edges', () => {
    render(
      <InteractionGraph data={makeGraph({ edges: [] })} onSelect={() => undefined} />,
    );

    expect(screen.getByText('No interactions in this window yet.')).toBeTruthy();
  });

  it('declutters past 90 edges and says how many it kept', () => {
    // A hub-and-spoke with 95 edges across 96 nodes.
    const nodes = [node('center', true, 95)];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 95; i += 1) {
      nodes.push(node(`n${i}`, i % 2 === 0, 1));
      edges.push(edge('center', `n${i}`, 1 + (i % 5)));
    }

    render(
      <InteractionGraph data={makeGraph({ nodes, edges })} onSelect={() => undefined} />,
    );

    expect(screen.getByText('showing the 90 strongest of 95 connections')).toBeTruthy();
  });
});
