import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app';
import { db } from '../../../db/client';
import { agentEvents, follows, posts, postVectors, users } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { axis } from '../lab/lab.testSeeds';
import { ARMS, armOf, type ArmId } from '../lab/roster';
import {
  ArmsReportDTOSchema,
  ContagionSchema,
  HomophilySchema,
  MetricBlockSchema,
  ReliabilityRowSchema,
  RoundDTOSchema,
  SeriesPointSchema,
  VerdictSchema,
  type ArmsReportDTO,
  type MetricBlock,
} from '../../../contract/lab/arms';
import { envelopeData, expectContract } from '../../../test/contract';
import { eq } from 'drizzle-orm';
import { getAccountRounds } from './accountRounds';
import { clearArmsReportCache, getArmsReport } from './report';

/**
 * Review Focus 5 and the brief's Step 1: the report end to end over a real
 * database — empty, sparse, frozen, and a seeded arm effect.
 */

const ALL = ARMS.flatMap((a) => a.usernames);
const MODEL = new Map(ARMS.map((a) => [a.id, a.model]));
const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;
const manual = (d: number) => `202610${String(d).padStart(2, '0')}T090000Z-m`;
/** Per-account jitter so within-arm SD is never zero. */
const JITTER = [-0.001, 0, 0.001, 0.002];
const jitterOf = (u: string) => {
  const arm = ARMS.find((a) => a.usernames.includes(u)) as (typeof ARMS)[number];
  return JITTER[arm.usernames.indexOf(u)];
};

let ids = new Map<string, string>();

async function seedRoster(usernames: readonly string[] = ALL): Promise<void> {
  const rows = await db
    .insert(users)
    .values(
      usernames.map((u) => ({
        username: u,
        usernameDisplay: u,
        email: `${u}@example.test`,
        displayName: u,
        isAgent: true,
      })),
    )
    .returning({ id: users.id, username: users.username });
  ids = new Map(rows.map((r) => [r.username, r.id]));
}

interface RoundSpec {
  /** Accounts that file a card (default: every seeded account). */
  who?: readonly string[];
  /** Accounts that file a card but no post. */
  noPost?: readonly string[];
  cardSim?: (u: string) => number;
  maxSim?: (u: string) => number;
  outcome?: (u: string) => 'success' | 'fail';
  model?: (u: string) => string;
}

async function seedRound(roundId: string, spec: RoundSpec = {}): Promise<void> {
  const who = spec.who ?? [...ids.keys()];
  const startedAt = new Date(
    `${roundId.slice(0, 4)}-${roundId.slice(4, 6)}-${roundId.slice(6, 8)}T06:00:00Z`,
  );
  const cards = who.map((u, i) => {
    const [backend, model] = (spec.model?.(u) ?? (MODEL.get(armOf(u) as ArmId) as string)).split(
      /:(.*)/s,
    );
    return {
      userId: ids.get(u) as string,
      type: 'cycle' as const,
      phase: 'act' as const,
      outcome: spec.outcome?.(u) ?? 'success',
      summary: `cycle_run ${u}`,
      metrics: { kind: 'cycle_run', roundId, backend, model, attempted: 1, landed: 1 },
      createdAt: new Date(startedAt.getTime() + (i + 1) * 60_000),
    };
  });
  const posters = who.filter((u) => !spec.noPost?.includes(u));
  const candidates = posters.map((u) => ({
    userId: ids.get(u) as string,
    type: 'cycle' as const,
    phase: 'act' as const,
    outcome: 'success' as const,
    summary: 'act self-similarity measured',
    metrics: {
      roundId,
      maxSim: spec.maxSim?.(u) ?? 0.3,
      cardSim: spec.cardSim?.(u) ?? 0.8,
      threshold: 0.92,
      dropped: false,
    },
  }));
  if (cards.length) await db.insert(agentEvents).values([...cards, ...candidates]);
  if (posters.length) {
    await db.insert(postVectors).values(
      posters.map((u) => ({
        postId: `${roundId}-${u}`,
        userId: ids.get(u) as string,
        roundId,
        embedding: axis(ALL.indexOf(u)),
        cardSim: spec.cardSim?.(u) ?? 0.8,
        source: 'act' as const,
      })),
    );
  }
}

