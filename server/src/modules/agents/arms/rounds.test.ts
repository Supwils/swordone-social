import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../db/client';
import { agentEvents } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { ARMS, type ArmId } from '../lab/roster';
import { seedUser } from '../lab/lab.testSeeds';
import {
  buildRounds,
  cardKey,
  dedupeCards,
  loadRoundsState,
  parseRoundId,
  type RawCard,
  type RosterUser,
} from './rounds';

/** All 20 roster accounts with synthetic ids `id-<username>`. */
const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const MODEL: Record<ArmId, string> = Object.fromEntries(ARMS.map((a) => [a.id, a.model])) as Record<
  ArmId,
  string
>;

/** Sweep id for day `d` (1-based) of October 2026, 06:00 UTC. */
const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;
const manual = (d: number) => `202610${String(d).padStart(2, '0')}T090000Z-m`;

let seq = 0;
function card(
  user: RosterUser,
  roundId: string,
  over: {
    outcome?: string;
    model?: string;
    createdAt?: Date;
    metrics?: Record<string, unknown>;
  } = {},
): RawCard {
  seq += 1;
  const [backend, model] = (over.model ?? MODEL[user.arm]).split(/:(.*)/s);
  return {
    id: `c${String(seq).padStart(6, '0')}`,
    userId: user.id,
    createdAt: over.createdAt ?? new Date(Date.UTC(2026, 9, 1) + seq * 1000),
    outcome: over.outcome ?? 'success',
    metrics: { kind: 'cycle_run', roundId, backend, model, ...over.metrics },
  };
}

/** One card from each of the first `n` roster accounts. */
const cardsFor = (roundId: string, n = 20) => ROSTER.slice(0, n).map((u) => card(u, roundId));

describe('parseRoundId', () => {
  it('reads kind and startedAt from a sweep and a manual id', () => {
    expect(parseRoundId('20261014T060102Z-r')).toEqual({
      kind: 'sweep',
      startedAt: '2026-10-14T06:01:02.000Z',
    });
    expect(parseRoundId('20261014T235959Z-m')).toEqual({
      kind: 'manual',
      startedAt: '2026-10-14T23:59:59.000Z',
    });
  });

  it.each([
    '20261014T060000Z',
    '20261014T060000Z-x',
    '2026-10-14T06:00:00Z-r',
    ' 20261014T060000Z-r',
    '20261340T060000Z-r', // month 13
    '20260230T060000Z-r', // 30 February
    '20261014T250000Z-r',
  ])('rejects %j', (id) => {
    expect(parseRoundId(id)).toBeNull();
  });
});

describe('dedupeCards', () => {
  it('keeps the earliest card per (account, round) and drops invalid round ids', () => {
    const u = ROSTER[0];
    const late = card(u, sweep(1), { createdAt: new Date('2026-10-01T07:00:00Z') });
    const early = card(u, sweep(1), { createdAt: new Date('2026-10-01T06:30:00Z') });
    const bad = card(u, 'not-a-round');
    const none = { ...card(u, sweep(2)), metrics: { kind: 'cycle_run' } };
    const out = dedupeCards([late, early, bad, none]);
    expect(out.map((c) => c.id)).toEqual([early.id]);
    expect(out[0]).toMatchObject({ roundId: sweep(1), kind: 'sweep' });
  });
});

