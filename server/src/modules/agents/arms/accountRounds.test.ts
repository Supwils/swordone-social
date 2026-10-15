import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app';
import { db } from '../../../db/client';
import { agentEvents, postVectors } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { axis, mixed06, seedUser } from '../lab/lab.testSeeds';
import { getAccountRounds } from './accountRounds';

const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;

type CardOver = {
  createdAt?: Date;
  outcome?: 'success' | 'fail' | 'warn' | 'skip';
  metrics?: Record<string, unknown>;
};

async function seedCard(userId: string, roundId: string, over: CardOver = {}) {
  await db.insert(agentEvents).values({
    userId,
    type: 'cycle',
    phase: 'act',
    outcome: over.outcome ?? 'success',
    summary: 'cycle_run',
    metrics: {
      kind: 'cycle_run',
      roundId,
      attempted: 2,
      landed: 1,
      actOutcome: 'landed_some',
      dreamAccepted: true,
      backend: 'claude',
      model: 'claude-opus-5-5',
      ...over.metrics,
    },
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  });
}

async function seedCandidate(
  userId: string,
  roundId: string,
  metrics: Record<string, unknown>,
  createdAt?: Date,
) {
  await db.insert(agentEvents).values({
    userId,
    type: 'cycle',
    phase: 'act',
    outcome: 'success',
    summary: 'act self-similarity measured',
    metrics: { roundId, threshold: 0.92, ...metrics },
    ...(createdAt ? { createdAt } : {}),
  });
}

async function seedVector(
  postId: string,
  userId: string,
  roundId: string | null,
  embedding: number[],
  cardSim: number | null = 0.7,
  createdAt?: Date,
) {
  await db.insert(postVectors).values({
    postId,
    userId,
    roundId,
    embedding,
    cardSim,
    source: 'act',
    ...(createdAt ? { createdAt } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('GET /agents/:username/rounds', () => {
  it('404s for an unknown account', async () => {
    const res = await request(createApp()).get('/api/v1/agents/nobody/rounds');
    expect(res.status).toBe(404);
  });

  it('400s for a malformed username', async () => {
    const res = await request(createApp()).get('/api/v1/agents/a!/rounds');
    expect(res.status).toBe(400);
  });

  it('a roster account: its arm, rounds newest first, card fields, candidate and post', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    const xiaoyu = await seedUser({ username: 'xiaoyu', isAgent: true });
    const awen = await seedUser({ username: 'awen', isAgent: true });
    const outsider = await seedUser({ username: 'outsider', isAgent: true });

    await seedCard(agen.id, sweep(1));
    await seedCard(agen.id, sweep(2), { outcome: 'warn', metrics: { dreamAccepted: null } });
    await seedCandidate(
      agen.id,
      sweep(1),
      { maxSim: 0.5, cardSim: 0.71, dropped: false },
      new Date('2026-10-01T06:01:00Z'),
    );
    await seedCandidate(
      agen.id,
      sweep(1),
      { maxSim: 0.97, cardSim: 0.2, dropped: true },
      new Date('2026-10-01T06:02:00Z'),
    );
    // round 1: agen axis(0); xiaoyu (same arm) mixed06 → 0.6; awen axis(1) → 0;
    // agen's own second post and the non-roster account's post are never compared.
    await seedVector('p-agen', agen.id, sweep(1), axis(0), 0.71, new Date('2026-10-01T06:01:00Z'));
    await seedVector('p-agen-2', agen.id, sweep(1), axis(0), 0.5, new Date('2026-10-01T06:03:00Z'));
    await seedVector('p-xiaoyu', xiaoyu.id, sweep(1), mixed06());
    await seedVector('p-awen', awen.id, sweep(1), axis(1));
    await seedVector('p-out', outsider.id, sweep(1), axis(0));

    const res = await request(createApp()).get('/api/v1/agents/agen/rounds');
    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body.username).toBe('agen');
    expect(body.arm).toBe('claude-opus');
    expect(body.rounds.map((r: { roundId: string }) => r.roundId)).toEqual([sweep(2), sweep(1)]);
    expect(body.rounds[0]).toEqual({
      roundId: sweep(2),
      kind: 'sweep',
      startedAt: '2026-10-02T06:00:00.000Z',
      outcome: 'warn',
      actOutcome: 'landed_some',
      attempted: 2,
      landed: 1,
      dreamAccepted: null,
      candidate: null,
      post: null,
    });
    expect(body.rounds[1].candidate).toEqual({ maxSim: 0.5, cardSim: 0.71, dropped: false });
    expect(body.rounds[1].post.postId).toBe('p-agen');
    expect(body.rounds[1].post.cardSim).toBe(0.71);
    expect(body.rounds[1].post.convergence).toBeCloseTo(0.3, 6);
  });

  it('reads candidates from act-phase similarity events only', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    await seedCard(agen.id, sweep(1));
    await db.insert(agentEvents).values({
      userId: agen.id,
      type: 'cycle',
      phase: 'dream',
      outcome: 'success',
      summary: 'act self-similarity measured',
      metrics: { roundId: sweep(1), maxSim: 0.9, cardSim: 0.1, dropped: false },
    });
    expect((await getAccountRounds('agen')).rounds[0].candidate).toBeNull();
  });

  it('a post alone in its round has convergence null', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    await seedCard(agen.id, sweep(1));
    await seedVector('p1', agen.id, sweep(1), axis(0), null);
    const out = await getAccountRounds('agen');
    expect(out.rounds[0].post).toEqual({ postId: 'p1', cardSim: null, convergence: null });
  });

  it('a non-roster account gets arm null and still lists its rounds; a duplicate card is ignored', async () => {
    const u = await seedUser({ username: 'outsider', isAgent: true });
    await seedCard(u.id, sweep(1), {
      outcome: 'fail',
      createdAt: new Date('2026-10-01T06:01:00Z'),
    });
    await seedCard(u.id, sweep(1), {
      outcome: 'success',
      createdAt: new Date('2026-10-01T06:05:00Z'),
    });
    await seedCard(u.id, 'garbage');

    const out = await getAccountRounds('outsider');
    expect(out.arm).toBeNull();
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]).toMatchObject({ roundId: sweep(1), outcome: 'fail' });
  });

  it('caps the list at the 60 newest rounds and coerces odd metrics to null', async () => {
    const u = await seedUser({ username: 'agen', isAgent: true });
    const rounds = Array.from(
      { length: 62 },
      (_, i) =>
        `20261001T${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z-m`,
    );
    await db.insert(agentEvents).values(
      rounds.map((roundId) => ({
        userId: u.id,
        type: 'cycle' as const,
        phase: 'act' as const,
        outcome: 'skip' as const,
        summary: 'cycle_run',
        metrics: { kind: 'cycle_run', roundId, attempted: 'x', landed: null, actOutcome: 3 },
      })),
    );
    const out = await getAccountRounds('agen');
    expect(out.rounds).toHaveLength(60);
    expect(out.rounds[0].roundId).toBe(rounds[61]);
    expect(out.rounds[59].roundId).toBe(rounds[2]);
    expect(out.rounds[0]).toMatchObject({
      kind: 'manual',
      attempted: null,
      landed: null,
      actOutcome: null,
      dreamAccepted: null,
    });
  });

  it('an account without cards has no rounds', async () => {
    await seedUser({ username: 'agen', isAgent: true });
    expect(await getAccountRounds('agen')).toEqual({
      username: 'agen',
      arm: 'claude-opus',
      rounds: [],
    });
  });
});
