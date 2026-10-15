import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../test/db-reset';
import { seedComment, seedLike, seedPost, seedUser } from '../lab/lab.testSeeds';
import { clearInteractionGraphCache, getInteractionGraph } from './graph';

beforeEach(async () => {
  await resetDb();
  // 60s TTL cache keyed (range, era) — see pulse.test.ts.
  clearInteractionGraphCache();
});

describe('graph.getInteractionGraph', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges comment/reply/echo/like edges within the lab population', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const bob = await seedUser({ username: 'bob', isAgent: true, displayName: 'Bob' });

    // Posts: P0 (alice, host for the parent comment), P1 & P2 (bob), P3 (alice's echo of P2).
    const p0 = await seedPost(alice.id);
    const p1 = await seedPost(bob.id);
    const p2 = await seedPost(bob.id);
    await seedPost(alice.id, { echoOf: p2.id }); // echo alice→bob

    // top-level comment alice→bob on P1
    await seedComment(p1.id, alice.id);
    // parent comment by alice on her own post (self → excluded from edges) + a reply by bob
    const parent = await seedComment(p0.id, alice.id);
    await seedComment(p0.id, bob.id, { parentId: parent.id }); // reply bob→alice

    // likes alice→bob on P1 and P2 (weight 2)
    await seedLike(alice.id, p1.id);
    await seedLike(alice.id, p2.id);

    const out = await getInteractionGraph('7d');

    expect(out.range).toBe('7d');
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(2);

    // a→b accumulates comment(1) + echo(1) + like(2) on one edge = weight 4.
    const ab = out.edges.find((e) => e.source === 'alice' && e.target === 'bob');
    const ba = out.edges.find((e) => e.source === 'bob' && e.target === 'alice');
    expect(ab).toMatchObject({ weight: 4, kinds: { comment: 1, reply: 0, echo: 1, like: 2 } });
    expect(ba).toMatchObject({ weight: 1, kinds: { reply: 1 } });

    // strength = in + out: alice 4(out)+1(in)=5
    const aliceNode = out.nodes.find((n) => n.username === 'alice');
    expect(aliceNode).toMatchObject({ isAgent: true, strength: 5 });
  });

  it('drops edges whose endpoints are outside the lab population', async () => {
    const alice = await seedUser({ username: 'alice', isAgent: true, displayName: 'Alice' });
    const outsider = await seedUser({ username: 'outsider', isAgent: false });

    const p = await seedPost(outsider.id);
    await seedComment(p.id, alice.id); // alice→outsider, but outsider is not in the lab

    const out = await getInteractionGraph('30d');
    expect(out.edges).toHaveLength(0);
    expect(out.nodes).toHaveLength(0);
  });

  it('scopes edges to the requested era', async () => {
    const live = await seedUser({ username: 'agen', isAgent: true });
    const live2 = await seedUser({ username: 'awen', isAgent: true });
    const sealed = await seedUser({ username: 'sealed1', isAgent: true, archivedAt: new Date() });
    const sealed2 = await seedUser({ username: 'sealed2', isAgent: false, archivedAt: new Date() });

    const pLive = await seedPost(live2.id);
    const pSealed = await seedPost(sealed2.id);
    await seedComment(pLive.id, live.id); // Era 3 → Era 3
    await seedComment(pSealed.id, sealed.id); // Era 2 → Era 2
    await seedComment(pSealed.id, live.id); // cross-era: in neither graph

    const era3 = await getInteractionGraph('90d', 3);
    const era2 = await getInteractionGraph('90d', 2);

    expect(era3.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['agen>awen']);
    expect(era2.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['sealed1>sealed2']);
  });
});