/** Fidelity effect: openai decays −0.02 per round; every other arm is flat. */
const decayingOpenai = (ordinal: number) => (u: string) =>
  0.8 + ((armOf(u) === 'openai' ? -0.02 : 0) + jitterOf(u)) * ordinal;
const flat = (ordinal: number) => (u: string) => 0.8 + jitterOf(u) * ordinal;

async function seedSweeps(n: number, cardSim: (ordinal: number) => (u: string) => number) {
  for (let i = 1; i <= n; i += 1) await seedRound(sweep(i), { cardSim: cardSim(i) });
}

/** Every number anywhere in the payload is finite. */
function nonFinitePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

const blocks = (r: ArmsReportDTO): MetricBlock[] => [
  r.metrics.fidelity,
  r.metrics.repetition,
  r.metrics.convergence,
];

beforeEach(async () => {
  await resetDb();
  clearArmsReportCache();
  ids = new Map();
});

describe('GET /agents/arms — empty and sparse data (Review Focus 5)', () => {
  it('empty database → 200, every statistic null, collecting, no NaN anywhere', async () => {
    const res = await request(createApp()).get('/api/v1/agents/arms');
    expect(res.status).toBe(200);
    expectContract(ArmsReportDTOSchema, envelopeData(res.body));
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/NaN|Infinity/);

    const r = await getArmsReport();
    expect(nonFinitePaths(r)).toEqual([]);
    expect(r.rounds).toEqual([]);
    expect(r.completedRounds).toBe(0);
    expect(r.targetRounds).toBe(12);
    expect(r.minArmRounds).toBe(9);
    expect(r.armRounds).toEqual({
      openai: 0,
      grok: 0,
      gemini: 0,
      'claude-opus': 0,
      'claude-haiku': 0,
    });
    expect(r.arms.map((a) => [a.id, a.model, a.accounts.length])).toEqual(
      ARMS.map((a) => [a.id, a.model, 4]),
    );
    for (const b of blocks(r)) {
      expect(b.verdict).toEqual({
        status: 'collecting',
        between: null,
        within: null,
        frozenAt: null,
      });
      expect(b.accounts).toHaveLength(20);
      expect(b.accounts.every((a) => a.value === null && a.level === null && a.n === 0)).toBe(true);
      expect(b.arms.every((a) => a.mean === null && a.sd === null && !a.qualifies)).toBe(true);
      expect(b.series.every((s) => s.points.length === 0)).toBe(true);
    }
    expect(r.metrics.convergence.population).toEqual([]);
    expect(r.exploratory.contagion).toEqual({
      status: 'collecting',
      arms: ARMS.map((a) => ({ arm: a.id, innovations: 0, adopted: 0, rate: null })),
      top: [],
    });
    expect(r.exploratory.reliability.map((x) => [x.arm, x.expected, x.cards, x.missing])).toEqual(
      ARMS.map((a) => [a.id, 0, 0, 0]),
    );
    expect(
      Object.values(r.exploratory.homophily.matrix).flatMap((row) => Object.values(row)),
    ).toEqual(Array(25).fill(0));
    expect(r.exploratory.homophily.arms).toHaveLength(5);
  });

  it('one arm entirely missing and accounts with < 3 posts → nulls, collecting, no NaN', async () => {
    const withoutGemini = ALL.filter((u) => armOf(u) !== 'gemini');
    await seedRoster(withoutGemini);
    await seedRound(sweep(1));
    await seedRound(sweep(2), { noPost: ['agen'] });

    const r = await getArmsReport();
    expect(nonFinitePaths(r)).toEqual([]);
    expect(r.completedRounds).toBe(2);
    expect(r.armRounds.gemini).toBe(0);
    for (const b of blocks(r)) {
      expect(b.verdict.status).toBe('collecting');
      expect(b.accounts.find((a) => a.username === 'agen')?.value).toBeNull();
      expect(b.arms.find((a) => a.arm === 'gemini')).toEqual({
        arm: 'gemini',
        mean: null,
        sd: null,
        accounts: 0,
        qualifies: false,
      });
    }
    const gemini = r.metrics.fidelity.series.find((s) => s.arm === 'gemini');
    expect(gemini?.points).toEqual([
      { roundId: sweep(1), ordinal: 1, value: null, n: 0 },
      { roundId: sweep(2), ordinal: 2, value: null, n: 0 },
    ]);
    expect(r.metrics.fidelity.accounts.find((a) => a.username === 'agen')).toMatchObject({
      n: 1,
      level: 0.8,
    });
  });
});

