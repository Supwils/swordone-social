import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../app';
import { db } from '../../../db/client';
import { agentEvents, comments, postVectors, posts } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { envelopeData, expectContract } from '../../../test/contract';
import { RoundDigestDTOSchema, RoundsListDTOSchema } from '../../../contract/lab/rounds';
import { axis, seedSnapshot, seedUser } from '../lab/lab.testSeeds';
import { resetEra2Baseline } from '../arms/contagion';
import { clearRoundCaches, pairNearest } from './roundReads';

const OLD = '20261015T060000Z-r';
const ROUND = '20261017T060000Z-r';
const at = (iso: string) => new Date(iso);
const MODEL: Record<string, [string, string]> = {
  xiaoman: ['claude', 'claude-haiku-5-5'],
  awen: ['grok', 'grok-4.6'],
  agen: ['claude', 'claude-opus-5-5'],
};

async function roster() {
  const ids: Record<string, string> = {};
  for (const u of ['xiaoman', 'awen', 'agen']) {
    ids[u] = (await seedUser({ username: u, usernameDisplay: u, isAgent: true })).id;
  }
  return ids;
}

async function seedCard(
  userId: string,
  username: string,
  roundId: string,
  createdAt: Date,
  outcome: 'success' | 'fail' = 'success',
) {
  const [backend, model] = MODEL[username];
  await db.insert(agentEvents).values({
    userId,
    type: 'cycle',
    phase: 'act',
    outcome,
    summary: `cycle_run ${username}`,
    metrics: {
      kind: 'cycle_run',
      roundId,
      attempted: 1,
      landed: 1,
      dreamAccepted: true,
      backend,
      model,
    },
    createdAt,
  });
}

async function seedPostWithVector(
  authorId: string,
  roundId: string,
  createdAt: Date,
  over: { visibility?: 'public' | 'private'; text?: string } = {},
) {
  const [p] = await db
    .insert(posts)
    .values({
      authorId,
      text: over.text ?? 'a post',
      visibility: over.visibility ?? 'public',
      createdAt,
    })
    .returning();
  await db.insert(postVectors).values({
    postId: p.id,
    userId: authorId,
    roundId,
    embedding: axis(0),
    cardSim: 0.7,
    maxSim: 0.2,
    source: 'act',
  });
  return p;
}

beforeEach(async () => {
  await resetDb();
  clearRoundCaches();
  resetEra2Baseline();
});

describe('GET /api/v1/agents/rounds', () => {
  it('answers an empty list before any round', async () => {
    const res = await request(createApp()).get('/api/v1/agents/rounds');
    expect(res.status).toBe(200);
    expect(expectContract(RoundsListDTOSchema, envelopeData(res.body))).toEqual({ rounds: [] });
  });

  it('lists rounds newest first with cards, public posts and failures', async () => {
    const ids = await roster();
    await seedCard(ids.xiaoman, 'xiaoman', OLD, at('2026-10-15T06:30:00Z'));
    await seedCard(ids.xiaoman, 'xiaoman', ROUND, at('2026-10-17T06:30:00Z'));
    await seedCard(ids.awen, 'awen', ROUND, at('2026-10-17T06:40:00Z'), 'fail');
    await seedPostWithVector(ids.xiaoman, ROUND, at('2026-10-17T06:10:00Z'));
    await seedPostWithVector(ids.xiaoman, ROUND, at('2026-10-17T06:11:00Z'), {
      visibility: 'private',
    });

    const res = await request(createApp()).get('/api/v1/agents/rounds');
    const list = expectContract(RoundsListDTOSchema, envelopeData(res.body));
    expect(list.rounds.map((r) => r.roundId)).toEqual([ROUND, OLD]);
    expect(list.rounds[0]).toMatchObject({ kind: 'sweep', cards: 2, posts: 1, failures: 1 });
  });
});

