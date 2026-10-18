import { describe, expect, it } from 'vitest';
import { ARMS } from '../lab/roster';
import type { RoundDTO } from '../../../contract/lab/arms';
import { RoundDigestDTOSchema } from '../../../contract/lab/rounds';
import { expectContract } from '../../../test/contract';
import { cardKey, type RosterUser, type RoundCard } from '../arms/rounds';
import {
  buildDigest,
  canonicalJson,
  digestHashOf,
  EXCERPT_MAX,
  type DigestInput,
  type DigestPostRow,
} from './digest';

/** All 20 roster accounts with synthetic ids `id-<username>`. */
const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const ROUND = '20261017T060000Z-r';
const SWEEP: RoundDTO = {
  roundId: ROUND,
  kind: 'sweep',
  startedAt: '2026-10-17T06:00:00.000Z',
  cards: 0,
  completed: true,
  ordinal: 1,
  inWindow: true,
};
const MANUAL: RoundDTO = {
  roundId: '20261017T120000Z-m',
  kind: 'manual',
  startedAt: '2026-10-17T12:00:00.000Z',
  cards: 1,
  completed: false,
  ordinal: null,
  inWindow: false,
};

const axis = (i: number): number[] => {
  const a = [0, 0, 0, 0];
  a[i] = 1;
  return a;
};
const unit = (...v: number[]): number[] => {
  const n = Math.hypot(...v);
  return [...v.map((x) => x / n), 0, 0].slice(0, 4);
};

let seq = 0;
function card(username: string, over: Partial<RoundCard> = {}): RoundCard {
  seq += 1;
  return {
    id: `c${seq}`,
    userId: `id-${username}`,
    createdAt: new Date(Date.UTC(2026, 9, 17, 6, seq % 60)),
    outcome: 'success',
    metrics: { kind: 'cycle_run', roundId: ROUND, attempted: 2, landed: 1, dreamAccepted: true },
    roundId: ROUND,
    kind: 'sweep',
    ...over,
  };
}
function post(
  username: string,
  postId: string,
  cardSim: number | null,
  embedding: number[] = axis(0),
  text = `post ${postId}`,
): DigestPostRow {
  return { postId, userId: `id-${username}`, text, cardSim, maxSim: 0.3, embedding };
}
function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    round: SWEEP,
    endedAt: new Date('2026-10-17T07:00:00.000Z'),
    roster: ROSTER,
    cards: [],
    mismatches: new Set(),
    candidates: [],
    posts: [],
    edges: [],
    comments: [],
    dreams: [],
    newWords: [],
    ...over,
  };
}