describe('GET /agents/arms — the confirmatory window', () => {
  it('12 completed rounds with an arm effect → differs, frozen at the 12th', async () => {
    await seedRoster();
    await seedSweeps(12, decayingOpenai);

    const r = await getArmsReport();
    expect(nonFinitePaths(r)).toEqual([]);
    const f = r.metrics.fidelity;
    expect(r.completedRounds).toBe(12);
    expect(f.verdict.status).toBe('differs');
    expect(f.verdict.frozenAt).toBe(sweep(12));
    expect(f.verdict.between!).toBeGreaterThan(f.verdict.within!);
    expect(f.arms.every((a) => a.qualifies)).toBe(true);
    expect(f.accounts.find((a) => a.username === 'zhenxian')?.value).toBeCloseTo(-0.021, 9);
    expect(f.accounts.find((a) => a.username === 'agen')?.value).toBeCloseTo(-0.001, 9);
    // all cosines between distinct axes are 0: convergence arms are identical
    expect(r.metrics.convergence.verdict.status).toBe('no-difference');
    // (b): no candidate ≥ 0.92 anywhere
    expect(r.metrics.repetition.verdict.status).toBe('insufficient');
  });

  it('identical arms → no-difference', async () => {
    await seedRoster();
    await seedSweeps(12, flat);
    const f = (await getArmsReport()).metrics.fidelity;
    expect(f.verdict.status).toBe('no-difference');
    expect(f.verdict.between).toBeCloseTo(0, 12);
  });

  it('before the 12th completed round the verdict is provisional (collecting)', async () => {
    await seedRoster();
    await seedSweeps(11, decayingOpenai);
    const f = (await getArmsReport()).metrics.fidelity;
    expect(f.verdict.status).toBe('collecting');
    expect(f.verdict.frozenAt).toBeNull();
    expect(f.verdict.between).not.toBeNull();
  });

  it('a 13th round outside the window does not change the verdict', async () => {
    await seedRoster();
    await seedSweeps(12, decayingOpenai);
    const before = (await getArmsReport()).metrics;

    // The 13th round would erase the effect: openai jumps up, everyone else drops.
    await seedRound(sweep(13), { cardSim: (u) => (armOf(u) === 'openai' ? 1 : 0) });
    clearArmsReportCache();
    const r = await getArmsReport();
    expect(r.rounds.at(-1)).toMatchObject({
      roundId: sweep(13),
      ordinal: null,
      inWindow: false,
      completed: true,
    });
    expect(r.completedRounds).toBe(13);
    expect(r.metrics.fidelity.verdict).toEqual(before.fidelity.verdict);
    expect(r.metrics.fidelity.accounts).toEqual(before.fidelity.accounts);
    expect(r.metrics.fidelity.series[0].points).toHaveLength(12);
  });

  it('an incomplete sweep keeps its ordinal and its data', async () => {
    await seedRoster();
    await seedRound(sweep(1), { cardSim: () => 0.9 });
    await seedRound(sweep(2), { who: ['zhenxian', 'awen', 'agen'], cardSim: () => 0.7 });
    await seedRound(sweep(3), { cardSim: () => 0.5 });

    const r = await getArmsReport();
    expect(r.rounds.map((x) => [x.ordinal, x.completed, x.cards])).toEqual([
      [1, true, 20],
      [2, false, 3],
      [3, true, 20],
    ]);
    const openai = r.metrics.fidelity.series.find((s) => s.arm === 'openai');
    expect(openai?.points[1]).toEqual({ roundId: sweep(2), ordinal: 2, value: 0.7, n: 1 });
    // zhenxian has posts in 3 distinct sweep rounds → a slope of −0.2
    expect(r.metrics.fidelity.accounts.find((a) => a.username === 'zhenxian')?.value).toBeCloseTo(
      -0.2,
      12,
    );
    // armRounds counts completed rounds only
    expect(r.armRounds.openai).toBe(2);
  });

  it('an arm with data in only 8 rounds does not qualify', async () => {
    await seedRoster();
    for (let i = 1; i <= 12; i += 1) {
      await seedRound(sweep(i), {
        cardSim: decayingOpenai(i),
        outcome: (u) => (armOf(u) === 'gemini' && i > 8 ? 'fail' : 'success'),
      });
    }
    const r = await getArmsReport();
    expect(r.armRounds.gemini).toBe(8);
    expect(r.armRounds.grok).toBe(12);
    const gemini = r.metrics.fidelity.arms.find((a) => a.arm === 'gemini');
    expect(gemini).toMatchObject({ accounts: 4, qualifies: false });
    expect(r.metrics.fidelity.verdict.status).toBe('differs');
  });

  it('manual rounds are listed but excluded from every series and statistic', async () => {
    await seedRoster();
    await seedRound(sweep(1));
    await seedRound(manual(2), { cardSim: () => 0.1, maxSim: () => 0.99 });
    await seedRound(sweep(3));

    const r = await getArmsReport();
    expect(r.rounds.map((x) => [x.roundId, x.kind, x.ordinal, x.inWindow, x.completed])).toEqual([
      [sweep(1), 'sweep', 1, true, true],
      [manual(2), 'manual', null, false, false],
      [sweep(3), 'sweep', 2, true, true],
    ]);
    for (const b of blocks(r)) {
      for (const s of b.series)
        expect(s.points.map((p) => p.roundId)).toEqual([sweep(1), sweep(3)]);
    }
    expect(r.metrics.fidelity.accounts.every((a) => a.level === 0.8)).toBe(true);
    expect(r.metrics.repetition.accounts.every((a) => a.level === 0.3)).toBe(true);
  });

  it("a model-mismatch cycle's post is excluded from (a)–(c)", async () => {
    await seedRoster();
    await seedRound(sweep(1), {
      cardSim: (u) => (u === 'agen' ? 0.1 : 0.8),
      model: (u) => (u === 'agen' ? 'grok:grok-4.6' : (MODEL.get(armOf(u) as ArmId) as string)),
    });
    const r = await getArmsReport();
    for (const b of blocks(r)) {
      expect(b.accounts.find((a) => a.username === 'agen')).toMatchObject({ n: 0, level: null });
    }
    // agen's post is not a comparator either: 19 posts → 171 pairs
    expect(r.metrics.convergence.population?.[0].n).toBe((19 * 18) / 2);
  });

  it('suspending a roster account after round 12 moves neither the window nor the verdict', async () => {
    // Two accounts per arm: exactly 10 cards a round, so one missing account
    // would make every round incomplete if status decided roster membership.
    await seedRoster();
    const who = ARMS.flatMap((a) => a.usernames.slice(0, 2));
    for (let i = 1; i <= 12; i += 1) {
      await seedRound(sweep(i), { who, cardSim: decayingOpenai(i) });
    }
    const before = await getArmsReport();
    expect(before.metrics.fidelity.verdict.frozenAt).toBe(sweep(12));

    await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'zhenxian'));
    clearArmsReportCache();
    const after = await getArmsReport();
    expect(after.rounds).toEqual(before.rounds);
    expect(after.armRounds).toEqual(before.armRounds);
    expect(after.metrics.fidelity.verdict).toEqual(before.metrics.fidelity.verdict);
    expect(after.metrics.fidelity.accounts).toEqual(before.metrics.fidelity.accounts);
  });

  it('report and /:u/rounds agree on convergence for non-unit vectors (true cosine)', async () => {
    await seedRoster(['agen', 'awen']);
    await seedRound(sweep(1));
    const vec = (pairs: Array<[number, number]>) => {
      const v = Array(1024).fill(0);
      for (const [i, x] of pairs) v[i] = x;
      return v;
    };
    await db
      .update(postVectors)
      .set({ embedding: vec([[0, 2]]) })
      .where(eq(postVectors.postId, `${sweep(1)}-agen`));
    await db
      .update(postVectors)
      .set({
        embedding: vec([
          [0, 1],
          [1, 1],
        ]),
      })
      .where(eq(postVectors.postId, `${sweep(1)}-awen`));

    const r = await getArmsReport();
    const level = r.metrics.convergence.accounts.find((a) => a.username === 'agen')?.level;
    expect(level).toBeCloseTo(Math.SQRT1_2, 9);
    const detail = await getAccountRounds('agen');
    expect(detail.rounds[0].post?.convergence).toBeCloseTo(level as number, 9);
  });

  it('caches the report for 60 s until the test hook clears it', async () => {
    const first = await getArmsReport();
    await seedRoster();
    await seedRound(sweep(1));
    expect((await getArmsReport()).rounds).toEqual(first.rounds);
    clearArmsReportCache();
    expect((await getArmsReport()).rounds).toHaveLength(1);
  });
});

