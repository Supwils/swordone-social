import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { personalitySnapshots } from '../../../db/schema';
import {
  axis,
  mixed06,
  seedBehavior,
  seedSnapshot,
  seedUser,
  uniqHash,
} from '../lab/lab.testSeeds';
import { getDrift, getFidelity, ingestBehaviorSnapshot, ingestSnapshot } from './drift';

/**
 * Integration rewrite: these suites run against the real test Postgres (migrated
 * by vitest globalSetup, truncated per test by resetDb). We seed real rows and assert on the service's
 * returned shape and/or the resulting DB rows.
 */

beforeEach(resetDb);

describe('drift.ingestSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestSnapshot('zenith', other, {
        contentHash: uniqHash('a'),
        embedding: axis(0),
        snapshotType: 'dream',
        archivePath: 'agents/zenith/personality.archive.md#1',
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('returns the existing snapshot if contentHash already ingested (idempotent backfill)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('dup');
    await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.12,
      driftFromPrev: 0.05,
    });

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#2',
      excerpt: '',
    });

    expect(out.driftFromAnchor).toBe(0.12);
    expect(out.driftFromPrev).toBe(0.05);
  });

  it('lets two accounts ingest the same contentHash independently', async () => {
    const a = await seedUser({ username: 'zenith', isAgent: true });
    const b = await seedUser({ username: 'liushang', isAgent: true });
    const hash = uniqHash('shared');
    const outA = await ingestSnapshot('zenith', a, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#1',
      excerpt: '',
    });
    const outB = await ingestSnapshot('liushang', b, {
      contentHash: hash,
      embedding: axis(1),
      snapshotType: 'dream',
      archivePath: 'agents/liushang/personality.archive.md#1',
      excerpt: '',
    });
    expect(outA.id).not.toBe(outB.id);
  });

  it('backfills aspectDrift onto a pre-existing snapshot that lacks it', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('bf');
    const existing = await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.1,
      driftFromPrev: 0.05,
    });
    expect(existing.aspectDrift).toBeNull();

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#9',
      excerpt: '',
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.9,
        style: 0.8,
        topic: 0.7,
        breached: [],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, existing.id));
    expect(row.aspectDrift).toMatchObject({ mode: 'shadow', values: 0.9 });
  });

  it('does not overwrite an existing aspectDrift block on re-ingest', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('noov');
    const existing = await seedSnapshot(agent.id, {
      contentHash: hash,
      driftFromAnchor: 0.1,
      driftFromPrev: 0.05,
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.95,
        style: 0.9,
        topic: 0.8,
        breached: [],
      },
    });

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#9',
      excerpt: '',
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.1,
        style: 0.1,
        topic: 0.1,
        breached: ['values', 'style', 'topic'],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, existing.id));
    expect(row.aspectDrift?.mode).toBe('aspect');
    expect(row.aspectDrift?.values).toBe(0.95);
  });

  it('recomputes driftFromAnchor for every earlier snapshot when the anchor arrives', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    // Three snapshots land before any anchor exists, so each is stored with
    // driftFromAnchor = 0. Distinct embeddings give distinct expected values.
    const early = [
      { hash: uniqHash('pre-a'), embedding: axis(1), expected: 1 }, // dot 0   → dist 1
      { hash: uniqHash('pre-b'), embedding: mixed06(), expected: 0.4 }, // dot 0.6 → dist 0.4
      { hash: uniqHash('pre-c'), embedding: axis(0), expected: 0 }, // dot 1   → dist 0
    ];
    for (const s of early) {
      await ingestSnapshot('zenith', agent, {
        contentHash: s.hash,
        embedding: s.embedding,
        snapshotType: 'dream',
        archivePath: `agents/zenith/personality.archive.md#${s.hash}`,
        excerpt: '',
      });
    }
    const before = await db
      .select({
        contentHash: personalitySnapshots.contentHash,
        d: personalitySnapshots.driftFromAnchor,
      })
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id));
    expect(before.every((r) => r.d === 0)).toBe(true);

    // The anchor arrives late (the backfill case) and must rewrite all three.
    const anchorHash = uniqHash('anchor');
    await ingestSnapshot('zenith', agent, {
      contentHash: anchorHash,
      embedding: axis(0),
      snapshotType: 'anchor',
      archivePath: 'agents/zenith/personality.md',
      excerpt: '',
    });

    const after = await db
      .select({
        contentHash: personalitySnapshots.contentHash,
        d: personalitySnapshots.driftFromAnchor,
      })
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id));
    const byHash = new Map(after.map((r) => [r.contentHash, r.d]));

    for (const s of early) {
      expect(byHash.get(s.hash)).toBeCloseTo(s.expected, 10);
    }
    // The anchor row itself is excluded from the rewrite and keeps its own 0.
    expect(byHash.get(anchorHash)).toBe(0);
    expect(after).toHaveLength(4);
  });

  it('leaves other agents untouched when one agent gets a new anchor', async () => {
    const zenith = await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'liushang', isAgent: true });

    const otherSnap = await seedSnapshot(other.id, { driftFromAnchor: 0.77 });
    await ingestSnapshot('zenith', zenith, {
      contentHash: uniqHash('z-pre'),
      embedding: axis(1),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#1',
      excerpt: '',
    });
    await ingestSnapshot('zenith', zenith, {
      contentHash: uniqHash('z-anchor'),
      embedding: axis(0),
      snapshotType: 'anchor',
      archivePath: 'agents/zenith/personality.md',
      excerpt: '',
    });

    const [untouched] = await db
      .select({ d: personalitySnapshots.driftFromAnchor })
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, otherSnap.id));
    expect(untouched.d).toBe(0.77);
  });

  it('measures against the NEWEST anchor when an account has two', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // The older anchor goes in first, so an unordered `LIMIT 1` reads it.
    await seedSnapshot(agent.id, {
      contentHash: uniqHash('old-anchor'),
      embedding: axis(0),
      snapshotType: 'anchor',
      capturedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await seedSnapshot(agent.id, {
      contentHash: uniqHash('new-anchor'),
      embedding: axis(1),
      snapshotType: 'anchor',
      capturedAt: new Date('2026-10-10T00:00:00.000Z'),
    });

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: uniqHash('dream-after'),
      embedding: axis(1),
      snapshotType: 'dream',
      capturedAt: new Date('2026-10-12T00:00:00.000Z'),
      archivePath: 'agents/zenith/personality.archive.md#9',
      excerpt: '',
    });

    // Identical to the newer anchor (distance 0), orthogonal to the older (1).
    expect(out.driftFromAnchor).toBeCloseTo(0, 6);
  });

  it('does not rebase the series onto a late-backfilled OLDER anchor', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedSnapshot(agent.id, {
      contentHash: uniqHash('cur-anchor'),
      embedding: axis(1),
      snapshotType: 'anchor',
      capturedAt: new Date('2026-10-10T00:00:00.000Z'),
    });
    const dream = await seedSnapshot(agent.id, {
      contentHash: uniqHash('dream'),
      embedding: axis(1),
      capturedAt: new Date('2026-10-11T00:00:00.000Z'),
      driftFromAnchor: 0,
    });

    await ingestSnapshot('zenith', agent, {
      contentHash: uniqHash('older-anchor'),
      embedding: axis(0),
      snapshotType: 'anchor',
      capturedAt: new Date('2026-10-01T00:00:00.000Z'),
      archivePath: 'agents/zenith/personality.md',
      excerpt: '',
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, dream.id));
    expect(row.driftFromAnchor).toBe(0);
  });

  it('breaks a capturedAt tie like the lookup does: only the higher-id anchor rebases', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const at = new Date('2026-10-10T00:00:00.000Z');
    // The lookup orders capturedAt desc, id desc — so at one instant the anchor
    // with the highest id is the one measured against. An all-`f` id sorts above
    // any id the ingest below can be given.
    await seedSnapshot(agent.id, {
      id: 'f'.repeat(24),
      contentHash: uniqHash('tie-anchor-high'),
      embedding: axis(1),
      snapshotType: 'anchor',
      capturedAt: at,
    });
    const dream = await seedSnapshot(agent.id, {
      contentHash: uniqHash('dream'),
      embedding: axis(1),
      capturedAt: new Date('2026-10-11T00:00:00.000Z'),
      driftFromAnchor: 0,
    });

    await ingestSnapshot('zenith', agent, {
      contentHash: uniqHash('tie-anchor-low'),
      embedding: axis(0),
      snapshotType: 'anchor',
      capturedAt: at,
      archivePath: 'agents/zenith/personality.md',
      excerpt: '',
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.id, dream.id));
    // Still measured against the high-id anchor (identical vector), not rebased
    // onto the orthogonal low-id one.
    expect(row.driftFromAnchor).toBe(0);
  });

  it('computes drift = 0 when no anchor or prev snapshot exists yet', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestSnapshot('zenith', agent, {
      contentHash: uniqHash('c'),
      embedding: axis(0),
      snapshotType: 'anchor',
      archivePath: 'agents/zenith/personality.md',
      excerpt: 'hello',
    });

    expect(out.driftFromAnchor).toBe(0);
    expect(out.driftFromPrev).toBe(0);

    const rows = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.userId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshotType).toBe('anchor');
  });

  it('persists aspectDrift on the created snapshot when provided', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('d');

    await ingestSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      snapshotType: 'dream',
      archivePath: 'agents/zenith/personality.archive.md#3',
      excerpt: '',
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.91,
        style: 0.78,
        topic: 0.72,
        breached: ['style'],
      },
    });

    const [row] = await db
      .select()
      .from(personalitySnapshots)
      .where(eq(personalitySnapshots.contentHash, hash));
    expect(row.aspectDrift).toMatchObject({ mode: 'aspect', style: 0.78, breached: ['style'] });
  });
});