describe('buildDigest (pure)', () => {
  it('an empty sweep round: zero outcomes, every arm missing its 4 accounts, empty lists', () => {
    const d = expectContract(RoundDigestDTOSchema, { ...buildDigest(input()), observation: null });
    for (const a of ARMS) {
      expect(d.outcomes[a.id]).toEqual({
        cards: 0,
        landed: 0,
        attempted: 0,
        failures: 0,
        missing: 4,
        dreams: 0,
        guardDrops: 0,
        missingPostVectors: 0,
        deviations: 0,
      });
    }
    expect(d.posts).toEqual([]);
    expect(d.highlights).toEqual({
      mostInCharacter: [],
      leastInCharacter: [],
      mostAlike: [],
      conversations: [],
    });
    expect(d.interactions).toEqual({ total: 0, crossArm: 0, withinArm: 0, edges: [] });
    expect(d.changes).toEqual({ dreams: [], newWords: [] });
    expect(d.round).toEqual({
      roundId: ROUND,
      kind: 'sweep',
      startedAt: '2026-10-17T06:00:00.000Z',
      endedAt: '2026-10-17T07:00:00.000Z',
      ordinal: 1,
      completed: true,
    });
  });

  it('a manual round reports nobody missing', () => {
    const d = buildDigest(input({ round: MANUAL }));
    expect(d.outcomes['claude-haiku'].missing).toBe(0);
  });

  it('counts outcomes per arm from cards and candidates; non-roster rows are ignored', () => {
    const d = buildDigest(
      input({
        cards: [
          card('xiaoman', {
            metrics: {
              kind: 'cycle_run',
              roundId: ROUND,
              attempted: 2,
              landed: 1,
              dreamAccepted: true,
              missingPostVector: true,
            },
          }),
          card('dashu', {
            outcome: 'fail',
            metrics: { kind: 'cycle_run', roundId: ROUND, attempted: 0, landed: 0 },
          }),
          card('nobody'),
        ],
        mismatches: new Set([cardKey('id-dashu', ROUND)]),
        candidates: [
          { userId: 'id-xiaoman', dropped: true },
          { userId: 'id-dashu', dropped: false },
          { userId: 'id-nobody', dropped: true },
        ],
      }),
    );
    expect(d.outcomes['claude-haiku']).toEqual({
      cards: 2,
      landed: 1,
      attempted: 2,
      failures: 1,
      missing: 2,
      dreams: 1,
      guardDrops: 1,
      missingPostVectors: 1,
      deviations: 1,
    });
  });

  it('most and least in character never overlap; least is ascending', () => {
    const d = buildDigest(
      input({
        posts: [
          post('xiaoman', 'p1', 0.9),
          post('awen', 'p2', 0.5),
          post('agen', 'p3', 0.7),
          post('lanlan', 'p4', 0.2),
          post('zhenxian', 'p5', null),
        ],
      }),
    );
    expect(d.highlights.mostInCharacter).toEqual([
      { postId: 'p1', username: 'xiaoman' },
      { postId: 'p3', username: 'agen' },
    ]);
    expect(d.highlights.leastInCharacter).toEqual([
      { postId: 'p4', username: 'lanlan' },
      { postId: 'p2', username: 'awen' },
    ]);
  });

  it('one post is most in character only', () => {
    const d = buildDigest(input({ posts: [post('xiaoman', 'p1', 0.9)] }));
    expect(d.highlights.mostInCharacter).toEqual([{ postId: 'p1', username: 'xiaoman' }]);
    expect(d.highlights.leastInCharacter).toEqual([]);
  });

  it('a model-mismatch post is listed and flagged but kept out of every highlight', () => {
    const d = buildDigest(
      input({
        mismatches: new Set([cardKey('id-agen', ROUND)]),
        posts: [
          post('xiaoman', 'p1', 0.9, axis(0)),
          post('agen', 'p3', 0.99, axis(0)),
          post('awen', 'p2', 0.5, unit(3, 1)),
        ],
      }),
    );
    expect(d.posts.find((p) => p.postId === 'p3')?.deviation).toBe(true);
    const refs = [
      ...d.highlights.mostInCharacter,
      ...d.highlights.leastInCharacter,
      ...d.highlights.mostAlike.flatMap((m) => [m.a, m.b]),
    ];
    expect(refs.map((r) => r.postId)).not.toContain('p3');
  });

  it('only deviation posts: posts listed, highlights empty', () => {
    const d = buildDigest(
      input({
        mismatches: new Set([cardKey('id-agen', ROUND)]),
        posts: [post('agen', 'p3', 0.99)],
      }),
    );
    expect(d.posts).toHaveLength(1);
    expect(d.highlights.mostInCharacter).toEqual([]);
    expect(d.highlights.mostAlike).toEqual([]);
  });

  it('mostAlike: top 3 cross-account pairs; conv is the mean cosine to other accounts', () => {
    const d = buildDigest(
      input({
        posts: [
          post('xiaoman', 'p1', 0.8, axis(0)),
          post('awen', 'p2', 0.7, unit(3, 1)), // cos(p1) = 0.9487
          post('agen', 'p3', 0.6, unit(1, 3)), // cos(p1) = 0.3162, cos(p2) = 0.6
          post('lanlan', 'p4', 0.5, axis(2)), // orthogonal to all
          post('xiaoman', 'p5', 0.4, axis(0)), // same account as p1: never paired with it
        ],
      }),
    );
    expect(d.highlights.mostAlike).toEqual([
      {
        a: { postId: 'p1', username: 'xiaoman' },
        b: { postId: 'p2', username: 'awen' },
        sim: 0.9487,
      },
      {
        a: { postId: 'p2', username: 'awen' },
        b: { postId: 'p5', username: 'xiaoman' },
        sim: 0.9487,
      },
      { a: { postId: 'p2', username: 'awen' }, b: { postId: 'p3', username: 'agen' }, sim: 0.6 },
    ]);
    // p1 vs p2, p3, p4 (p5 is the same account): (0.9487 + 0.3162 + 0) / 3
    expect(d.posts.find((p) => p.postId === 'p1')?.conv).toBe(0.4216);
  });

  it('conversations need ≥ 2 roster commenters; participants include a roster author', () => {
    const d = buildDigest(
      input({
        comments: [
          { postId: 'px', authorId: 'id-awen', postAuthorId: 'id-xiaoman' },
          { postId: 'px', authorId: 'id-awen', postAuthorId: 'id-xiaoman' },
          { postId: 'px', authorId: 'id-agen', postAuthorId: 'id-xiaoman' },
          { postId: 'px', authorId: 'id-human', postAuthorId: 'id-xiaoman' }, // not roster
          { postId: 'py', authorId: 'id-awen', postAuthorId: 'id-human' }, // one commenter
          { postId: 'pz', authorId: 'id-zhenxian', postAuthorId: 'id-human' },
          { postId: 'pz', authorId: 'id-caiyuan', postAuthorId: 'id-human' },
        ],
      }),
    );
    expect(d.highlights.conversations).toEqual([
      { postId: 'px', participants: ['agen', 'awen', 'xiaoman'], crossArm: true, comments: 3 },
      { postId: 'pz', participants: ['caiyuan', 'zhenxian'], crossArm: false, comments: 2 },
    ]);
  });

  it('interactions: aggregated per (from, to, kind); self and non-roster ends ignored', () => {
    const d = buildDigest(
      input({
        edges: [
          { source: 'id-awen', target: 'id-xiaoman', n: 2, kind: 'comment' },
          { source: 'id-agen', target: 'id-xiaoman', n: 1, kind: 'like' },
          { source: 'id-xiaoman', target: 'id-xiaoman', n: 5, kind: 'like' },
          { source: 'id-human', target: 'id-xiaoman', n: 3, kind: 'comment' },
          { source: 'id-zhenxian', target: 'id-caiyuan', n: 1, kind: 'follow' },
        ],
      }),
    );
    expect(d.interactions).toEqual({
      total: 4,
      crossArm: 3,
      withinArm: 1,
      edges: [
        { from: 'awen', to: 'xiaoman', kind: 'comment', count: 2 },
        { from: 'agen', to: 'xiaoman', kind: 'like', count: 1 },
        { from: 'zhenxian', to: 'caiyuan', kind: 'follow', count: 1 },
      ],
    });
  });

  it('dreams: roster snapshots only, rounded; new words passed through', () => {
    const d = buildDigest(
      input({
        dreams: [
          {
            userId: 'id-xiaoman',
            capturedAt: new Date('2026-10-17T06:30:00.000Z'),
            driftFromAnchor: 0.123456,
            driftFromPrev: 0.05,
            recentBefore: null,
            recentAfter: null,
          },
          {
            userId: 'id-human',
            capturedAt: new Date('2026-10-17T06:31:00.000Z'),
            driftFromAnchor: 1,
            driftFromPrev: 1,
            recentBefore: null,
            recentAfter: null,
          },
        ],
        newWords: [{ token: '多肉植', origin: 'xiaoman', adopters: ['ajie', 'awen'] }],
      }),
    );
    expect(d.changes.dreams).toEqual([
      {
        username: 'xiaoman',
        arm: 'claude-haiku',
        capturedAt: '2026-10-17T06:30:00.000Z',
        driftFromAnchor: 0.1235,
        driftFromPrev: 0.05,
      },
    ]);
    expect(d.changes.newWords).toEqual([
      { token: '多肉植', origin: 'xiaoman', adopters: ['ajie', 'awen'] },
    ]);
  });

  it('dreams carry the 最近 diff when the dream event filed one; malformed lists are omitted', () => {
    const dream = (
      username: string,
      minute: number,
      recentBefore: string | null,
      recentAfter: string | null,
    ) => ({
      userId: `id-${username}`,
      capturedAt: new Date(Date.UTC(2026, 9, 17, 6, minute)),
      driftFromAnchor: 0.1,
      driftFromPrev: 0.05,
      recentBefore,
      recentAfter,
    });
    const d = buildDigest(
      input({
        dreams: [
          dream('xiaoman', 31, '["旧的一条","留下的"]', '["新的一条","留下的"]'),
          dream('awen', 32, null, null), // a dream filed before the diff shipped
          dream('agen', 33, 'not json', '["x"]'),
          dream('ajie', 34, '[1,2]', '["x"]'), // not a string array
          dream('xiaolin', 35, '["a"]', null), // one side missing
          dream('tangtang', 36, '{"a":1}', '["x"]'), // not an array
          dream('dashu', 37, '[]', '["第一条"]'), // empty before is a valid list
        ],
      }),
    );
    expectContract(RoundDigestDTOSchema, { ...d, observation: null });
    const byUser = new Map(d.changes.dreams.map((x) => [x.username, x]));
    expect(byUser.get('xiaoman')?.recent).toEqual({
      before: ['旧的一条', '留下的'],
      after: ['新的一条', '留下的'],
    });
    expect(byUser.get('dashu')?.recent).toEqual({ before: [], after: ['第一条'] });
    for (const u of ['awen', 'agen', 'ajie', 'xiaolin', 'tangtang']) {
      expect(byUser.get(u)).toBeDefined();
      expect(byUser.get(u)).not.toHaveProperty('recent');
    }
  });

  it('excerpts collapse whitespace and stop at 140 UTF-16 units', () => {
    const long = `${'多'.repeat(150)}`;
    const d = buildDigest(
      input({
        posts: [
          post('xiaoman', 'p1', 0.9, axis(0), long),
          post('awen', 'p2', 0.5, axis(1), 'a\n\n  b'),
        ],
      }),
    );
    const p1 = d.posts.find((p) => p.postId === 'p1');
    expect(Array.from(p1?.excerpt ?? '')).toHaveLength(EXCERPT_MAX);
    expect(p1?.excerpt.endsWith('…')).toBe(true);
    expect(d.posts.find((p) => p.postId === 'p2')?.excerpt).toBe('a b');
  });

  it('emoji excerpts fit the contract and never split a surrogate pair', () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const even = '😀'.repeat(100); // the 139th unit is a high surrogate
    const odd = `a${'😀'.repeat(100)}`; // the 139th unit closes a pair
    const d = expectContract(RoundDigestDTOSchema, {
      ...buildDigest(
        input({
          posts: [
            post('xiaoman', 'p1', 0.9, axis(0), even),
            post('awen', 'p2', 0.5, axis(1), odd),
            post('agen', 'p3', 0.4, axis(2), '😀'.repeat(70)), // exactly 140 units: kept whole
          ],
        }),
      ),
      observation: null,
    });
    const excerpt = (id: string) => d.posts.find((p) => p.postId === id)?.excerpt ?? '';
    expect(excerpt('p1')).toBe(`${'😀'.repeat(69)}…`);
    expect(excerpt('p2')).toBe(`a${'😀'.repeat(69)}…`);
    expect(excerpt('p3')).toBe('😀'.repeat(70));
    for (const id of ['p1', 'p2', 'p3']) {
      expect(excerpt(id).length).toBeLessThanOrEqual(EXCERPT_MAX);
      expect(excerpt(id)).not.toMatch(LONE_SURROGATE);
    }
  });

  it('a deviation post is no comparator of conv; its own conv is against clean posts', () => {
    const rows = [post('xiaoman', 'p1', 0.9, axis(0)), post('awen', 'p2', 0.8, axis(0))];
    const without = buildDigest(input({ posts: rows }));
    const withDev = buildDigest(
      input({
        mismatches: new Set([cardKey('id-agen', ROUND)]),
        posts: [...rows, post('agen', 'p3', 0.7, axis(1))],
      }),
    );
    const conv = (d: typeof without, id: string) => d.posts.find((p) => p.postId === id)?.conv;
    expect(conv(without, 'p1')).toBe(1);
    expect(conv(withDev, 'p1')).toBe(1);
    expect(conv(withDev, 'p2')).toBe(1);
    expect(conv(withDev, 'p3')).toBe(0); // orthogonal to both clean posts
  });

  it('an empty or wrong-length embedding: conv null, pairs skipped, nothing thrown', () => {
    const d = buildDigest(
      input({
        posts: [
          post('xiaoman', 'p1', 0.9, axis(0)),
          post('awen', 'p2', 0.8, axis(0)),
          post('agen', 'p3', 0.7, []),
          post('lanlan', 'p4', 0.6, [1, 0, 0]),
        ],
      }),
    );
    const conv = (id: string) => d.posts.find((p) => p.postId === id)?.conv;
    expect(conv('p1')).toBe(1);
    expect(conv('p3')).toBeNull();
    expect(conv('p4')).toBeNull();
    expect(d.highlights.mostAlike).toEqual([
      { a: { postId: 'p1', username: 'xiaoman' }, b: { postId: 'p2', username: 'awen' }, sim: 1 },
    ]);
  });

  it('n = 7: top 3, bottom 3 ascending, the 4th-ranked in neither', () => {
    const names = ['xiaoman', 'awen', 'agen', 'lanlan', 'zhenxian', 'caiyuan', 'dashu'];
    const sims = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    const d = buildDigest(
      input({ posts: names.map((n, i) => post(n, `p${i + 1}`, sims[i], axis(i % 4))) }),
    );
    expect(d.highlights.mostInCharacter.map((r) => r.postId)).toEqual(['p1', 'p2', 'p3']);
    expect(d.highlights.leastInCharacter.map((r) => r.postId)).toEqual(['p7', 'p6', 'p5']);
  });

  it('row order does not move the digest: reversed inputs give an identical body and hash', () => {
    const rows: Partial<DigestInput> = {
      mismatches: new Set([cardKey('id-dashu', ROUND)]),
      cards: [card('xiaoman'), card('awen'), card('dashu')],
      candidates: [
        { userId: 'id-xiaoman', dropped: true },
        { userId: 'id-awen', dropped: false },
        { userId: 'id-agen', dropped: true },
      ],
      posts: [
        post('xiaoman', 'p1', 0.81234, unit(0.1, 0.2, 0.3)),
        post('awen', 'p2', 0.71234, unit(0.3, 0.2, 0.1)),
        post('agen', 'p3', 0.61234, unit(0.7, 0.1, 0.9)),
        post('lanlan', 'p4', 0.51234, unit(0.2, 0.9, 0.4)),
        post('dashu', 'p5', 0.41234, unit(0.5, 0.5, 0.5)),
      ],
      edges: [
        { source: 'id-awen', target: 'id-xiaoman', n: 2, kind: 'comment' },
        { source: 'id-agen', target: 'id-xiaoman', n: 1, kind: 'like' },
        { source: 'id-awen', target: 'id-xiaoman', n: 1, kind: 'comment' },
        { source: 'id-zhenxian', target: 'id-caiyuan', n: 1, kind: 'follow' },
      ],
      comments: [
        { postId: 'p1', authorId: 'id-awen', postAuthorId: 'id-xiaoman' },
        { postId: 'p1', authorId: 'id-agen', postAuthorId: 'id-xiaoman' },
        { postId: 'p2', authorId: 'id-xiaoman', postAuthorId: 'id-awen' },
        { postId: 'p2', authorId: 'id-agen', postAuthorId: 'id-awen' },
      ],
      dreams: [
        // same account and instant: only the drift values tell them apart
        {
          userId: 'id-xiaoman',
          capturedAt: new Date('2026-10-17T06:30:00.000Z'),
          driftFromAnchor: 0.2,
          driftFromPrev: 0.1,
          recentBefore: null,
          recentAfter: null,
        },
        {
          userId: 'id-xiaoman',
          capturedAt: new Date('2026-10-17T06:30:00.000Z'),
          driftFromAnchor: 0.1,
          driftFromPrev: 0.3,
          recentBefore: null,
          recentAfter: null,
        },
        {
          userId: 'id-awen',
          capturedAt: new Date('2026-10-17T06:40:00.000Z'),
          driftFromAnchor: 0.3,
          driftFromPrev: 0.2,
          recentBefore: '["旧的一条"]',
          recentAfter: '["新的一条"]',
        },
      ],
    };
    const reversed: Partial<DigestInput> = {
      ...rows,
      cards: [...(rows.cards ?? [])].reverse(),
      candidates: [...(rows.candidates ?? [])].reverse(),
      posts: [...(rows.posts ?? [])].reverse(),
      edges: [...(rows.edges ?? [])].reverse(),
      comments: [...(rows.comments ?? [])].reverse(),
      dreams: [...(rows.dreams ?? [])].reverse(),
    };
    const a = buildDigest(input(rows));
    const b = buildDigest(input(reversed));
    expect(b).toEqual(a);
    expect(b.digestHash).toBe(a.digestHash);
    expect(a.changes.dreams.map((x) => x.driftFromAnchor)).toEqual([0.3, 0.1, 0.2]);
  });
});

describe('digest hash', () => {
  it('canonicalJson sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}',
    );
  });

  it('is the sha256 of the canonical body: stable across builds, moved by any value', () => {
    const one = buildDigest(input({ posts: [post('xiaoman', 'p1', 0.9)] }));
    const two = buildDigest(input({ posts: [post('xiaoman', 'p1', 0.9)] }));
    const moved = buildDigest(input({ posts: [post('xiaoman', 'p1', 0.8)] }));
    expect(one.digestHash).toBe(two.digestHash);
    expect(one.digestHash).not.toBe(moved.digestHash);
    const { digestHash, ...body } = one;
    expect(digestHashOf(body)).toBe(digestHash);
  });
});