describe('GET /agents/arms — exploratory instruments', () => {
  it('fills homophily, contagion and reliability from the same rounds', async () => {
    await seedRoster();
    for (let i = 1; i <= 4; i += 1) {
      await seedRound(sweep(i), { who: ALL.filter((u) => !(i === 4 && u === 'laoqian')) });
    }
    const sealed = await db
      .insert(users)
      .values({
        username: 'sealed',
        usernameDisplay: 'sealed',
        email: 'sealed@example.test',
        displayName: 'sealed',
        archivedAt: new Date('2026-09-30T00:00:00Z'),
      })
      .returning({ id: users.id });
    const at = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h));
    const uid = (u: string) => ids.get(u) as string;
    await db.insert(posts).values([
      { authorId: sealed[0].id, text: 'eraword', createdAt: at(1, 0) },
      { authorId: uid('agen'), text: 'eraword novel', createdAt: at(3, 7) },
      { authorId: uid('dashu'), text: 'novel eraword', createdAt: at(4, 7) },
      { authorId: uid('awen'), text: 'novel', createdAt: at(4, 8) },
    ]);
    await db.insert(follows).values({ followerId: uid('agen'), followingId: uid('xiaoyu') });

    // The serialised report with every block populated is the strict contract
    // shape (spec §7.8), down to each nested record.
    const res = await request(createApp()).get('/api/v1/agents/arms');
    expect(res.status).toBe(200);
    const wire = expectContract(ArmsReportDTOSchema, envelopeData(res.body));
    expect(wire.rounds).toHaveLength(4);
    for (const r of wire.rounds) expectContract(RoundDTOSchema, r);
    for (const b of blocks(wire)) {
      expectContract(MetricBlockSchema, b);
      expectContract(VerdictSchema, b.verdict);
      for (const s of b.series) for (const p of s.points) expectContract(SeriesPointSchema, p);
    }
    expect(wire.metrics.convergence.population?.length).toBeGreaterThan(0);
    expectContract(HomophilySchema, wire.exploratory.homophily);
    expectContract(ContagionSchema, wire.exploratory.contagion);
    for (const r of wire.exploratory.reliability) expectContract(ReliabilityRowSchema, r);

    const { exploratory: x } = await getArmsReport();
    const opus = x.homophily.arms.find((a) => a.arm === 'claude-opus');
    expect(opus).toMatchObject({ out: 1, crossBoardOut: 1, within: 1, share: 1 });
    expect(opus?.expected).toBeCloseTo(3 / 16, 12);
    expect(x.homophily.matrix['claude-opus']['claude-opus']).toBe(1);

    expect(x.contagion.status).toBe('ok');
    expect(x.contagion.top).toEqual([
      {
        token: 'novel',
        origin: 'agen',
        originArm: 'claude-opus',
        adopters: 2,
        adopterArms: ['claude-haiku', 'grok'],
      },
    ]);
    expect(x.contagion.arms.find((a) => a.arm === 'claude-opus')).toEqual({
      arm: 'claude-opus',
      innovations: 1,
      adopted: 1,
      rate: 1,
    });

    const grok = x.reliability.find((r) => r.arm === 'grok');
    expect(grok).toMatchObject({ expected: 16, cards: 15, missing: 1, attempted: 15, landed: 15 });
  });
});
