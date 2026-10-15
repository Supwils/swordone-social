import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../db/client';
import { agentEvents, postVectors } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { axis, mixed06, seedUser } from '../lab/lab.testSeeds';
import { ARMS, type ArmId } from '../lab/roster';
import {
  convergenceBlock,
  cosine,
  fidelityBlock,
  loadWindowCandidates,
  loadWindowPosts,
  repetitionBlock,
  type CandidateRow,
  type PostRow,
} from './metrics';
import { buildRounds, type RawCard, type RosterUser, type RoundsState } from './rounds';

const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const MODEL = new Map(ARMS.map((a) => [a.id, a.model]));
const byName = (u: string) => ROSTER.find((r) => r.username === u) as RosterUser;
const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;
const manual = (d: number) => `202610${String(d).padStart(2, '0')}T090000Z-m`;

let seq = 0;
function card(user: RosterUser, roundId: string, model = MODEL.get(user.arm) as string): RawCard {
  seq += 1;
  const [backend, m] = model.split(/:(.*)/s);
  return {
    id: `c${String(seq).padStart(6, '0')}`,
    userId: user.id,
    createdAt: new Date(Date.UTC(2026, 9, 1) + seq * 1000),
    outcome: 'success',
    metrics: { kind: 'cycle_run', roundId, backend, model: m },
  };
}

/** `rounds` full sweeps (every roster account files a card), plus extra cards. */
function state(rounds: number, extra: RawCard[] = []): RoundsState {
  const cards = Array.from({ length: rounds }, (_, i) => ROSTER.map((u) => card(u, sweep(i + 1))));
  return buildRounds([...cards.flat(), ...extra], ROSTER);
}

let postSeq = 0;
function post(username: string, roundId: string, over: Partial<PostRow> = {}): PostRow {
  postSeq += 1;
  return {
    postId: `p${postSeq}`,
    userId: byName(username).id,
    roundId,
    cardSim: 0.5,
    embedding: axis(0),
    ...over,
  };
}

function cand(username: string, roundId: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    userId: byName(username).id,
    roundId,
    maxSim: 0.5,
    cardSim: 0.5,
    threshold: 0.92,
    dropped: false,
    ...over,
  };
}

const account = (block: { accounts: { username: string }[] }, u: string) =>
  block.accounts.find((a) => a.username === u);
const armRow = <T extends { arm: ArmId }>(rows: T[], arm: ArmId) =>
  rows.find((r) => r.arm === arm) as T;

