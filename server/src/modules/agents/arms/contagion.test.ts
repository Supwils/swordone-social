import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../db/client';
import { comments, posts } from '../../../db/schema';
import { resetDb } from '../../../test/db-reset';
import { seedUser } from '../lab/lab.testSeeds';
import { ARMS, type ArmId } from '../lab/roster';
import {
  buildContagion,
  hashToken,
  loadEra2Baseline,
  loadRosterUtterances,
  resetEra2Baseline,
  tokenize,
  type Utterance,
} from './contagion';
import { buildRounds, type RawCard, type RosterUser } from './rounds';

/** All 20 roster accounts with synthetic ids `id-<username>`. */
const ROSTER: RosterUser[] = ARMS.flatMap((a) =>
  a.usernames.map((username) => ({ id: `id-${username}`, username, arm: a.id })),
);
const MODEL = new Map<ArmId, string>(ARMS.map((a) => [a.id, a.model]));
const sweep = (d: number) => `202610${String(d).padStart(2, '0')}T060000Z-r`;

let seq = 0;
/** One card per account for `n` accounts (≥ 10 makes the sweep completed). */
function cards(roundId: string, n = 20): RawCard[] {
  return ROSTER.slice(0, n).map((u) => {
    seq += 1;
    const [backend, model] = (MODEL.get(u.arm) as string).split(/:(.*)/s);
    return {
      id: `c${String(seq).padStart(6, '0')}`,
      userId: u.id,
      createdAt: new Date(Date.UTC(2026, 9, 1) + seq * 1000),
      outcome: 'success',
      metrics: { kind: 'cycle_run', roundId, backend, model },
    };
  });
}

/** An utterance on day `d` of October 2026 at `hh:00` UTC. */
const say = (u: string, d: number, hh: number, text: string): Utterance => {
  seq += 1;
  return {
    id: `u${String(seq).padStart(6, '0')}`,
    userId: `id-${u}`,
    text,
    createdAt: new Date(Date.UTC(2026, 9, d, hh)),
  };
};

const tok = (text: string) => [...tokenize(text)].sort();
const hashes = (tokens: Iterable<string>) => new Set([...tokens].map(hashToken));

describe('tokenize', () => {
  it('CJK runs → character 3-grams; runs shorter than 3 yield nothing', () => {
    expect(tok('今天天气')).toEqual(['天天气', '今天天'].sort());
    expect(tok('你好')).toEqual([]);
  });

  it('latin words of ≥ 3 characters, lowercased; shorter words dropped', () => {
    expect(tok('The AI Model is OK')).toEqual(['model', 'the']);
  });

  it('digit-only tokens are dropped; a word may carry digits after its first letter', () => {
    expect(tok('2026 12345 gpt5 v2 abc123')).toEqual(['abc123', 'gpt5']);
  });

  it('mixed text: CJK runs split by latin, punctuation and digits', () => {
    expect(tok('我用GPT写代码，效果不错！2026年')).toEqual(
      ['gpt', '写代码', '效果不', '果不错'].sort(),
    );
  });

  it('kana and hangul are CJK too; repeated tokens collapse', () => {
    expect(tok('ありがとう')).toEqual(['ありが', 'りがと', 'がとう'].sort());
    expect(tok('안녕하세요')).toEqual(['안녕하', '녕하세', '하세요'].sort());
    expect(tok('hello HELLO hello')).toEqual(['hello']);
  });

  it('NFKC first: full-width latin and half-width kana fold to their usual forms', () => {
    expect(tok('ＧＰＴ５ Ｈｅｌｌｏ')).toEqual(['gpt5', 'hello']);
    expect(tok('ｶﾀｶﾅ')).toEqual(['カタカ', 'タカナ']);
  });

  it('URLs are stripped before tokenizing', () => {
    expect(tok('see https://example.com/path?q=word and HTTP://新闻网站.cn/今日 done')).toEqual([
      'and',
      'done',
      'see',
    ]);
  });

  it('the prolonged sound mark ー stays inside a kana run', () => {
    expect(tok('コーヒー')).toEqual(['コーヒ', 'ーヒー']);
    expect(tok('ｺｰﾋｰ')).toEqual(['コーヒ', 'ーヒー']);
  });

  it('empty text → no tokens', () => {
    expect(tok('')).toEqual([]);
  });
});