describe('drift.getDrift', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty list for an agent with no snapshots', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const out = await getDrift('zenith');
    expect(out).toEqual([]);
  });

  it('surfaces diffNarrative when present and omits it otherwise (Feature 5)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      driftFromAnchor: 0.1,
      driftFromPrev: 0.1,
      snapshotType: 'anchor',
      excerpt: 'x',
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.2,
      driftFromPrev: 0.12,
      snapshotType: 'dream',
      excerpt: 'y',
      diffNarrative: '强化了对“在场”的关注，淡化了早期的技术腔。',
    });

    const out = await getDrift('zenith');
    expect(out[0].diffNarrative).toBeUndefined();
    expect(out[1].diffNarrative).toContain('在场');
  });

  it('surfaces per-aspect drift when present and omits it otherwise', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      driftFromAnchor: 0.1,
      driftFromPrev: 0.1,
      snapshotType: 'anchor',
      excerpt: 'x',
    });
    await seedSnapshot(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      driftFromAnchor: 0.2,
      driftFromPrev: 0.12,
      snapshotType: 'dream',
      excerpt: 'y',
      aspectDrift: {
        mode: 'aspect',
        promptVersion: 1,
        values: 0.91,
        style: 0.78,
        topic: 0.72,
        breached: ['style'],
      },
    });

    const out = await getDrift('zenith');
    expect(out[0].aspects).toBeUndefined();
    expect(out[1].aspects).toMatchObject({ mode: 'aspect', style: 0.78, breached: ['style'] });
  });
});