describe('cosine', () => {
  it('normalises by both norms, so a non-unit vector gives the true cosine', () => {
    expect(cosine([2, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
    expect(cosine([3, 4], [3, 4])).toBeCloseTo(1, 12);
    expect(cosine(axis(0), mixed06())).toBeCloseTo(0.6, 12);
  });

  it('is null for a zero vector, an empty vector or a length mismatch', () => {
    expect(cosine([0, 0], [1, 0])).toBeNull();
    expect(cosine([], [])).toBeNull();
    expect(cosine([1, 0], [1, 0, 0])).toBeNull();
  });
});

describe('fidelityBlock (a)', () => {
  it('lists every roster account and arm with nulls when there is no data', () => {
    const b = fidelityBlock(state(0), [], []);
    expect(b.key).toBe('fidelity');
    expect(b.accounts).toHaveLength(20);
    expect(b.accounts.every((a) => a.value === null && a.n === 0 && a.level === null)).toBe(true);
    expect(b.arms).toHaveLength(5);
    expect(b.series.map((s) => s.points)).toEqual([[], [], [], [], []]);
    expect(b.verdict).toEqual({
      status: 'collecting',
      between: null,
      within: null,
      frozenAt: null,
    });
    expect(b.population).toBeUndefined();
    expect(b.companions.map((c) => c.label)).toEqual(['level', 'candidates']);
  });

  it('needs posts in ≥ 3 distinct sweep rounds for a slope', () => {
    const s = state(3);
    const two = fidelityBlock(
      s,
      [post('agen', sweep(1), { cardSim: 0.9 }), post('agen', sweep(2), { cardSim: 0.7 })],
      [],
    );
    expect(account(two, 'agen')).toMatchObject({ value: null, n: 2, level: 0.8 });

    const three = fidelityBlock(
      s,
      [
        post('agen', sweep(1), { cardSim: 0.9 }),
        post('agen', sweep(2), { cardSim: 0.8 }),
        post('agen', sweep(3), { cardSim: 0.7 }),
      ],
      [],
    );
    expect(account(three, 'agen')?.value).toBeCloseTo(-0.1, 12);
    expect(account(three, 'agen')?.n).toBe(3);
  });

  it('excludes manual rounds, post-window rounds, null rounds and model-mismatch cycles', () => {
    const extra = [...ROSTER.map((u) => card(u, manual(20))), card(byName('xiaoyu'), sweep(14))];
    // 12 completed sweeps; agen's sweep-2 cycle ran the wrong model
    const s = buildRounds(
      [
        ...Array.from({ length: 13 }, (_, i) =>
          ROSTER.map((u) =>
            u.username === 'agen' && i === 1
              ? card(u, sweep(2), 'grok:grok-4.6')
              : card(u, sweep(i + 1)),
          ),
        ).flat(),
        ...extra,
      ],
      ROSTER,
    );
    expect(s.frozenAt).toBe(sweep(12));
    const b = fidelityBlock(
      s,
      [
        post('agen', sweep(1), { cardSim: 0.9 }),
        post('agen', sweep(2), { cardSim: 0.1 }), // mismatch → out
        post('agen', sweep(3), { cardSim: 0.7 }),
        post('agen', sweep(4), { cardSim: 0.6 }),
        post('agen', manual(20), { cardSim: 0.0 }), // manual → out
        post('agen', sweep(13), { cardSim: 0.0 }), // after the window → out
      ],
      [],
    );
    const agen = account(b, 'agen');
    expect(agen?.n).toBe(3);
    expect(agen?.level).toBeCloseTo((0.9 + 0.7 + 0.6) / 3, 12);
    const opus = b.series.find((x) => x.arm === 'claude-opus');
    expect(opus?.points.map((p) => p.roundId)).toEqual(
      Array.from({ length: 12 }, (_, i) => sweep(i + 1)),
    );
    expect(opus?.points[1]).toEqual({ roundId: sweep(2), ordinal: 2, value: null, n: 0 });
    expect(opus?.points[0]).toEqual({ roundId: sweep(1), ordinal: 1, value: 0.9, n: 1 });
  });

  it('ignores rows with a null or non-finite card_sim and rows of unknown accounts', () => {
    const s = state(3);
    const b = fidelityBlock(
      s,
      [
        post('agen', sweep(1), { cardSim: null }),
        post('agen', sweep(2), { cardSim: Number.NaN }),
        { ...post('agen', sweep(3)), userId: 'id-stranger' },
      ],
      [],
    );
    expect(account(b, 'agen')).toMatchObject({ value: null, n: 0, level: null });
  });

  it('companions: level = arm mean of account levels; candidates = arm mean of candidate slopes', () => {
    const s = state(3);
    const posts = [
      post('agen', sweep(1), { cardSim: 0.8 }),
      post('xiaoyu', sweep(1), { cardSim: 0.6 }),
    ];
    const candidates = [
      // dropped candidates count for the companion
      cand('agen', sweep(1), { cardSim: 0.9, dropped: true }),
      cand('agen', sweep(2), { cardSim: 0.8 }),
      cand('agen', sweep(3), { cardSim: 0.7, threshold: 0.8 }),
      cand('xiaoyu', sweep(1), { cardSim: 0.5 }),
      cand('xiaoyu', sweep(2), { cardSim: 0.7 }),
      cand('xiaoyu', sweep(3), { cardSim: 0.9 }),
      cand('maike', sweep(1), { cardSim: null }),
    ];
    const b = fidelityBlock(s, posts, candidates);
    const level = b.companions.find((c) => c.label === 'level');
    const slope = b.companions.find((c) => c.label === 'candidates');
    expect(armRow(level!.arms, 'claude-opus').value).toBeCloseTo(0.7, 12);
    expect(armRow(level!.arms, 'grok').value).toBeNull();
    // agen −0.1, xiaoyu +0.2 → 0.05
    expect(armRow(slope!.arms, 'claude-opus').value).toBeCloseTo(0.05, 12);
    expect(armRow(slope!.arms, 'openai').value).toBeNull();
  });
});

describe('repetitionBlock (b)', () => {
  it('uses only rows measured at threshold 0.92 with a maxSim', () => {
    const s = state(2);
    const b = repetitionBlock(s, [
      cand('agen', sweep(1), { maxSim: 0.95 }),
      cand('agen', sweep(1), { maxSim: 0.3 }),
      cand('agen', sweep(2), { maxSim: 0.95, threshold: 0.9 }), // another threshold → out
      cand('agen', sweep(2), { maxSim: 0.95, threshold: null }),
      cand('agen', sweep(2), { maxSim: null }), // not measured
      cand('agen', sweep(2), { maxSim: 0.1 }),
    ]);
    const agen = account(b, 'agen');
    expect(agen?.n).toBe(3);
    expect(agen?.value).toBeNull(); // < 4 candidates
    expect(agen?.level).toBeCloseTo((0.95 + 0.3 + 0.1) / 3, 12);
  });

  it('account share needs ≥ 4 measured candidates; 0.92 itself counts as high', () => {
    const s = state(2);
    const b = repetitionBlock(s, [
      cand('agen', sweep(1), { maxSim: 0.92 }),
      cand('agen', sweep(1), { maxSim: 0.5 }),
      cand('agen', sweep(2), { maxSim: 0.919 }),
      cand('agen', sweep(2), { maxSim: 0.99 }),
    ]);
    expect(account(b, 'agen')?.value).toBe(0.5);
    const series = b.series.find((x) => x.arm === 'claude-opus');
    expect(series?.points).toEqual([
      { roundId: sweep(1), ordinal: 1, value: 0.5, n: 2 },
      { roundId: sweep(2), ordinal: 2, value: 0.5, n: 2 },
    ]);
    expect(b.companions.map((c) => c.label)).toEqual(['meanMaxSim']);
  });

  it('is collecting, not insufficient, with < 5 high candidates before the freeze', () => {
    const s = state(11);
    const rows = ARMS.flatMap((a) =>
      a.usernames.flatMap((u) => [1, 2, 3, 4].map((r) => cand(u, sweep(r), { maxSim: 0.2 }))),
    );
    const b = repetitionBlock(s, rows);
    expect(b.verdict.frozenAt).toBeNull();
    expect(b.verdict.status).toBe('collecting');
  });

  it('is insufficient with fewer than 5 high candidates in the window, whatever the spread', () => {
    // 12 frozen rounds, every arm qualifies, arms differ — but only 4 rows ≥ 0.92.
    const s = state(12);
    const rows: CandidateRow[] = [];
    let high = 0;
    for (const a of ARMS) {
      for (const u of a.usernames) {
        for (let r = 1; r <= 4; r += 1) {
          const isHigh = a.id === 'openai' && high < 4 && r === 1;
          if (isHigh) high += 1;
          rows.push(cand(u, sweep(r), { maxSim: isHigh ? 0.95 : 0.2 + (u.length % 3) * 0.01 }));
        }
      }
    }
    const b = repetitionBlock(s, rows);
    expect(armRow(b.arms, 'openai').qualifies).toBe(true);
    expect(b.verdict.status).toBe('insufficient');
    expect(b.verdict.frozenAt).toBe(sweep(12));

    // a fifth high candidate lifts the gate
    const lifted = repetitionBlock(s, [...rows, cand('awen', sweep(5), { maxSim: 0.93 })]);
    expect(lifted.verdict.status).not.toBe('insufficient');
  });
});

describe('repetitionBlock (b) after the freeze', () => {
  /** 4 candidates per account in rounds 1–4, `k[i]` of them at 0.95 for the i-th account of each arm. */
  function rows(highs: (arm: ArmId) => number[]): CandidateRow[] {
    return ARMS.flatMap((a) =>
      a.usernames.flatMap((u, i) =>
        [1, 2, 3, 4].map((r) => cand(u, sweep(r), { maxSim: r <= highs(a.id)[i] ? 0.95 : 0.2 })),
      ),
    );
  }

  it('differs: one arm repeats itself more, between > within with the hand-computed values', () => {
    // openai shares .5 .5 .75 .5 (mean .5625); every other arm 0 0 .25 0 (mean .0625).
    // within = SD of either pattern = .125; between = SD(.5625, .0625 ×4) = √.05.
    const b = repetitionBlock(
      state(12),
      rows((arm) => (arm === 'openai' ? [2, 2, 3, 2] : [0, 0, 1, 0])),
    );
    expect(b.verdict.status).toBe('differs');
    expect(b.verdict.frozenAt).toBe(sweep(12));
    expect(b.verdict.within).toBeCloseTo(0.125, 12);
    expect(b.verdict.between).toBeCloseTo(Math.sqrt(0.05), 12);
    expect(armRow(b.arms, 'openai')).toMatchObject({ mean: 0.5625, accounts: 4, qualifies: true });
  });

  it('no-difference: every arm has the same share pattern', () => {
    // shares 0 .25 .5 .25 in every arm: between = 0, within = √(.125 / 3).
    const b = repetitionBlock(
      state(12),
      rows(() => [0, 1, 2, 1]),
    );
    expect(b.verdict.status).toBe('no-difference');
    expect(b.verdict.between).toBeCloseTo(0, 12);
    expect(b.verdict.within).toBeCloseTo(Math.sqrt(0.125 / 3), 12);
  });
});

describe('convergenceBlock (c)', () => {
  it('compares a post with every other roster account in its round, same arm included, self excluded', () => {
    const s = state(1);
    // agen and xiaoyu share an arm (claude-opus); awen is grok.
    const b = convergenceBlock(s, [
      post('agen', sweep(1), { embedding: axis(0) }),
      post('agen', sweep(1), { embedding: axis(0) }), // agen's own second post: never compared to agen
      post('xiaoyu', sweep(1), { embedding: mixed06() }), // cos 0.6 with axis(0)
      post('awen', sweep(1), { embedding: axis(1) }), // cos 0 with axis(0), 0.8 with mixed06
      { ...post('agen', sweep(1), { embedding: axis(0) }), userId: 'id-stranger' }, // not roster
    ]);
    const agen = account(b, 'agen');
    // each agen post: mean(0.6, 0) = 0.3
    expect(agen?.n).toBe(2);
    expect(agen?.level).toBeCloseTo(0.3, 12);
    // xiaoyu: vs agen ×2 (0.6, 0.6) and awen (0.8) → 2/3
    expect(account(b, 'xiaoyu')?.level).toBeCloseTo((0.6 + 0.6 + 0.8) / 3, 12);
    // population: cross-account pairs only — agen×xiaoyu ×2 (0.6), agen×awen ×2 (0), xiaoyu×awen (0.8)
    expect(b.population).toEqual([
      { roundId: sweep(1), ordinal: 1, value: expect.closeTo((0.6 * 2 + 0.8) / 5, 12), n: 5 },
    ]);
    expect(b.companions.map((c) => c.label)).toEqual(['level']);
  });

  it('a post alone in its round has no convergence', () => {
    const s = state(2);
    const b = convergenceBlock(s, [post('agen', sweep(1)), post('agen', sweep(1))]);
    expect(account(b, 'agen')).toMatchObject({ n: 0, level: null, value: null });
    expect(b.population).toEqual([
      { roundId: sweep(1), ordinal: 1, value: null, n: 0 },
      { roundId: sweep(2), ordinal: 2, value: null, n: 0 },
    ]);
  });

  it('drops a model-mismatch post as subject and as comparator', () => {
    const s = buildRounds(
      ROSTER.map((u) =>
        u.username === 'awen' ? card(u, sweep(1), 'claude:x') : card(u, sweep(1)),
      ),
      ROSTER,
    );
    const b = convergenceBlock(s, [
      post('agen', sweep(1), { embedding: axis(0) }),
      post('xiaoyu', sweep(1), { embedding: mixed06() }),
      post('awen', sweep(1), { embedding: axis(1) }),
    ]);
    expect(account(b, 'agen')?.level).toBeCloseTo(0.6, 12);
    expect(account(b, 'awen')?.n).toBe(0);
  });

  it('slope over sweep ordinal needs ≥ 3 distinct rounds', () => {
    const s = state(3);
    const rows = [1, 2, 3].flatMap((r) => [
      post('agen', sweep(r), { embedding: axis(0) }),
      post('xiaoyu', sweep(r), { embedding: r === 1 ? axis(1) : r === 2 ? mixed06() : axis(0) }),
    ]);
    const b = convergenceBlock(s, rows);
    // agen conv per round: 0, 0.6, 1 → slope 0.5
    expect(account(b, 'agen')?.value).toBeCloseTo(0.5, 12);
    const two = convergenceBlock(s, rows.slice(0, 4));
    expect(account(two, 'agen')?.value).toBeNull();
  });
});

describe('usable rows need a verified cycle_run card (M1)', () => {
  // Every roster account files sweeps 1–3 except agen, who has no sweep-2 card:
  // its model for that round was never verified, so its rows there are not data.
  const noAgenCardInSweep2 = () =>
    buildRounds(
      [1, 2, 3].flatMap((r) =>
        ROSTER.filter((u) => !(u.username === 'agen' && r === 2)).map((u) => card(u, sweep(r))),
      ),
      ROSTER,
    );

  it('(a) drops a post vector and a candidate of an (account, round) without a card', () => {
    const s = noAgenCardInSweep2();
    expect(s.window.map((w) => w.roundId)).toContain(sweep(2));
    const b = fidelityBlock(
      s,
      [
        post('agen', sweep(1), { cardSim: 0.9 }),
        post('agen', sweep(2), { cardSim: 0.1 }), // no card → out
        post('agen', sweep(3), { cardSim: 0.7 }),
      ],
      [cand('agen', sweep(2), { cardSim: 0.1 })],
    );
    expect(account(b, 'agen')).toMatchObject({ n: 2 });
    expect(account(b, 'agen')?.level).toBeCloseTo(0.8, 12);
    const slope = b.companions.find((c) => c.label === 'candidates');
    expect(armRow(slope!.arms, 'claude-opus').value).toBeNull();
  });

  it('(b) drops a similarity row of an (account, round) without a card', () => {
    const s = noAgenCardInSweep2();
    const b = repetitionBlock(s, [
      cand('agen', sweep(1)),
      cand('agen', sweep(2), { maxSim: 0.99 }),
      cand('agen', sweep(3)),
    ]);
    expect(account(b, 'agen')?.n).toBe(2);
  });

  it('(c) drops a post without a card as subject and as comparator', () => {
    const s = noAgenCardInSweep2();
    const b = convergenceBlock(s, [
      post('agen', sweep(2), { embedding: axis(1) }),
      post('xiaoyu', sweep(2), { embedding: axis(0) }),
      post('awen', sweep(2), { embedding: mixed06() }),
    ]);
    expect(account(b, 'agen')?.n).toBe(0);
    expect(account(b, 'xiaoyu')?.level).toBeCloseTo(0.6, 12);
  });
});

describe('window loaders (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('load roster rows of window rounds only, vectors as arrays', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    const other = await seedUser({ username: 'outsider', isAgent: true });
    const roster: RosterUser[] = [{ id: agen.id, username: 'agen', arm: 'claude-opus' }];
    const s = buildRounds(
      [
        {
          id: 'c1',
          userId: agen.id,
          createdAt: new Date(),
          outcome: 'success',
          metrics: {
            kind: 'cycle_run',
            roundId: sweep(1),
            backend: 'claude',
            model: 'claude-opus-5-5',
          },
        },
      ],
      roster,
    );
    await db.insert(postVectors).values([
      {
        postId: 'p1',
        userId: agen.id,
        roundId: sweep(1),
        embedding: axis(3),
        cardSim: 0.7,
        source: 'act',
      },
      { postId: 'p2', userId: agen.id, roundId: manual(1), embedding: axis(0), source: 'act' },
      { postId: 'p3', userId: agen.id, roundId: null, embedding: axis(0), source: 'backfill' },
      { postId: 'p4', userId: other.id, roundId: sweep(1), embedding: axis(0), source: 'act' },
    ]);
    const ev = { type: 'cycle' as const, phase: 'act' as const, outcome: 'success' as const };
    await db.insert(agentEvents).values([
      {
        ...ev,
        userId: agen.id,
        summary: 'act self-similarity measured',
        metrics: { roundId: sweep(1), maxSim: 0.95, cardSim: 0.6, threshold: 0.92, dropped: true },
        createdAt: new Date('2026-10-14T06:01:00Z'),
      },
      // A second row for the same (account, round): only the first counts (M2).
      {
        ...ev,
        outcome: 'skip',
        userId: agen.id,
        summary: 'act self-similarity not computed',
        metrics: { roundId: sweep(1), maxSim: null, cardSim: 0.4, threshold: 0.92, dropped: false },
        createdAt: new Date('2026-10-14T06:02:00Z'),
      },
      // wrong summary, wrong round, wrong user
      { ...ev, userId: agen.id, summary: '→post', metrics: { roundId: sweep(1), maxSim: 0.1 } },
      {
        ...ev,
        userId: agen.id,
        summary: 'act self-similarity measured',
        metrics: { roundId: manual(1), maxSim: 0.1, threshold: 0.92 },
      },
      {
        ...ev,
        userId: other.id,
        summary: 'act self-similarity measured',
        metrics: { roundId: sweep(1), maxSim: 0.1, threshold: 0.92 },
      },
    ]);

    const posts = await loadWindowPosts(s);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ postId: 'p1', roundId: sweep(1), cardSim: 0.7 });
    expect(posts[0].embedding).toHaveLength(1024);
    expect(posts[0].embedding[3]).toBe(1);

    const cands = await loadWindowCandidates(s);
    expect(cands).toEqual([
      {
        userId: agen.id,
        roundId: sweep(1),
        maxSim: 0.95,
        cardSim: 0.6,
        threshold: 0.92,
        dropped: true,
      },
    ]);
  });

  it('take the first similarity row per (account, round) by created_at, then id (M2)', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    const xiaoyu = await seedUser({ username: 'xiaoyu', isAgent: true });
    const roster: RosterUser[] = [
      { id: agen.id, username: 'agen', arm: 'claude-opus' },
      { id: xiaoyu.id, username: 'xiaoyu', arm: 'claude-opus' },
    ];
    const cardOf = (userId: string, id: string, roundId: string): RawCard => ({
      id,
      userId,
      createdAt: new Date('2026-10-14T07:00:00Z'),
      outcome: 'success',
      metrics: { kind: 'cycle_run', roundId, backend: 'claude', model: 'claude-opus-5-5' },
    });
    const s = buildRounds(
      [
        cardOf(agen.id, 'c1', sweep(1)),
        cardOf(xiaoyu.id, 'c2', sweep(1)),
        cardOf(agen.id, 'c3', sweep(2)),
      ],
      roster,
    );
    const at = new Date('2026-10-14T06:05:00Z');
    const row = (userId: string, id: string, roundId: string, maxSim: number, createdAt = at) => ({
      id,
      userId,
      type: 'cycle' as const,
      phase: 'act' as const,
      outcome: 'success' as const,
      summary: 'act self-similarity measured',
      metrics: { roundId, maxSim, cardSim: 0.5, threshold: 0.92, dropped: false },
      createdAt,
    });
    await db.insert(agentEvents).values([
      // Inserted out of order: the later row first, then a same-instant tie broken by id.
      row(agen.id, 'e3', sweep(1), 0.3, new Date('2026-10-14T06:09:00Z')),
      row(agen.id, 'e2', sweep(1), 0.2),
      row(agen.id, 'e1', sweep(1), 0.1),
      row(agen.id, 'e4', sweep(2), 0.4),
      row(xiaoyu.id, 'e5', sweep(1), 0.5),
    ]);

    const cands = await loadWindowCandidates(s);

    expect(
      cands
        .map((c) => [c.userId === agen.id ? 'agen' : 'xiaoyu', c.roundId, c.maxSim])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['agen', sweep(1), 0.1],
      ['agen', sweep(2), 0.4],
      ['xiaoyu', sweep(1), 0.5],
    ]);
  });

  it('return nothing without window rounds', async () => {
    const s = buildRounds([], []);
    expect(await loadWindowPosts(s)).toEqual([]);
    expect(await loadWindowCandidates(s)).toEqual([]);
  });
});