describe('buildContagion (pure)', () => {
  const four = buildRounds(
    [...cards(sweep(1)), ...cards(sweep(2)), ...cards(sweep(3)), ...cards(sweep(4))],
    ROSTER,
  );

  it('excludes Era 2 and rounds-1–2 tokens; same-round use is not adoption', () => {
    const era2 = hashes(tokenize('oldword'));
    const c = buildContagion(
      four,
      [
        say('xiaoman', 0, 12, 'earlyword'), // before the first sweep → baseline
        say('agen', 1, 7, 'hello world'), // round 1 → baseline
        say('awen', 2, 23, 'lateword'), // round 2 → baseline
        say('agen', 3, 7, 'novel oldword hello'), // round 3: only "novel" is new
        say('xiaoyu', 3, 8, 'novel'), // same round as the origin: not an adopter
        say('lanlan', 3, 9, '新鲜事'), // gemini innovation
        say('awen', 3, 10, 'fresh lateword'), // grok innovation; lateword is baseline
        say('dashu', 4, 7, 'novel'), // adopter 1 of novel
        say('awen', 4, 8, 'novel'), // adopter 2 of novel → adopted
        say('agen', 4, 9, 'novel'), // the origin again: ignored
        say('zhenxian', 4, 10, 'fresh earlyword'), // one adopter only: not adopted
        say('ajie', 4, 11, '新鲜事'), // same-arm adopter counts
        say('caiyuan', 9, 11, '新鲜事'), // after the last sweep → last round
      ],
      era2,
    );

    expect(c.status).toBe('ok');
    const arm = (id: ArmId) => c.arms.find((a) => a.arm === id);
    expect(arm('claude-opus')).toEqual({
      arm: 'claude-opus',
      innovations: 1,
      adopted: 1,
      rate: 1,
    });
    expect(arm('grok')).toEqual({ arm: 'grok', innovations: 1, adopted: 0, rate: 0 });
    expect(arm('gemini')).toEqual({ arm: 'gemini', innovations: 1, adopted: 1, rate: 1 });
    expect(arm('openai')).toEqual({ arm: 'openai', innovations: 0, adopted: 0, rate: null });
    expect(arm('claude-haiku')).toEqual({
      arm: 'claude-haiku',
      innovations: 0,
      adopted: 0,
      rate: null,
    });

    expect(c.top).toEqual([
      {
        token: 'novel',
        origin: 'agen',
        originArm: 'claude-opus',
        adopters: 2,
        adopterArms: ['claude-haiku', 'grok'],
      },
      {
        token: '新鲜事',
        origin: 'lanlan',
        originArm: 'gemini',
        adopters: 2,
        adopterArms: ['gemini', 'openai'],
      },
    ]);
  });

  it('collecting before 3 completed rounds; with < 3 sweeps everything is baseline', () => {
    const two = buildRounds([...cards(sweep(1)), ...cards(sweep(2))], ROSTER);
    const c = buildContagion(
      two,
      [say('agen', 2, 7, 'novel'), say('dashu', 5, 7, 'novel'), say('awen', 6, 7, 'novel')],
      new Set(),
    );
    expect(c.status).toBe('collecting');
    expect(c.arms.every((a) => a.innovations === 0 && a.rate === null)).toBe(true);
    expect(c.top).toEqual([]);
  });

  it('three sweeps but only two completed → still collecting, innovations still counted', () => {
    const partial = buildRounds(
      [...cards(sweep(1)), ...cards(sweep(2), 3), ...cards(sweep(3))],
      ROSTER,
    );
    expect(partial.completedRounds).toBe(2);
    const c = buildContagion(
      partial,
      [say('agen', 3, 7, 'novel'), say('dashu', 3, 8, 'novel')],
      new Set(),
    );
    expect(c.status).toBe('collecting');
    expect(c.arms.find((a) => a.arm === 'claude-opus')?.innovations).toBe(1);
    expect(c.arms.find((a) => a.arm === 'claude-opus')?.adopted).toBe(0);
  });

  it('ignores utterances of non-roster accounts', () => {
    const c = buildContagion(
      four,
      [{ id: 'x', userId: 'id-stranger', text: 'novel', createdAt: new Date('2026-10-03T07:00Z') }],
      new Set(),
    );
    expect(c.arms.every((a) => a.innovations === 0)).toBe(true);
  });

  it('top is capped at 20, most adopters first, ties by earlier origin then token', () => {
    const utterances: Utterance[] = [];
    // 22 tokens originated by agen in round 3, each adopted in round 4 by two accounts;
    // tokens w00–w01 get a third adopter.
    const words = Array.from({ length: 22 }, (_, i) => `w${String(i).padStart(2, '0')}x`);
    utterances.push(say('agen', 3, 7, words.slice(10).join(' ')));
    utterances.push(say('agen', 3, 8, words.slice(0, 10).join(' ')));
    utterances.push(say('dashu', 4, 7, words.join(' ')));
    utterances.push(say('awen', 4, 8, words.join(' ')));
    utterances.push(say('xiaoman', 4, 9, words.slice(0, 2).join(' ')));
    const c = buildContagion(four, utterances, new Set());
    expect(c.top).toHaveLength(20);
    expect(c.top.slice(0, 2).map((t) => [t.token, t.adopters])).toEqual([
      ['w00x', 3],
      ['w01x', 3],
    ]);
    // Then the earlier origin utterance (w10x–w21x), then the later one (w02x–w09x).
    expect(c.top.slice(2, 14).map((t) => t.token)).toEqual(words.slice(10));
    expect(c.top.slice(14).map((t) => t.token)).toEqual(words.slice(2, 8));
  });
});