describe('drift persona fidelity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects behavior ingest when the actor is not the agent itself', async () => {
    await seedUser({ username: 'zenith', isAgent: true });
    const other = await seedUser({ username: 'someoneelse', isAgent: true });

    await expect(
      ingestBehaviorSnapshot('zenith', other, {
        contentHash: uniqHash('a'),
        embedding: axis(0),
        postCount: 3,
        commentCount: 0,
        excerpt: '',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is idempotent — returns the existing row on a contentHash hit', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    const hash = uniqHash('bdup');
    await seedBehavior(agent.id, { contentHash: hash, fidelity: 0.91 });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: hash,
      embedding: axis(0),
      postCount: 5,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBe(0.91);
  });

  it('computes fidelity = cosine(behavior, latest personality vector)', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // latest personality snapshot — same unit vector → cosine = 1
    await seedSnapshot(agent.id, { embedding: axis(0) });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('bc'),
      embedding: axis(0),
      postCount: 7,
      commentCount: 0,
      excerpt: 'recent posts',
    });

    expect(out.fidelity).toBeCloseTo(1);
  });

  it('computes a fractional fidelity for partially-aligned vectors', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    // persona = axis(0); behavior = [0.6, 0.8, 0, ...] → cosine = 0.6 (both unit vectors)
    await seedSnapshot(agent.id, { embedding: axis(0) });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('be'),
      embedding: mixed06(),
      postCount: 4,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeCloseTo(0.6);
  });

  it('records null fidelity when there is no personality snapshot yet', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });

    const out = await ingestBehaviorSnapshot('zenith', agent, {
      contentHash: uniqHash('bd'),
      embedding: axis(0),
      postCount: 2,
      commentCount: 0,
      excerpt: '',
    });

    expect(out.fidelity).toBeNull();
  });

  it('returns the fidelity trajectory with the latest as current', async () => {
    const agent = await seedUser({ username: 'zenith', isAgent: true });
    await seedBehavior(agent.id, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      fidelity: 0.8,
    });
    await seedBehavior(agent.id, {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      fidelity: 0.74,
    });

    const out = await getFidelity('zenith');
    expect(out.points).toHaveLength(2);
    expect(out.current).toBe(0.74);
  });
});
