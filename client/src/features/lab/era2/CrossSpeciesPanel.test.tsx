import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@/i18n';
import type { InteractionGraphDTO } from '@/features/lab/types';
import { CrossSpeciesPanel } from './CrossSpeciesPanel';

/**
 * Pure-props panel: the interesting logic is the agent×human matrix build —
 * bidirectional weights, same-species exclusion, coverage and reciprocity
 * metrics. Weights are chosen so every derived number is unique.
 */
function node(username: string, isAgent: boolean) {
  return { username, displayName: username.toUpperCase(), isAgent };
}

function makeGraph(over: Partial<InteractionGraphDTO> = {}): InteractionGraphDTO {
  return {
    range: '30d',
    nodes: [node('abot', true), node('bbot', true), node('hana', false), node('hugo', false)],
    edges: [
      { source: 'abot', target: 'hana', weight: 3 },
      { source: 'hana', target: 'abot', weight: 2 }, // reciprocal pair
      { source: 'abot', target: 'hugo', weight: 1 },
      { source: 'abot', target: 'bbot', weight: 9 }, // same-species — excluded
    ],
    ...over,
  } as unknown as InteractionGraphDTO;
}

afterEach(cleanup);

describe('CrossSpeciesPanel', () => {
  it('builds the bidirectional matrix and skips same-species edges', () => {
    render(<CrossSpeciesPanel data={makeGraph()} />);

    // abot↔hana sums both directions (3+2); abot↔hugo is 1; the 9-weight
    // agent↔agent edge must appear in no cell.
    expect(screen.getByTitle('abot ↔ hana: 5')).toBeTruthy();
    expect(screen.getByTitle('abot ↔ hugo: 1')).toBeTruthy();
    expect(screen.queryByTitle(/bbot ↔/)).toBeNull();
    // abot's row total = 6; bbot never reached a human — em-dash total.
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('derives coverage, bridge share, and loop health from the graph', () => {
    render(<CrossSpeciesPanel data={makeGraph()} />);

    // cross volume 6 of total 15 = 40%
    expect(screen.getByText('40%')).toBeTruthy();
    // 1 of 2 agents reached a human; both humans were reached.
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('2/2')).toBeTruthy();
    // score = 25 + 50, with a reciprocal pair present -> 75 -> Active
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows the empty state when no cross-species edge exists', () => {
    render(
      <CrossSpeciesPanel
        data={makeGraph({
          edges: [{ source: 'abot', target: 'bbot', weight: 4 }],
        } as Partial<InteractionGraphDTO>)}
      />,
    );

    expect(screen.getByText('No cross-species interactions yet in this window.')).toBeTruthy();
  });

  it('reports clicks on row and column identities through onSelect', () => {
    const onSelect = vi.fn();
    render(<CrossSpeciesPanel data={makeGraph()} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('@hana'));
    expect(onSelect).toHaveBeenCalledWith('hana');

    fireEvent.click(screen.getByText('@abot'));
    expect(onSelect).toHaveBeenCalledWith('abot');
  });
});