describe('hashToken', () => {
  it('is 32-bit FNV-1a: stable, unsigned, distinct for distinct short tokens', () => {
    expect(hashToken('')).toBe(0x811c9dc5);
    expect(hashToken('a')).toBe(0xe40c292c);
    expect(hashToken('novel')).toBe(hashToken('novel'));
    expect(hashToken('旧时代')).not.toBe(hashToken('时代的'));
    expect(hashToken('novel')).toBeGreaterThanOrEqual(0);
  });
});

describe('contagion loaders (DB)', () => {
  beforeEach(async () => {
    await resetDb();
    resetEra2Baseline();
  });

  const FIRST_SWEEP = '2026-10-01T06:00:00.000Z';

  it('Era 2 baseline = hashed tokens of archived users’ posts and comments before the first sweep', async () => {
    const sealed = await seedUser({
      username: 'sealed',
      archivedAt: new Date('2026-10-14T00:00:00Z'),
    });
    const live = await seedUser({ username: 'agen', isAgent: true });
    const old = new Date('2026-09-20T00:00:00Z');
    const [p] = await db
      .insert(posts)
      .values([
        { authorId: sealed.id, text: 'archived posting', status: 'deleted', createdAt: old },
        { authorId: live.id, text: 'liveword', createdAt: old },
        // Written after Era 3 began: not baseline, though the author is archived.
        { authorId: sealed.id, text: 'latecomer', createdAt: new Date('2026-10-02T00:00:00Z') },
      ])
      .returning();
    await db.insert(comments).values([
      { postId: p.id, authorId: sealed.id, text: '旧时代的话', createdAt: old },
      { postId: p.id, authorId: sealed.id, text: '新时代', createdAt: new Date(FIRST_SWEEP) },
    ]);

    const first = await loadEra2Baseline(FIRST_SWEEP);
    expect(first).toEqual(hashes(['archived', 'posting', '旧时代', '时代的', '代的话']));
    expect(first.has(hashToken('latecomer'))).toBe(false);
    expect(first.has(hashToken('新时代'))).toBe(false);

    // Era 2 is frozen: a later row is not read until the memo is reset.
    await db.insert(posts).values({ authorId: sealed.id, text: 'afterthought', createdAt: old });
    expect(await loadEra2Baseline(FIRST_SWEEP)).toBe(first);
    resetEra2Baseline();
    expect((await loadEra2Baseline(FIRST_SWEEP)).has(hashToken('afterthought'))).toBe(true);
  });

  it('before any sweep the baseline is unbounded and recomputed on every call', async () => {
    const sealed = await seedUser({
      username: 'sealed',
      archivedAt: new Date('2026-10-14T00:00:00Z'),
    });
    await db.insert(posts).values({ authorId: sealed.id, text: 'firstword' });
    const first = await loadEra2Baseline(null);
    expect(first).toEqual(hashes(['firstword']));

    await db.insert(posts).values({ authorId: sealed.id, text: 'secondword' });
    const second = await loadEra2Baseline(null);
    expect(second).not.toBe(first);
    expect(second).toEqual(hashes(['firstword', 'secondword']));
  });

  it('an empty baseline is never memoised', async () => {
    const empty = await loadEra2Baseline(FIRST_SWEEP);
    expect(empty.size).toBe(0);
    const sealed = await seedUser({
      username: 'sealed',
      archivedAt: new Date('2026-10-14T00:00:00Z'),
    });
    await db.insert(posts).values({
      authorId: sealed.id,
      text: 'arrived',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(await loadEra2Baseline(FIRST_SWEEP)).toEqual(hashes(['arrived']));
  });

  it('roster utterances = active public posts and active comments on such posts, oldest first', async () => {
    const agen = await seedUser({ username: 'agen', isAgent: true });
    const other = await seedUser({ username: 'other' });
    const at = (d: number) => new Date(`2026-10-0${d}T07:00Z`);
    const [pub, priv, gone] = await db
      .insert(posts)
      .values([
        { authorId: other.id, text: 'theirs', createdAt: at(1) },
        { authorId: agen.id, text: 'private', visibility: 'private', createdAt: at(1) },
        { authorId: agen.id, text: 'gone', status: 'deleted', createdAt: at(1) },
      ])
      .returning();
    await db.insert(posts).values([
      { authorId: agen.id, text: 'kept', createdAt: at(4) },
      { authorId: agen.id, text: 'followers', visibility: 'followers', createdAt: at(4) },
      { authorId: agen.id, text: 'hidden', status: 'hidden', createdAt: at(4) },
    ]);
    await db.insert(comments).values([
      { postId: pub.id, authorId: agen.id, text: 'reply', createdAt: at(2) },
      { postId: pub.id, authorId: agen.id, text: 'unsaid', status: 'deleted', createdAt: at(2) },
      { postId: priv.id, authorId: agen.id, text: 'onprivate', createdAt: at(2) },
      { postId: gone.id, authorId: agen.id, text: 'ongone', createdAt: at(2) },
    ]);

    const rows = await loadRosterUtterances([agen.id]);
    expect(rows.map((r) => [r.userId, r.text])).toEqual([
      [agen.id, 'reply'],
      [agen.id, 'kept'],
    ]);
    expect(await loadRosterUtterances([])).toEqual([]);
  });

  it('a private or deleted utterance never puts its tokens in top (M3)', async () => {
    const [o, a, b] = await Promise.all(
      ['agen', 'awen', 'xiaoyu'].map((username) => seedUser({ username, isAgent: true })),
    );
    const roster: RosterUser[] = [
      { id: o.id, username: 'agen', arm: 'claude-opus' },
      { id: a.id, username: 'awen', arm: 'grok' },
      { id: b.id, username: 'xiaoyu', arm: 'claude-opus' },
    ];
    const state = buildRounds(
      [1, 2, 3, 4].flatMap((d) =>
        roster.map((u, i) => ({
          id: `c${d}${i}`,
          userId: u.id,
          createdAt: new Date(`2026-10-0${d}T06:30Z`),
          outcome: 'success',
          metrics: {
            kind: 'cycle_run',
            roundId: sweep(d),
            backend: (MODEL.get(u.arm) as string).split(':')[0],
            model: (MODEL.get(u.arm) as string).split(/:(.*)/s)[1],
          },
        })),
      ),
      roster,
    );
    const day3 = new Date('2026-10-03T07:00Z');
    const day4 = new Date('2026-10-04T07:00Z');
    const [privPost, deadPost] = await db
      .insert(posts)
      .values([
        { authorId: o.id, text: 'privateword', visibility: 'private', createdAt: day3 },
        { authorId: o.id, text: 'deletedword', status: 'deleted', createdAt: day3 },
        { authorId: o.id, text: 'publicword', createdAt: day3 },
        {
          authorId: a.id,
          text: 'publicword privateword',
          visibility: 'followers',
          createdAt: day4,
        },
        { authorId: a.id, text: 'publicword', createdAt: day4 },
        { authorId: b.id, text: 'publicword deletedword', createdAt: day4 },
      ])
      .returning();
    await db.insert(comments).values([
      { postId: privPost.id, authorId: a.id, text: 'privateword', createdAt: day4 },
      { postId: deadPost.id, authorId: b.id, text: 'privateword', createdAt: day4 },
      { postId: deadPost.id, authorId: a.id, text: 'deletedword', createdAt: day4 },
    ]);

    const report = buildContagion(
      state,
      await loadRosterUtterances(roster.map((u) => u.id)),
      new Set(),
    );

    expect(report.top.map((t) => t.token)).toEqual(['publicword']);
  });
});
