import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { agentEvents } from '../../../db/schema';
import {
  axis,
  seedBehavior,
  seedComment,
  seedLike,
  seedPost,
  seedSnapshot,
  seedUser,
  uniqHash,
} from '../lab/lab.testSeeds';
import { clearAlertsCache, clearPulseCache, getAlerts, getInfluences, getPulse } from './pulse';

beforeEach(async () => {
  await resetDb();
  // Pulse and alerts sit behind 60s TTL caches keyed (range, era); without a
  // reset, a later test reading the same key would get an earlier payload.
  clearPulseCache();
  clearAlertsCache();
});

describe('pulse.getPulse', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a population pulse with activity, fidelity and drift velocity per day', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true, displayName: 'Zenith' });

    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    const day = noon.toISOString().slice(0, 10);

    // 2 posts, 3 comments, 5 likes by the agent today. The comment host post is
    // authored by a non-lab user so it doesn't inflate the agent's post count.
    await Promise.all([
      seedPost(agent.id, { createdAt: noon }),
      seedPost(agent.id, { createdAt: noon }),
    ]);
    const poster = await seedUser();
    const host = await seedPost(poster.id, { createdAt: noon });
    await Promise.all([
      seedComment(host.id, agent.id, { createdAt: noon }),
      seedComment(host.id, agent.id, { createdAt: noon }),
      seedComment(host.id, agent.id, { createdAt: noon }),
    ]);
    for (let i = 0; i < 5; i++) {
      await seedLike(agent.id, uniqHash('tgt'));
    }

    // Behavior fidelity 0.8 today; a dream personality snapshot with driftFromPrev 0.12 today.
    await seedBehavior(agent.id, { capturedAt: noon, fidelity: 0.8 });
    await seedSnapshot(agent.id, {
      capturedAt: noon,
      snapshotType: 'dream',
      driftFromPrev: 0.12,
    });

    const out = await getPulse('7d');

    expect(out.range).toBe('7d');
    expect(out.points).toHaveLength(7);
    const todayPoint = out.points.find((p) => p.date === day);
    expect(todayPoint).toMatchObject({
      posts: 2,
      comments: 3,
      likes: 5,
      actions: 10,
      meanFidelity: 0.8,
      meanDriftVelocity: 0.12,
    });
    // days with no activity stay zero-filled with null means (no fabricated trend)
    const empties = out.points.filter((p) => p.date !== day);
    expect(empties.every((p) => p.actions === 0 && p.meanFidelity === null)).toBe(true);
  });

  it('counts only the requested era’s activity', async () => {
    const live = await seedUser({ username: 'agen', isAgent: true });
    const sealed = await seedUser({ username: 'sealed1', isAgent: true, archivedAt: new Date() });
    await seedPost(live.id);
    await seedPost(sealed.id);
    await seedPost(sealed.id);

    const total = (out: Awaited<ReturnType<typeof getPulse>>) =>
      out.points.reduce((n, p) => n + p.posts, 0);

    expect(total(await getPulse('90d'))).toBe(1);
    expect(total(await getPulse('90d', 2))).toBe(2);
  });
});

describe('pulse alerts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('raises drift-spike (danger) and low-fidelity (warning) alerts, severest first', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });

    // drift spike (driftFromPrev 0.3 > 0.25) captured now
    await seedSnapshot(alice.id, { snapshotType: 'dream', driftFromPrev: 0.3 });
    // low fidelity (0.4 < 0.6)
    await seedBehavior(alice.id, { fidelity: 0.4 });

    const out = await getAlerts('30d');
    expect(out.alerts).toHaveLength(2);
    expect(out.alerts[0].severity).toBe('danger');
    expect(out.alerts[0].kind).toBe('drift_spike');
    expect(out.alerts.some((x) => x.kind === 'low_fidelity' && x.severity === 'warning')).toBe(
      true,
    );
  });

  async function seedDreamFail(userId: string) {
    await db.insert(agentEvents).values({
      userId,
      type: 'dream',
      phase: 'dream',
      outcome: 'fail',
      summary: 'dream fail',
      metrics: {},
    });
  }

  it('words Era 3 dream failures without the retired drift gate', async () => {
    const live = await seedUser({ username: 'agen', isAgent: true });
    await seedDreamFail(live.id);
    await seedDreamFail(live.id);

    // Same (range, era) key as the test above: the cache reset makes it fresh.
    const out = await getAlerts('30d');

    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0]).toMatchObject({
      username: 'agen',
      severity: 'warning',
      kind: 'dream_failed',
      message: '2 dream failures in 30d — empty or unparseable output, or a write error',
    });
  });

  it('keeps the Era 2 drift-gate wording for archived accounts', async () => {
    const sealed = await seedUser({ username: 'liushang', isAgent: true, archivedAt: new Date() });
    await seedDreamFail(sealed.id);
    await seedDreamFail(sealed.id);
    await seedDreamFail(sealed.id);

    // Default era is 3: the sealed account is not in that population at all.
    expect((await getAlerts('7d')).alerts).toEqual([]);

    const out = await getAlerts('7d', 2);
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0]).toMatchObject({
      username: 'liushang',
      kind: 'dream_rejected',
      message: '3 dreams rejected by the drift gate — anchor may be straining',
    });
  });
});

describe('pulse influences', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ranks outbound partners with behavior-vector proximity', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const bob = await seedUser({ username: 'bob', isAgent: false, displayName: 'Bob' });
    // bob joins the lab via a personality snapshot; behavior vectors give proximity.
    await seedSnapshot(bob.id);
    await seedBehavior(alice.id, { embedding: axis(0) });
    await seedBehavior(bob.id, { embedding: axis(0) });

    // alice → bob: 2 comments on bob's posts + 1 like = 3 outbound interactions.
    const pb1 = await seedPost(bob.id);
    const pb2 = await seedPost(bob.id);
    await seedComment(pb1.id, alice.id);
    await seedComment(pb2.id, alice.id);
    await seedLike(alice.id, pb1.id);

    const out = await getInfluences('alice', '30d');
    expect(out.partners).toHaveLength(1);
    expect(out.partners[0]).toMatchObject({ username: 'bob', interactions: 3 });
    expect(out.partners[0].proximity).toBeCloseTo(1);
    expect(out.activity).toHaveLength(30); // zero-filled days
  });
});
