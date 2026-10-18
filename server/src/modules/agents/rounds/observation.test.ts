import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../../app';
import { env } from '../../../config/env';
import { db } from '../../../db/client';
import { agentEvents, roundObservations } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { envelopeData, expectContract } from '../../../test/contract';
import {
  RoundDigestDTOSchema,
  RoundObservationPutResultSchema,
  RoundObservationPutSchema,
  RoundsListDTOSchema,
} from '../../../contract/lab/rounds';
import { seedUser } from '../lab/lab.testSeeds';
import { resetEra2Baseline } from '../arms/contagion';
import { clearRoundCaches } from './roundReads';

const ROUND = '20261017T060000Z-r';
const TOKEN = 'o'.repeat(40);
const original = env.LAB_OBSERVER_TOKEN;
const path = (id = ROUND) => `/api/v1/agents/rounds/${id}/observation`;

async function seedRound() {
  const u = await seedUser({ username: 'xiaoman', usernameDisplay: 'xiaoman', isAgent: true });
  await db.insert(agentEvents).values({
    userId: u.id,
    type: 'cycle',
    phase: 'act',
    outcome: 'success',
    summary: 'cycle_run xiaoman',
    metrics: { kind: 'cycle_run', roundId: ROUND, backend: 'claude', model: 'claude-haiku-5-5' },
    createdAt: new Date('2026-10-17T06:30:00Z'),
  });
}

async function currentHash(app = createApp()): Promise<string> {
  const res = await request(app).get(`/api/v1/agents/rounds/${ROUND}`);
  return expectContract(RoundDigestDTOSchema, envelopeData(res.body)).digestHash;
}

const body = (over: Record<string, unknown> = {}) =>
  expectContract(RoundObservationPutSchema, {
    text: '这一轮 @xiaoman 写了夜班。',
    model: 'claude-opus-5-5',
    digestHash: 'a'.repeat(64),
    promptVersion: 'observer-v1',
    ...over,
  });

beforeEach(async () => {
  await resetDb();
  clearRoundCaches();
  resetEra2Baseline();
  env.LAB_OBSERVER_TOKEN = TOKEN;
});
afterEach(() => {
  env.LAB_OBSERVER_TOKEN = original;
});

describe('PUT /api/v1/agents/rounds/:roundId/observation', () => {
  it('404 while LAB_OBSERVER_TOKEN is unset, whatever is sent', async () => {
    await seedRound();
    env.LAB_OBSERVER_TOKEN = undefined;
    const app = createApp();
    const res = await request(app).put(path()).set('X-Lab-Observer-Token', TOKEN).send(body());
    expect(res.status).toBe(404);
    // Even a malformed id: the token check runs before validation.
    const bad = await request(app).put(path('nope')).set('X-Lab-Observer-Token', TOKEN).send({});
    expect(bad.status).toBe(404);
    expect(await db.select().from(roundObservations)).toEqual([]);
  });

  it('401 without the header or with a wrong token', async () => {
    await seedRound();
    const app = createApp();
    expect((await request(app).put(path()).send(body())).status).toBe(401);
    expect(
      (await request(app).put(path()).set('X-Lab-Observer-Token', 'x'.repeat(40)).send(body()))
        .status,
    ).toBe(401);
    expect(await db.select().from(roundObservations)).toEqual([]);
  });

  it('accepts the header name in any case', async () => {
    await seedRound();
    const res = await request(createApp())
      .put(path())
      .set('X-LAB-OBSERVER-TOKEN', TOKEN)
      .send(body());
    expect(res.status).toBe(200);
  });

  it('401 on a repeated header, even when both copies are the token', async () => {
    await seedRound();
    // Two header lines; Node joins them to "<token>, <token>", which never matches.
    const twice = [TOKEN, TOKEN] as unknown as string;
    const res = await request(createApp())
      .put(path())
      .set('X-Lab-Observer-Token', twice)
      .send(body());
    expect(res.status).toBe(401);
    expect(await db.select().from(roundObservations)).toEqual([]);
  });

  it('400 on a malformed id, a blank or 1201-char text, an unknown key; 404 on an unknown round', async () => {
    await seedRound();
    const app = createApp();
    const put = (p: string, b: object) =>
      request(app).put(p).set('X-Lab-Observer-Token', TOKEN).send(b);
    expect((await put(path('nope'), body())).status).toBe(400);
    expect((await put(path(), { ...body(), text: '   ' })).status).toBe(400);
    expect((await put(path(), { ...body(), text: 'x'.repeat(1201) })).status).toBe(400);
    expect((await put(path(), { ...body(), extra: 1 })).status).toBe(400);
    expect((await put(path('20261001T000000Z-r'), body())).status).toBe(404);
    expect(await db.select().from(roundObservations)).toEqual([]);
    expect((await put(path(), { ...body(), text: 'x'.repeat(1200) })).status).toBe(200);
  });

  it('writes, then replaces in place; the read carries it, fresh or stale', async () => {
    await seedRound();
    const app = createApp();
    const hash = await currentHash(app);

    const first = await request(app)
      .put(path())
      .set('X-Lab-Observer-Token', TOKEN)
      .send(body({ digestHash: hash }));
    expect(first.status).toBe(200);
    const written = expectContract(RoundObservationPutResultSchema, envelopeData(first.body));
    expect(written.roundId).toBe(ROUND);

    let d = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(app).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    expect(d.observation).toMatchObject({
      text: '这一轮 @xiaoman 写了夜班。',
      model: 'claude-opus-5-5',
      digestHash: hash,
      stale: false,
      updatedAt: written.updatedAt,
    });

    // Backdate the first write by an hour, so a re-PUT that left updated_at
    // to the column default (insert-only) would read back the old instant.
    const backdated = new Date(Date.parse(written.updatedAt) - 60 * 60_000);
    await db
      .update(roundObservations)
      .set({ createdAt: backdated, updatedAt: backdated })
      .where(eq(roundObservations.roundId, ROUND));

    const second = await request(app)
      .put(path())
      .set('X-Lab-Observer-Token', TOKEN)
      .send(body({ text: 'second', digestHash: 'b'.repeat(64) }));
    const rewritten = expectContract(RoundObservationPutResultSchema, envelopeData(second.body));
    // The upsert sets updated_at itself; created_at stays the first write's.
    expect(Date.parse(rewritten.updatedAt)).toBeGreaterThan(backdated.getTime());
    d = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(app).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    expect(d.observation).toMatchObject({ text: 'second', stale: true });
    const rows = await db.select().from(roundObservations);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.toISOString()).toBe(backdated.toISOString());
    expect(rows[0].updatedAt.toISOString()).toBe(rewritten.updatedAt);
  });

  it('the list flags the round at once (the PUT clears the list cache)', async () => {
    await seedRound();
    const app = createApp();
    const before = expectContract(
      RoundsListDTOSchema,
      envelopeData((await request(app).get('/api/v1/agents/rounds')).body),
    );
    expect(before.rounds[0].hasObservation).toBe(false);
    await request(app).put(path()).set('X-Lab-Observer-Token', TOKEN).send(body());
    const after = expectContract(
      RoundsListDTOSchema,
      envelopeData((await request(app).get('/api/v1/agents/rounds')).body),
    );
    expect(after.rounds[0].hasObservation).toBe(true);
  });

  it('a round with no note reads observation: null', async () => {
    await seedRound();
    const d = expectContract(
      RoundDigestDTOSchema,
      envelopeData((await request(createApp()).get(`/api/v1/agents/rounds/${ROUND}`)).body),
    );
    expect(d.observation).toBeNull();
  });
});