describe('buildRounds', () => {
  it('is empty and all-zero with no cards', () => {
    const s = buildRounds([], ROSTER);
    expect(s.rounds).toEqual([]);
    expect(s.window).toEqual([]);
    expect(s.frozenAt).toBeNull();
    expect(s.completedRounds).toBe(0);
    expect(s.armRounds).toEqual({
      openai: 0,
      grok: 0,
      gemini: 0,
      'claude-opus': 0,
      'claude-haiku': 0,
    });
  });

  it('marks a sweep completed at 10 cards, not at 9', () => {
    const s = buildRounds([...cardsFor(sweep(1), 10), ...cardsFor(sweep(2), 9)], ROSTER);
    expect(s.rounds).toEqual([
      {
        roundId: sweep(1),
        kind: 'sweep',
        startedAt: '2026-10-01T06:00:00.000Z',
        cards: 10,
        completed: true,
        ordinal: 1,
        inWindow: true,
      },
      {
        roundId: sweep(2),
        kind: 'sweep',
        startedAt: '2026-10-02T06:00:00.000Z',
        cards: 9,
        completed: false,
        ordinal: 2,
        inWindow: true,
      },
    ]);
    expect(s.completedRounds).toBe(1);
  });

  it('ignores a duplicate card for the same account and round', () => {
    const cards = [...cardsFor(sweep(1), 9), card(ROSTER[0], sweep(1))];
    const s = buildRounds(cards, ROSTER);
    expect(s.rounds[0]).toMatchObject({ cards: 9, completed: false });
  });

  it('keeps the FIRST card of a duplicate pair, model label included', () => {
    const u = ROSTER[0];
    const first = card(u, sweep(1), { createdAt: new Date('2026-10-01T06:01:00Z') });
    const second = card(u, sweep(1), {
      model: 'claude:claude-opus-5-5',
      createdAt: new Date('2026-10-01T06:02:00Z'),
    });
    expect(buildRounds([second, first], ROSTER).mismatches.size).toBe(0);

    const badFirst = card(u, sweep(2), {
      model: 'claude:claude-opus-5-5',
      createdAt: new Date('2026-10-02T06:01:00Z'),
    });
    const goodSecond = card(u, sweep(2), { createdAt: new Date('2026-10-02T06:02:00Z') });
    const s = buildRounds([goodSecond, badFirst], ROSTER);
    expect([...s.mismatches]).toEqual([cardKey(u.id, sweep(2))]);
  });

  it('lists manual rounds without ordinal, window or completion, newest last', () => {
    const s = buildRounds(
      [...cardsFor(manual(2), 12), ...cardsFor(sweep(1)), ...cardsFor(sweep(3))],
      ROSTER,
    );
    expect(s.rounds.map((r) => [r.roundId, r.kind, r.ordinal, r.inWindow, r.completed])).toEqual([
      [sweep(1), 'sweep', 1, true, true],
      [manual(2), 'manual', null, false, false],
      [sweep(3), 'sweep', 2, true, true],
    ]);
    expect(s.window.map((w) => w.roundId)).toEqual([sweep(1), sweep(3)]);
    expect(s.completedRounds).toBe(2);
  });

  it('closes the window at the 12th completed round; later sweeps fall outside', () => {
    const cards = Array.from({ length: 14 }, (_, i) => cardsFor(sweep(i + 1))).flat();
    const s = buildRounds(cards, ROSTER);
    expect(s.frozenAt).toBe(sweep(12));
    expect(s.window).toHaveLength(12);
    expect(s.completedRounds).toBe(14);
    expect(s.rounds[11]).toMatchObject({ roundId: sweep(12), ordinal: 12, inWindow: true });
    expect(s.rounds[12]).toMatchObject({ roundId: sweep(13), ordinal: null, inWindow: false });
    expect(s.rounds[13]).toMatchObject({ roundId: sweep(14), ordinal: null, inWindow: false });
    expect(s.armRounds.openai).toBe(12);
  });

  it('keeps an incomplete sweep in the window with its own ordinal', () => {
    const cards = Array.from({ length: 13 }, (_, i) =>
      cardsFor(sweep(i + 1), i === 2 ? 4 : 20),
    ).flat();
    const s = buildRounds(cards, ROSTER);
    expect(s.window).toHaveLength(13);
    expect(s.window[2]).toEqual({ roundId: sweep(3), ordinal: 3, completed: false });
    expect(s.frozenAt).toBe(sweep(13));
    expect(s.completedRounds).toBe(12);
  });

  it('is provisional (not frozen) below 12 completed rounds; every sweep is in the window', () => {
    const cards = Array.from({ length: 5 }, (_, i) => cardsFor(sweep(i + 1))).flat();
    const s = buildRounds(cards, ROSTER);
    expect(s.frozenAt).toBeNull();
    expect(s.window.map((w) => w.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it('counts arm rounds: completed window rounds with ≥ 1 non-fail, model-matched card', () => {
    const openai = ROSTER.filter((u) => u.arm === 'openai');
    const others = ROSTER.filter((u) => u.arm !== 'openai');
    const r = (d: number, arm: RawCard[]) => [...others.map((u) => card(u, sweep(d))), ...arm];
    const cards = [
      // 1: one success among fails → counts
      ...r(1, [card(openai[0], sweep(1), { outcome: 'fail' }), card(openai[1], sweep(1))]),
      // 2: fail only → no
      ...r(
        2,
        openai.map((u) => card(u, sweep(2), { outcome: 'fail' })),
      ),
      // 3: warn/skip count (any non-fail outcome)
      ...r(3, [card(openai[2], sweep(3), { outcome: 'warn' })]),
      // 4: model mismatch only → no
      ...r(4, [card(openai[3], sweep(4), { model: 'claude:claude-opus-5-5' })]),
      // 5: incomplete sweep (openai alone) → no
      ...openai.map((u) => card(u, sweep(5))),
      // manual round → no
      ...openai.map((u) => card(u, manual(6))),
    ];
    const s = buildRounds(cards, ROSTER);
    expect(s.armRounds.openai).toBe(2);
    expect(s.armRounds.grok).toBe(4);
  });

  it('flags a model mismatch, including a card with no model label', () => {
    const [a, b, c] = ROSTER;
    const noLabel = { ...card(c, sweep(1)), metrics: { kind: 'cycle_run', roundId: sweep(1) } };
    const s = buildRounds(
      [card(a, sweep(1), { model: 'grok:grok-4.6' }), card(b, sweep(1)), noLabel],
      ROSTER,
    );
    expect([...s.mismatches].sort()).toEqual(
      [cardKey(a.id, sweep(1)), cardKey(c.id, sweep(1))].sort(),
    );
  });

  it('ignores cards from accounts outside the roster', () => {
    const stranger = { id: 'id-stranger', username: 'stranger', arm: 'openai' as const };
    const s = buildRounds([...cardsFor(sweep(1), 9), card(stranger, sweep(1))], ROSTER);
    expect(s.rounds[0].cards).toBe(9);
  });
});

describe('loadRoundsState (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('loads roster cycle_run cards only, whatever the account status', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    const awen = await seedUser({ username: 'awen', isAgent: true });
    const gone = await seedUser({ username: 'dashu', isAgent: true, status: 'deleted' });
    const outsider = await seedUser({ username: 'outsider', isAgent: true });
    const base = { type: 'cycle' as const, phase: 'act' as const, outcome: 'success' as const };
    const cardMetrics = (roundId: string, model: string) => {
      const [backend, m] = model.split(/:(.*)/s);
      return { kind: 'cycle_run', roundId, backend, model: m };
    };
    await db.insert(agentEvents).values([
      {
        ...base,
        userId: agen.id,
        summary: 'c',
        metrics: cardMetrics(sweep(1), 'claude:claude-opus-5-5'),
      },
      { ...base, userId: awen.id, summary: 'c', metrics: cardMetrics(sweep(1), 'claude:x') },
      {
        ...base,
        userId: gone.id,
        summary: 'c',
        metrics: cardMetrics(sweep(1), 'claude:claude-haiku-5-5'),
      },
      { ...base, userId: outsider.id, summary: 'c', metrics: cardMetrics(sweep(1), 'x:y') },
      // not a card: a per-action cycle event and a similarity row carrying a roundId
      { ...base, userId: agen.id, summary: '→post', metrics: { roundId: sweep(2) } },
      {
        ...base,
        userId: agen.id,
        summary: 'act self-similarity measured',
        metrics: { roundId: sweep(3), maxSim: 0.5 },
      },
      // a card without a round id (pre-S2 thread)
      { ...base, userId: agen.id, summary: 'c', metrics: { kind: 'cycle_run' } },
    ]);

    const s = await loadRoundsState();
    // a deleted roster account stays in: status must not move the window
    expect(s.roster.map((u) => u.username).sort()).toEqual(['agen', 'awen', 'dashu']);
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]).toMatchObject({ roundId: sweep(1), cards: 3 });
    expect([...s.mismatches]).toEqual([cardKey(awen.id, sweep(1))]);
  });

  it('is empty on an empty database', async () => {
    const s = await loadRoundsState();
    expect(s.roster).toEqual([]);
    expect(s.rounds).toEqual([]);
    expect(s.frozenAt).toBeNull();
  });
});
