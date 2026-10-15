import { describe, expect, it } from 'vitest';
import { ARMS, type ArmId } from '../lab/roster';
import type { CandidateRow } from './metrics';
import { buildReliability } from './reliability';
import { buildRounds, type RawCard, type RosterUser } from './rounds';

/** All 20 roster accounts with synthetic ids `id-<username>`. */
const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const MODEL = new Map<ArmId, string>(ARMS.map((a) => [a.id, a.model]));
const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;
const manual = (d: number) => `202610${String(d).padStart(2, '0')}T090000Z-m`;

let seq = 0;
function card(
  username: string,
  roundId: string,
  over: { outcome?: string; model?: string; metrics?: Record<string, unknown> } = {},
): RawCard {
  seq += 1;
  const u = ROSTER.find((r) => r.username === username) as RosterUser;
  const [backend, model] = (over.model ?? (MODEL.get(u.arm) as string)).split(/:(.*)/s);
  return {
    id: `c${String(seq).padStart(6, '0')}`,
    userId: u.id,
    createdAt: new Date(Date.UTC(2026, 9, 1) + seq * 1000),
    outcome: over.outcome ?? 'success',
    metrics: {
      kind: 'cycle_run',
      roundId,
      backend,
      model,
      attempted: 2,
      landed: 1,
      ...over.metrics,
    },
  };
}

const candidate = (
  username: string,
  roundId: string,
  over: Partial<CandidateRow> = {},
): CandidateRow => ({
  userId: `id-${username}`,
  roundId,
  maxSim: 0.3,
  cardSim: 0.8,
  threshold: 0.92,
  dropped: false,
  ...over,
});

const row = (rows: ReturnType<typeof buildReliability>, arm: ArmId) =>
  rows.find((r) => r.arm === arm);

describe('buildReliability (pure)', () => {
  it('zero rounds → one all-zero row per arm', () => {
    const rows = buildReliability(buildRounds([], ROSTER), []);
    expect(rows.map((r) => r.arm)).toEqual(ARMS.map((a) => a.id));
    for (const r of rows) {
      expect(Object.values(r).filter((v) => typeof v === 'number')).toEqual(Array(11).fill(0));
    }
  });

  it('counts expected, cards, missing cards, actions, dreams, drops and deviations', () => {
    const everyone = ROSTER.map((u) => u.username);
    const raw: RawCard[] = [
      // Sweep 1 (completed): laoqian files nothing; awen fails; zhenxian ran the wrong model.
      ...everyone
        .filter((u) => u !== 'laoqian')
        .map((u) =>
          card(u, sweep(1), {
            outcome: u === 'awen' ? 'fail' : 'success',
            model: u === 'zhenxian' ? 'claude:claude-opus-5-5' : undefined,
            metrics: {
              dreamAccepted: u === 'agen' ? true : u === 'xiaoyu' ? false : null,
              missingPostVector: u === 'maike',
            },
          }),
        ),
      // Sweep 2 (completed): everyone; a second agen card is a duplicate and ignored.
      ...everyone.map((u) => card(u, sweep(2))),
      card('agen', sweep(2), { metrics: { attempted: 50, landed: 50 } }),
      // Sweep 3 (incomplete, still in the window): caiyuan ran the wrong model.
      card('caiyuan', sweep(3), { model: 'grok:grok-4.6' }),
      card('agen', sweep(3), { metrics: { attempted: 9, landed: 9 } }),
      // A manual cycle — a deviation, never a counted card.
      card('agen', manual(4)),
    ];
    const state = buildRounds(raw, ROSTER);
    expect(state.window.map((w) => w.completed)).toEqual([true, true, false]);

    const rows = buildReliability(state, [
      candidate('agen', sweep(1), { dropped: true }), // guard drop
      candidate('xiaoyu', sweep(2), { threshold: 0.9 }), // deviation
      candidate('maike', sweep(3), { dropped: true, threshold: 0.85 }), // deviation, not a counted drop
      candidate('maike', sweep(2), { threshold: null }), // no threshold on the row: deviation
      candidate('stranger', sweep(2), { dropped: true, threshold: 0.5 }), // not roster: ignored
    ]);

    expect(row(rows, 'grok')).toEqual({
      arm: 'grok',
      expected: 8,
      cards: 7,
      fails: 1,
      missing: 1,
      attempted: 14,
      landed: 7,
      dreamsAccepted: 0,
      dreamsFailed: 0,
      guardDrops: 0,
      missingPostVectors: 0,
      deviations: 0,
    });
    expect(row(rows, 'openai')).toMatchObject({ expected: 8, cards: 8, missing: 0, deviations: 2 });
    expect(row(rows, 'claude-opus')).toEqual({
      arm: 'claude-opus',
      expected: 8,
      cards: 8,
      fails: 0,
      missing: 0,
      attempted: 16,
      landed: 8,
      dreamsAccepted: 1,
      dreamsFailed: 1,
      guardDrops: 1,
      missingPostVectors: 1,
      deviations: 4,
    });
  });

  it('rounds after the 12th completed one are outside the window', () => {
    const raw: RawCard[] = [];
    for (let d = 1; d <= 13; d += 1) {
      for (const u of ROSTER) {
        // A model mismatch after the freeze is not a window deviation.
        const wrong = d === 13 && u.username === 'agen';
        raw.push(card(u.username, sweep(d), wrong ? { model: 'grok:grok-4.6' } : {}));
      }
    }
    const state = buildRounds(raw, ROSTER);
    expect(state.frozenAt).toBe(sweep(12));
    const rows = buildReliability(state, [candidate('agen', sweep(13), { dropped: true })]);
    expect(row(rows, 'claude-opus')).toMatchObject({
      expected: 48,
      cards: 48,
      guardDrops: 0,
      deviations: 0,
    });
  });
});
