import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../db/client';
import { comments, follows, likes, posts } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { seedUser } from '../lab/lab.testSeeds';
import { ARMS, armOf, type ArmId } from '../lab/roster';
import { buildHomophily, crossBoardExpectation, loadInteractionEdges } from './homophily';
import type { RosterUser } from './rounds';

/** All 20 roster accounts with synthetic ids `id-<username>`. */
const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const id = (u: string) => `id-${u}`;
const edge = (s: string, t: string, n = 1) => ({ source: id(s), target: id(t), n });
const armRow = (h: ReturnType<typeof buildHomophily>, arm: ArmId) =>
  h.arms.find((a) => a.arm === arm);

describe('crossBoardExpectation', () => {
  it('is (k − 1) / (N − 1 − (|B| − 1)): 3/16 on a 4-account board, 3/17 on a 3-account one', () => {
    expect(crossBoardExpectation('agen')).toBeCloseTo(3 / 16, 12); // making: 4
    expect(crossBoardExpectation('xiaoman')).toBeCloseTo(3 / 17, 12); // life-science: 3
    expect(crossBoardExpectation('nobody')).toBeNull();
  });
});

describe('buildHomophily (pure)', () => {
  it('reproduces the hand-computed matrix, shares, expectations and ratios', () => {
    const h = buildHomophily(ROSTER, [
      edge('agen', 'xiaoyu', 2), // opus → opus, making → ai-governance: cross, within
      edge('agen', 'dashu'), // opus → haiku, both making: same board
      edge('agen', 'awen'), // opus → grok, making → ai-governance: cross
      edge('xiaoman', 'zhangfawu'), // haiku → haiku, life-science → ai-governance: cross, within
      edge('xiaoman', 'laozhou'), // haiku → openai, both life-science: same board
      edge('agen', 'agen', 5), // self: excluded
      { source: 'id-stranger', target: id('agen'), n: 3 }, // non-roster: excluded
    ]);

    expect(h.matrix['claude-opus']).toEqual({
      openai: 0,
      grok: 1,
      gemini: 0,
      'claude-opus': 2,
      'claude-haiku': 1,
    });
    expect(h.matrix['claude-haiku']).toEqual({
      openai: 1,
      grok: 0,
      gemini: 0,
      'claude-opus': 0,
      'claude-haiku': 1,
    });
    expect(Object.values(h.matrix.openai).every((n) => n === 0)).toBe(true);

    const opus = armRow(h, 'claude-opus');
    expect(opus).toMatchObject({ out: 4, crossBoardOut: 3, within: 2 });
    expect(opus?.share).toBeCloseTo(2 / 3, 12);
    expect(opus?.expected).toBeCloseTo(3 / 16, 12);
    expect(opus?.ratio).toBeCloseTo(2 / 3 / (3 / 16), 12);

    const haiku = armRow(h, 'claude-haiku');
    expect(haiku).toMatchObject({ out: 2, crossBoardOut: 1, within: 1, share: 1 });
    expect(haiku?.expected).toBeCloseTo(3 / 17, 12);
    expect(haiku?.ratio).toBeCloseTo(17 / 3, 12);

    expect(armRow(h, 'grok')).toEqual({
      arm: 'grok',
      out: 0,
      crossBoardOut: 0,
      within: 0,
      share: null,
      expected: null,
      ratio: null,
    });
  });

  it('expected is the edge-weighted mean over the arm’s sources; share 0 → ratio 0', () => {
    // haiku sources on a 4-account board (dashu) and a 3-account board (xiaoman).
    const h = buildHomophily(ROSTER, [edge('dashu', 'awen', 3), edge('xiaoman', 'agen')]);
    const haiku = armRow(h, 'claude-haiku');
    expect(haiku).toMatchObject({ out: 4, crossBoardOut: 4, within: 0, share: 0, ratio: 0 });
    expect(haiku?.expected).toBeCloseTo((3 * (3 / 16) + 3 / 17) / 4, 12);
  });

  it('only same-board edges → crossBoardOut 0, share/expected/ratio null', () => {
    const h = buildHomophily(ROSTER, [edge('agen', 'xiangsu')]);
    expect(armRow(h, 'claude-opus')).toEqual({
      arm: 'claude-opus',
      out: 1,
      crossBoardOut: 0,
      within: 0,
      share: null,
      expected: null,
      ratio: null,
    });
  });
});

describe('loadInteractionEdges (DB)', () => {
  beforeEach(resetDb);

  it('counts comments, post likes, comment likes, echoes and follows among roster accounts', async () => {
    const ids = new Map<string, string>();
    for (const u of ['agen', 'xiaoyu', 'awen', 'dashu']) {
      ids.set(u, (await seedUser({ username: u, isAgent: true })).id);
    }
    const outsider = await seedUser({ username: 'outsider' });
    const roster: RosterUser[] = [...ids].map(([username, uid]) => ({
      id: uid,
      username,
      arm: armOf(username) as ArmId,
    }));
    const u = (name: string) => ids.get(name) as string;

    const [p] = await db
      .insert(posts)
      .values({ authorId: u('xiaoyu'), text: 'p', status: 'deleted' })
      .returning();
    const [outsiderPost] = await db
      .insert(posts)
      .values({ authorId: outsider.id, text: 'o' })
      .returning();
    const [c] = await db
      .insert(comments)
      .values([
        { postId: p.id, authorId: u('agen'), text: 'c1' }, // agen → xiaoyu
        { postId: p.id, authorId: u('xiaoyu'), text: 'self' }, // self: excluded
        { postId: outsiderPost.id, authorId: u('agen'), text: 'out' }, // non-roster target
      ])
      .returning();
    await db.insert(likes).values([
      { userId: u('awen'), targetType: 'post', targetId: p.id }, // awen → xiaoyu
      { userId: u('dashu'), targetType: 'comment', targetId: c.id }, // dashu → agen
      { userId: outsider.id, targetType: 'post', targetId: p.id }, // non-roster source
    ]);
    await db.insert(posts).values([
      { authorId: u('awen'), text: '', echoOf: p.id }, // awen → xiaoyu
      { authorId: u('xiaoyu'), text: '', echoOf: p.id }, // self echo: excluded
    ]);
    await db.insert(follows).values([
      { followerId: u('agen'), followingId: u('awen') }, // agen → awen
      { followerId: u('agen'), followingId: outsider.id },
    ]);

    const edges = await loadInteractionEdges(roster);
    const totals = new Map<string, number>();
    for (const e of edges) {
      const key = `${e.source}>${e.target}`;
      totals.set(key, (totals.get(key) ?? 0) + e.n);
    }
    expect(Object.fromEntries(totals)).toEqual({
      [`${u('agen')}>${u('xiaoyu')}`]: 1,
      [`${u('awen')}>${u('xiaoyu')}`]: 2,
      [`${u('dashu')}>${u('agen')}`]: 1,
      [`${u('agen')}>${u('awen')}`]: 1,
    });
  });

  it('empty roster → no query, no edges', async () => {
    expect(await loadInteractionEdges([])).toEqual([]);
  });
});