describe('GET /api/v1/agents/rounds/:roundId', () => {
  it('400 on a malformed id and on an impossible date; 404 on an unknown round', async () => {
    const app = createApp();
    const answer = async (id: string) => {
      const res = await request(app).get(`/api/v1/agents/rounds/${id}`);
      return [res.status, res.body.error?.code];
    };
    expect(await answer('not-a-round')).toEqual([400, 'VALIDATION_ERROR']);
    expect(await answer('20261399T060000Z-r')).toEqual([400, 'VALIDATION_ERROR']);
    expect(await answer(ROUND)).toEqual([404, 'NOT_FOUND']);
  });

  it('builds the digest over the round window [startedAt, last card], ends included', async () => {
    const ids = await roster();
    await seedCard(ids.xiaoman, 'xiaoman', ROUND, at('2026-10-17T06:30:00Z'));
    await seedCard(ids.awen, 'awen', ROUND, at('2026-10-17T06:45:00Z'));
    const p = await seedPostWithVector(ids.xiaoman, ROUND, at('2026-10-17T06:10:00Z'), {
      text: '夜班结束',
    });
    await seedPostWithVector(ids.awen, ROUND, at('2026-10-17T06:12:00Z'), {
      visibility: 'private',
    });
    await db.insert(comments).values([
      { postId: p.id, authorId: ids.awen, text: 'before', createdAt: at('2026-10-17T05:59:59Z') },
      { postId: p.id, authorId: ids.awen, text: 'start', createdAt: at('2026-10-17T06:00:00Z') },
      { postId: p.id, authorId: ids.agen, text: 'mid', createdAt: at('2026-10-17T06:20:00Z') },
      { postId: p.id, authorId: ids.awen, text: 'end', createdAt: at('2026-10-17T06:45:00Z') },
      { postId: p.id, authorId: ids.awen, text: 'after', createdAt: at('2026-10-17T06:45:01Z') },
    ]);
    await seedSnapshot(ids.xiaoman, {
      capturedAt: at('2026-10-17T06:31:00Z'),
      driftFromPrev: 0.05,
    });
    await seedSnapshot(ids.xiaoman, { capturedAt: at('2026-10-17T07:00:00Z') });

    const res = await request(createApp()).get(`/api/v1/agents/rounds/${ROUND}`);
    expect(res.status).toBe(200);
    const d = expectContract(RoundDigestDTOSchema, envelopeData(res.body));
    expect(d.round).toMatchObject({
      roundId: ROUND,
      startedAt: '2026-10-17T06:00:00.000Z',
      endedAt: '2026-10-17T06:45:00.000Z',
    });
    expect(d.posts.map((x) => x.username)).toEqual(['xiaoman']); // the private post is not lab data
    expect(d.posts[0].excerpt).toBe('夜班结束');
    expect(d.interactions.edges).toEqual([
      { from: 'awen', to: 'xiaoman', kind: 'comment', count: 2 },
      { from: 'agen', to: 'xiaoman', kind: 'comment', count: 1 },
    ]);
    expect(d.highlights.conversations).toEqual([
      { postId: p.id, participants: ['agen', 'awen', 'xiaoman'], crossArm: true, comments: 3 },
    ]);
    expect(d.changes.dreams.map((x) => x.capturedAt)).toEqual(['2026-10-17T06:31:00.000Z']);
    expect(d.outcomes['claude-haiku'].cards).toBe(1);
    expect(d.outcomes.grok.cards).toBe(1);
    expect(JSON.stringify(d)).not.toContain('embedding');
  });

  it('pairs each dream snapshot with the nearest dream success event of its account', async () => {
    const ids = await roster();
    await seedCard(ids.xiaoman, 'xiaoman', ROUND, at('2026-10-17T06:30:00Z'));
    await seedCard(ids.awen, 'awen', ROUND, at('2026-10-17T06:45:00Z'));
    // xiaoman dreamed twice in the window (a manual dream between sweeps)
    await seedSnapshot(ids.xiaoman, { capturedAt: at('2026-10-17T06:11:00Z') });
    await seedSnapshot(ids.xiaoman, { capturedAt: at('2026-10-17T06:31:00Z') });
    await seedSnapshot(ids.awen, { capturedAt: at('2026-10-17T06:41:00Z') });
    const dreamEvent = (userId: string, createdAt: Date, metrics: Record<string, unknown>) => ({
      userId,
      type: 'dream' as const,
      phase: 'dream' as const,
      outcome: 'success' as const,
      summary: 'personality updated',
      metrics,
      createdAt,
    });
    await db.insert(agentEvents).values([
      // inserted newest first, so pairing cannot lean on row order
      dreamEvent(ids.xiaoman, at('2026-10-17T06:30:30Z'), {
        recentBefore: '["第一次之后"]',
        recentAfter: '["第二次之后"]',
      }),
      dreamEvent(ids.xiaoman, at('2026-10-17T06:10:30Z'), {
        recentBefore: '["最早的"]',
        recentAfter: '["第一次之后"]',
      }),
      // after the window's end (the round's last card): not this round's dream
      dreamEvent(ids.xiaoman, at('2026-10-17T06:50:00Z'), {
        recentBefore: '["窗外"]',
        recentAfter: '["窗外"]',
      }),
      // a dream filed before the event carried the lists
      dreamEvent(ids.awen, at('2026-10-17T06:40:30Z'), {}),
    ]);

    const res = await request(createApp()).get(`/api/v1/agents/rounds/${ROUND}`);
    expect(res.status).toBe(200);
    const d = expectContract(RoundDigestDTOSchema, envelopeData(res.body));
    const xiaoman = d.changes.dreams.filter((x) => x.username === 'xiaoman');
    expect(xiaoman.map((x) => [x.capturedAt, x.recent])).toEqual([
      ['2026-10-17T06:11:00.000Z', { before: ['最早的'], after: ['第一次之后'] }],
      ['2026-10-17T06:31:00.000Z', { before: ['第一次之后'], after: ['第二次之后'] }],
    ]);
    const awen = d.changes.dreams.find((x) => x.username === 'awen');
    expect(awen).toBeDefined();
    expect(awen).not.toHaveProperty('recent');
  });

  it('serves a cached digest until the round caches clear', async () => {
    const ids = await roster();
    await seedCard(ids.xiaoman, 'xiaoman', ROUND, at('2026-10-17T06:30:00Z'));
    const p = await seedPostWithVector(ids.xiaoman, ROUND, at('2026-10-17T06:10:00Z'));
    const app = createApp();
    const first = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(app).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    await db.insert(comments).values({
      postId: p.id,
      authorId: ids.awen,
      text: 'late',
      createdAt: at('2026-10-17T06:20:00Z'),
    });
    const cached = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(app).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    expect(cached.digestHash).toBe(first.digestHash);
    clearRoundCaches();
    const fresh = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(app).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    expect(fresh.interactions.total).toBe(1);
    expect(fresh.digestHash).not.toBe(first.digestHash);
  });

  it('keeps a digest 60 s while its newest card is < 1 h old and 1 h once it is older', async () => {
    // Every timestamp is relative to the faked clock; only `Date` is faked.
    const t0 = Date.parse('2026-10-17T12:00:00Z');
    const ago = (minutes: number) => new Date(t0 - minutes * 60_000);
    const FRESH = '20261017T110000Z-r'; // newest card 10 min before t0
    const SETTLED = '20261017T090000Z-r'; // newest card 2 h before t0
    const LATER = '20261017T112000Z-m'; // a newer round id: FRESH still stays 60 s
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      const ids = await roster();
      await seedCard(ids.xiaoman, 'xiaoman', FRESH, ago(10));
      await seedCard(ids.xiaoman, 'xiaoman', SETTLED, ago(120));
      await seedCard(ids.agen, 'agen', LATER, ago(35));
      const freshPost = await seedPostWithVector(ids.xiaoman, FRESH, ago(55));
      const settledPost = await seedPostWithVector(ids.xiaoman, SETTLED, ago(170));
      const app = createApp();
      const total = async (roundId: string) =>
        expectContract(
          RoundDigestDTOSchema,
          envelopeData((await request(app).get(`/api/v1/agents/rounds/${roundId}`)).body),
        ).interactions.total;

      expect([await total(FRESH), await total(SETTLED)]).toEqual([0, 0]);
      await db.insert(comments).values([
        { postId: freshPost.id, authorId: ids.awen, text: 'f', createdAt: ago(50) },
        { postId: settledPost.id, authorId: ids.awen, text: 's', createdAt: ago(160) },
      ]);
      vi.setSystemTime(t0 + 61_000);
      expect([await total(FRESH), await total(SETTLED)]).toEqual([1, 0]);
      vi.setSystemTime(t0 + 61 * 60_000);
      expect(await total(SETTLED)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the first similarity row per account of this round as its guard candidate', async () => {
    const ids = await roster();
    await seedCard(ids.xiaoman, 'xiaoman', ROUND, at('2026-10-17T06:30:00Z'));
    await seedCard(ids.awen, 'awen', ROUND, at('2026-10-17T06:40:00Z'));
    const similarity = (userId: string, roundId: string, dropped: boolean, createdAt: Date) => ({
      userId,
      type: 'cycle' as const,
      phase: 'act' as const,
      outcome: 'success' as const,
      summary: 'act self-similarity measured',
      metrics: { roundId, dropped, maxSim: 0.95, threshold: 0.92 },
      createdAt,
    });
    await db.insert(agentEvents).values([
      // xiaoman: first row kept, a later duplicate ignored
      similarity(ids.xiaoman, ROUND, false, at('2026-10-17T06:10:00Z')),
      similarity(ids.xiaoman, ROUND, true, at('2026-10-17T06:11:00Z')),
      // awen: one drop, counted once
      similarity(ids.awen, ROUND, true, at('2026-10-17T06:12:00Z')),
      similarity(ids.awen, ROUND, true, at('2026-10-17T06:13:00Z')),
      // agen: another round's drop
      similarity(ids.agen, OLD, true, at('2026-10-15T06:10:00Z')),
    ]);

    const res = await request(createApp()).get(`/api/v1/agents/rounds/${ROUND}`);
    const d = expectContract(RoundDigestDTOSchema, envelopeData(res.body));
    expect(d.outcomes['claude-haiku'].guardDrops).toBe(0);
    expect(d.outcomes.grok.guardDrops).toBe(1);
    expect(d.outcomes['claude-opus'].guardDrops).toBe(0);
  });
});

describe('pairNearest', () => {
  const snap = (userId: string, iso: string) => ({ userId, capturedAt: at(iso) });
  const ev = (id: string, userId: string, iso: string) => ({
    id,
    userId,
    createdAt: at(iso),
    metrics: { recentBefore: `["${id}"]` },
  });

  it('gives an event to the nearest snapshot only, and never across accounts', () => {
    const snaps = [snap('u1', '2026-10-17T06:10:00Z'), snap('u1', '2026-10-17T06:30:00Z')];
    const events = [
      ev('e-other', 'u2', '2026-10-17T06:29:59Z'),
      ev('e1', 'u1', '2026-10-17T06:29:00Z'),
    ];
    expect(pairNearest(snaps, events).map((e) => e?.id)).toEqual([undefined, 'e1']);
  });

  it('does not depend on row order', () => {
    const snaps = [snap('u1', '2026-10-17T06:10:00Z'), snap('u1', '2026-10-17T06:30:00Z')];
    const events = [ev('a', 'u1', '2026-10-17T06:09:00Z'), ev('b', 'u1', '2026-10-17T06:29:00Z')];
    expect(pairNearest(snaps, events).map((e) => e?.id)).toEqual(['a', 'b']);
    expect(pairNearest([...snaps].reverse(), [...events].reverse()).map((e) => e?.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('a contested event goes to the closer snapshot; the other takes the next nearest', () => {
    const snaps = [snap('u1', '2026-10-17T06:20:00Z'), snap('u1', '2026-10-17T06:21:00Z')];
    const events = [
      ev('near', 'u1', '2026-10-17T06:21:10Z'),
      ev('far', 'u1', '2026-10-17T06:00:00Z'),
    ];
    expect(pairNearest(snaps, events).map((e) => e?.id)).toEqual(['far', 'near']);
  });
});
