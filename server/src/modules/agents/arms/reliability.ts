/**
 * Exploratory reliability (amendment 1): per arm over the completed rounds of
 * the confirmatory window — expected cycles, filed cards, failures, missing
 * cards, attempted/landed actions, dream outcomes, guard drops, missing post
 * vectors — and protocol deviations: manual cycles (any time), model-mismatch
 * cycles in window rounds, and window similarity rows measured against a
 * threshold other than 0.92.
 */
import { ARMS, type ArmId } from '../lab/roster';
import type { ReliabilityRow } from '../../../contract/lab/arms';
import type { CandidateRow } from './metrics';
import { DUPLICATE_THRESHOLD } from './protocol';
import { cardKey, type RoundsState } from './rounds';

const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Pure: `candidates` are the window's similarity rows (`loadWindowCandidates`). */
export function buildReliability(
  state: RoundsState,
  candidates: readonly CandidateRow[],
): ReliabilityRow[] {
  const armByUser = new Map(state.roster.map((u) => [u.id, u.arm]));
  const windowIds = new Set(state.window.map((w) => w.roundId));
  const completed = new Set(state.window.filter((w) => w.completed).map((w) => w.roundId));

  const rows = new Map<ArmId, ReliabilityRow>(
    ARMS.map((a) => [
      a.id,
      {
        arm: a.id,
        // Pre-registered arm size: an unregistered account is a missing card.
        expected: a.usernames.length * completed.size,
        cards: 0,
        fails: 0,
        missing: 0,
        attempted: 0,
        landed: 0,
        dreamsAccepted: 0,
        dreamsFailed: 0,
        guardDrops: 0,
        missingPostVectors: 0,
        deviations: 0,
      },
    ]),
  );
  const rowOf = (userId: string): ReliabilityRow | undefined => {
    const arm = armByUser.get(userId);
    return arm ? rows.get(arm) : undefined;
  };

  for (const c of state.cards) {
    const row = rowOf(c.userId);
    if (!row) continue;
    if (c.kind === 'manual') row.deviations += 1;
    else if (windowIds.has(c.roundId) && state.mismatches.has(cardKey(c.userId, c.roundId))) {
      row.deviations += 1;
    }
    if (!completed.has(c.roundId)) continue;
    const m = c.metrics;
    row.cards += 1;
    if (c.outcome === 'fail') row.fails += 1;
    row.attempted += count(m.attempted);
    row.landed += count(m.landed);
    if (m.dreamAccepted === true) row.dreamsAccepted += 1;
    if (m.dreamAccepted === false) row.dreamsFailed += 1;
    if (m.missingPostVector === true) row.missingPostVectors += 1;
  }

  for (const c of candidates) {
    const row = rowOf(c.userId);
    if (!row || !windowIds.has(c.roundId)) continue;
    // A row without a threshold cannot show it was measured against 0.92.
    if (c.threshold !== DUPLICATE_THRESHOLD) row.deviations += 1;
    if (c.dropped && completed.has(c.roundId)) row.guardDrops += 1;
  }

  return [...rows.values()].map((r) => ({ ...r, missing: Math.max(0, r.expected - r.cards) }));
}
