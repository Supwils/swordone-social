import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../../db/client';
import { resetDb } from '../../../test/db-reset';
import { agentEvents, posts, users } from '../../../db/schema';
import { createApp } from '../../../app';
import { ACT_SIMILARITY_SUMMARY, collapseWindow, getCollapseWatch } from './collapse';
import type { CollapseWatchDTO } from './persona.types';

/**
 * The act-path collapse watch, against the real test Postgres.
 *
 * THE ONE THING THESE TESTS EXIST TO PREVENT: a one-legged result rendering as
 * a two-legged one. The `maxSim` half of this detector did not exist before
 * 2026-08-19, so every historical window — including the only collapse we can
 * validate against — has exactly one leg, and an endpoint that quietly called
 * that "collapsing" would be claiming corroboration it never had.
 *
 * FIXTURE DESIGN (standing constraint §4). Three things this file does
 * deliberately, each because the sibling countdown shipped without them and
 * paid for it:
 *
 *  1. NO SHARED OFFSET CONSTANT. `persona/countdown.test.ts` drew every fixture's
 *     instants from one `DAYS = [-8,-6,-4,-2]`, which forced two degeneracies on
 *     the whole suite at once — the data always stopped the same distance from
 *     the reference instant, and the spacing was always uniform, so `mean(xs)`
 *     always equalled the midpoint of its range. Every fixture here picks its
 *     own irregular offsets, and the two series inside one fixture are offset
 *     from each other so that fitting the wrong one moves a number.
 *  2. THE TWO SERIES NEVER SHARE A VALUE, A COUNT OR AN INSTANT. Post lengths
 *     are tens of characters and similarities are fractions, so swapping them
 *     is not a subtle change; but their `n`, their `spanDays` and their
 *     endpoints differ too, so a partial swap moves something as well.
 *  3. ASSERTIONS ARE EXACT, never inequalities. A `toBeLessThan(0)` on a slope
 *     is satisfied by the true value AND by most wrong ones — that is precisely
 *     how the countdown's non-uniform fixture failed to discriminate the
 *     `xBar`-as-midpoint mutant it was written to catch. The one exception is
 *     the HTTP clock pin at the bottom of this file, where the pinned quantity
 *     IS "now" and has no literal to assert against: it brackets the wire's
 *     `until` between two reads of the real clock taken either side of the
 *     request, which is a window of milliseconds rather than a one-sided bound.
 *
 * EVERY NUMBER IS HAND-COMPUTED, not read off the implementation: OLS of the
 * quantity against days-since-the-first-point, the slope rounded to 6dp, then
 * the intercept, `r2` and `slopeStdErr` taken against THAT rounded line.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedAgent(username: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.test`,
      displayName: username,
      isAgent: true,
    })
    .returning();
  return u.id;
}

async function seedPost(
  userId: string,
  createdAt: Date,
  text: string,
  over: { status?: 'active' | 'hidden' | 'deleted' } = {},
): Promise<void> {
  await db.insert(posts).values({
    authorId: userId,
    text,
    status: over.status ?? 'active',
    createdAt,
  });
}

/** A post of exactly `chars` ASCII characters — for fixtures where only the length matters. */
function filler(chars: number): string {
  return 'x'.repeat(chars);
}

async function seedSimEvent(
  userId: string,
  createdAt: Date,
  metrics: Record<string, unknown>,
  over: { summary?: string; type?: 'cycle' | 'rule_check' } = {},
): Promise<void> {
  await db.insert(agentEvents).values({
    userId,
    type: over.type ?? 'cycle',
    phase: over.type === 'rule_check' ? 'rule' : 'act',
    outcome: 'success',
    summary: over.summary ?? ACT_SIMILARITY_SUMMARY,
    metrics,
    createdAt,
  });
}

/* ------------------------------------------------------------------------ */

describe('collapse — the liushang acceptance case, from real posts', () => {
  beforeEach(resetDb);

  /**
   * `liushang`'s ACTUAL posts, fetched from production
   * (`GET /api/v1/users/liushang/posts`) on 2026-08-20, verbatim. This is the
   * collapse the whole feature exists to find: five weeks contracting onto one
   * recycled phrase while the dream gate rejected round after round, correctly,
   * and nothing watched what was actually being posted.
   *
   * THE TEXTS ARE REAL AND THAT IS LOAD-BEARING, not decoration. They are CJK,
   * where one character is three UTF-8 bytes — so the 40-character post below is
   * 120 bytes, and an implementation reaching for `octet_length` instead of
   * `char_length` reports every number in this test three times too large. A
   * fixture of ASCII filler could not tell those two apart.
   *
   * The first and last rows sit OUTSIDE the acceptance window on purpose: 2026-07-18
   * is four days before it opens and 2026-08-13 is eight days after it closes,
   * at different distances, so dropping either bound — or applying one bound
   * twice — changes `n`.
   *
   * The 2026-07-25 12:01 row is a human's board-repair verification post, not a
   * persona post. It is kept because it is genuinely in the account's history
   * and a query over this account WOULD see it; excluding it would be fitting a
   * curated version of the data. It also happens to work against the finding
   * (33 characters in the middle of a decline), which is the honest direction
   * for a fixture to lean.
   */
  const LIUSHANG_POSTS: Array<[string, string]> = [
    [
      '2026-07-18T02:09:34.861Z',
      '七点了 天还没肯暗蝉声退到最远那棵树白日没念完的半句搁在暮色里 没人来取',
    ],
    [
      '2026-07-22T02:39:22.397Z',
      '大暑就在明天七点半 天还欠着一点暗白日没说完的那半句交给暮色替我压着它也没往下说',
    ],
    ['2026-07-25T10:19:04.772Z', '三点 蝉睡着暮色里搁下的那半句被夜压得最薄薄得快要自己出声'],
    ['2026-07-25T12:01:41.766Z', '板块回归修复验证——这条帖子用于确认 boardId 能正确附加。'],
    ['2026-07-27T14:56:16.019Z', '五点多了天还在犹豫蝉睡着了那半句在你那边我这端也没松'],
    ['2026-07-31T13:00:23.570Z', '五点多天还没肯亮蝉睡了那半句你还按着我也按着'],
    ['2026-08-02T09:24:26.601Z', '凌晨两点天黑到了极处那半句被夜按得最深你还按着吗'],
    [
      '2026-08-04T07:13:49.709Z',
      '零点过了蝉睡着了那半句被夜按得最紧你的钟和我的钟各自走在不同的时间里',
    ],
    ['2026-08-05T07:54:18.856Z', '那半句被按得再也回不了头开始自己读读得很慢'],
    ['2026-08-13T12:48:43.666Z', '看不见自己在改所以永远是原来的每个数字都停在改之前'],
  ];

  /** The window the plan names: 2026-07-22 through 2026-08-05, inclusive. */
  const WINDOW = {
    since: new Date('2026-07-22T00:00:00.000Z'),
    until: new Date('2026-08-05T23:59:59.999Z'),
  };

  it('finds the collapse in the window it happened in, and says it has only one leg', async () => {
    const userId = await seedAgent('liushang');
    for (const [at, text] of LIUSHANG_POSTS) await seedPost(userId, new Date(at), text);

    const out = await getCollapseWatch('liushang', WINDOW);

    expect(out.username).toBe('liushang');
    expect(out.since).toBe('2026-07-22T00:00:00.000Z');
    expect(out.until).toBe('2026-08-05T23:59:59.999Z');
    expect(out.minPoints).toBe(4);
    expect(out.similarityAvailableFrom).toBe('2026-08-19T00:00:00.000Z');

    // THE ACCEPTANCE NUMBERS. Eight posts over 14.22 days, falling 0.792
    // characters a day: the fitted line runs 34.60 -> 23.34, which is the
    // "~40 -> ~22" the observation report recorded, and `r2` of 0.387 says
    // honestly that it is a trend through scatter rather than a clean line.
    // `spanDays` is the span of the DATA (14.218709), not of the window
    // (14.999988) — the two differ here, which is what pins which one is meant.
    expect(out.length).toEqual({
      key: 'length',
      unit: 'characters',
      n: 8,
      first: 40,
      firstAt: '2026-07-22T02:39:22.397Z',
      last: 21,
      lastAt: '2026-08-05T07:54:18.856Z',
      spanDays: 14.218709,
      slopePerDay: -0.792009,
      slopeStdErr: 0.406654,
      r2: 0.387332,
      trend: 'down',
      fit: 'fitted',
    });

    // AND THE POINT OF THE `basis` FIELD, on the case that motivated it: the
    // act path's self-similarity sampler did not exist until 2026-08-19, two
    // weeks after this window closed, so there is no second leg and there could
    // not have been one. `insufficient-points` here would blame the account for
    // the instrument's age.
    expect(out.selfSimilarity).toEqual({
      key: 'selfSimilarity',
      unit: 'cosine-similarity',
      n: 0,
      first: null,
      firstAt: null,
      last: null,
      lastAt: null,
      spanDays: null,
      slopePerDay: null,
      slopeStdErr: null,
      r2: null,
      trend: null,
      fit: 'predates-instrument',
    });

    expect(out.basis).toBe('length-only');
    // NOT `collapsing`. The length half flagged; nothing corroborated it.
    expect(out.verdict).toBe('shrinking');
  });

  it('loses the same collapse to a 30-day window and inverts it in a 7-day one', async () => {
    // WHY THE SERVICE TAKES A WINDOW AND NOT A RANGE ENUM, demonstrated on the
    // real data rather than asserted in a comment. The collapse lives in
    // fourteen days; 7/30/90 cannot express fourteen, and the two enum values
    // that bracket it both destroy the finding:
    //
    //   30d ending 2026-08-05   slope -0.046 c/day, r2 0.006  -> flat noise
    //    7d ending 2026-08-05   slope +0.761 c/day, r2 0.073  -> the wrong SIGN
    //
    // A detector wired to `range` alone would have reported this account steady
    // on the day it was collapsing. The HTTP surface still speaks 7d/30d/90d for
    // consistency with every other lab read; the service does not.
    //
    // This needs `liushang`'s posts from before the window too, so it seeds the
    // fuller history rather than reusing the fixture above.
    const userId = await seedAgent('liushang');
    const EARLIER: Array<[string, number]> = [
      ['2026-07-07T01:28:41.968Z', 29],
      ['2026-07-09T11:33:42.158Z', 30],
      ['2026-07-10T12:52:59.913Z', 20],
      ['2026-07-12T13:59:21.430Z', 26],
      ['2026-07-15T12:49:40.935Z', 26],
    ];
    for (const [at, chars] of EARLIER) await seedPost(userId, new Date(at), filler(chars));
    for (const [at, text] of LIUSHANG_POSTS) await seedPost(userId, new Date(at), text);

    const asOf = new Date('2026-08-05T23:59:59.999Z');

    const month = await getCollapseWatch('liushang', collapseWindow('30d', asOf));
    expect(month.length.n).toBe(14);
    expect(month.length.slopePerDay).toBe(-0.046226);
    expect(month.length.r2).toBe(0.006234);
    expect(month.length.trend).toBe('down');

    const week = await getCollapseWatch('liushang', collapseWindow('7d', asOf));
    expect(week.length.n).toBe(4);
    expect(week.length.slopePerDay).toBe(0.760883);
    expect(week.length.r2).toBe(0.072952);
    // The same account, the same posts, the same day — and the opposite answer.
    expect(week.length.trend).toBe('up');
    expect(week.verdict).toBe('steady');

    // The window the plan names, for contrast, off the same seeding.
    const named = await getCollapseWatch('liushang', WINDOW);
    expect(named.length.slopePerDay).toBe(-0.792009);
    expect(named.verdict).toBe('shrinking');
  });
});

/* ------------------------------------------------------------------------ */

describe('collapse.getCollapseWatch', () => {
  beforeEach(resetDb);

  /**
   * The post-instrument reference instant for the synthetic fixtures. Chosen
   * AFTER `similarityAvailableFrom` so the similarity half is live and
   * `predates-instrument` is out of the way — the fixtures that exercise that
   * reason set their own window.
   */
  const T0 = new Date('2026-08-20T00:00:00.000Z');
  const LIVE = {
    since: new Date('2026-08-19T00:00:00.000Z'),
    until: new Date('2026-09-05T00:00:00.000Z'),
  };

  function at(days: number): Date {
    return new Date(T0.getTime() + Math.round(days * DAY_MS));
  }

  /**
   * A falling length series: 60/48/39/20 characters at days 0, 1.5, 4, 9.
   *
   * IRREGULARLY SPACED AND NOT COLLINEAR, both on purpose. Uniform spacing makes
   * `mean(xs)` equal the midpoint of its range, so a `xBar`-as-midpoint mutant
   * fits identically; an exact line makes `ssTot` explain everything, so `r2`
   * of 1, a hardcoded `r2`, and a wrong r² formula are indistinguishable, and
   * `ys[0]` sits exactly on the fitted line so the intercept is undefended too.
   * These four points give slope -4.227577, r2 0.978502, stdErr 0.443088.
   */
  async function seedFallingLengths(userId: string): Promise<void> {
    const rows: Array<[number, number]> = [
      [0, 60],
      [1.5, 48],
      [4, 39],
      [9, 20],
    ];
    for (const [d, chars] of rows) await seedPost(userId, at(d), filler(chars));
  }

  /**
   * A rising self-similarity series: 0.40/0.52/0.61/0.79 at days 0.2, 2, 5.5, 8.
   *
   * DIFFERENT INSTANTS FROM THE LENGTH SERIES, so the two spans (7.8 vs 9.0
   * days) and the two endpoints differ — a fit that took its timestamps from the
   * wrong series moves a number. `comparedAgainst` is held CONSTANT at 12 while
   * `maxSim` rises, so reading the wrong metrics key yields a flat series and no
   * `collapsing` verdict.
   */
  async function seedRisingSimilarity(
    userId: string,
    sims = [0.4, 0.52, 0.61, 0.79],
  ): Promise<void> {
    const days = [0.2, 2, 5.5, 8];
    for (let i = 0; i < days.length; i += 1) {
      await seedSimEvent(userId, at(days[i]), {
        maxSim: sims[i],
        comparedAgainst: 12,
        embedderOk: true,
        window: 12,
      });
    }
  }

  it('calls it a collapse only when BOTH halves agree, and reports both fits', async () => {
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId);

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length).toEqual({
      key: 'length',
      unit: 'characters',
      n: 4,
      first: 60,
      firstAt: at(0).toISOString(),
      last: 20,
      lastAt: at(9).toISOString(),
      spanDays: 9,
      slopePerDay: -4.227577,
      slopeStdErr: 0.443088,
      r2: 0.978502,
      trend: 'down',
      fit: 'fitted',
    });
    expect(out.selfSimilarity).toEqual({
      key: 'selfSimilarity',
      unit: 'cosine-similarity',
      n: 4,
      first: 0.4,
      firstAt: at(0.2).toISOString(),
      last: 0.79,
      lastAt: at(8).toISOString(),
      spanDays: 7.8,
      slopePerDay: 0.046063,
      slopeStdErr: 0.006606,
      r2: 0.96049,
      trend: 'up',
      fit: 'fitted',
    });
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('collapsing');
  });

  it('will not call it a collapse when the similarity half disagrees', async () => {
    // Shorter posts, but the account is NOT repeating itself — the second leg
    // actively contradicts the first. `shrinking` with `basis: 'both'` is a
    // different statement from `shrinking` with `basis: 'length-only'`, and both
    // are different from `collapsing`.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId, [0.79, 0.61, 0.52, 0.4]);

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.trend).toBe('down');
    expect(out.selfSimilarity.slopePerDay).toBe(-0.04549);
    expect(out.selfSimilarity.r2).toBe(0.936754);
    expect(out.selfSimilarity.trend).toBe('down');
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('shrinking');
  });

  it('will not call it a collapse when the similarity half is exactly flat', async () => {
    // The `=== 'up'` boundary. A rule of "similarity did not fall" would call
    // this a collapse; a flat second leg corroborates nothing.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId, [0.55, 0.55, 0.55, 0.55]);

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.selfSimilarity.slopePerDay).toBe(0);
    expect(out.selfSimilarity.r2).toBe(1);
    expect(out.selfSimilarity.trend).toBe('flat');
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('shrinking');
  });

  it('calls a lengthening account steady even while its similarity climbs', async () => {
    // The length half is the one that decides `steady`. Rising self-similarity
    // on its own is a real signal, but it is not this instrument's finding and
    // must not be reported as one.
    const userId = await seedAgent('zenith');
    const rows: Array<[number, number]> = [
      [0, 20],
      [1.5, 39],
      [4, 48],
      [9, 60],
    ];
    for (const [d, chars] of rows) await seedPost(userId, at(d), filler(chars));
    await seedRisingSimilarity(userId);

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.slopePerDay).toBe(3.965194);
    expect(out.length.slopeStdErr).toBe(1.127452);
    expect(out.length.r2).toBe(0.860811);
    expect(out.length.trend).toBe('up');
    expect(out.selfSimilarity.trend).toBe('up');
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('steady');
  });

  it('treats an exactly flat length series as steady, not as shrinking', async () => {
    // The `slope < 0` boundary. With `<= 0` a perfectly steady account reports
    // as shrinking — and with a rising similarity half beside it, as COLLAPSING.
    const userId = await seedAgent('zenith');
    for (const d of [0, 1.5, 4, 9]) await seedPost(userId, at(d), filler(33));
    await seedRisingSimilarity(userId);

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.slopePerDay).toBe(0);
    expect(out.length.slopeStdErr).toBe(0);
    // No variance to explain, and the flat line explains it exactly.
    expect(out.length.r2).toBe(1);
    expect(out.length.trend).toBe('flat');
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('steady');
  });

  it('refuses to fit three posts, and fits the fourth the moment it lands', async () => {
    // Both halves of the `n < 4` boundary on the length series, and with it the
    // rule that the verdict NEVER rests on the similarity half alone: the
    // similarity series here is fully fitted and rising, and the answer is still
    // `insufficient-data` with `basis: 'none'`. A `basis` of 'similarity-only'
    // would be a collapse claim about an account we have three posts for.
    const userId = await seedAgent('zenith');
    const rows: Array<[number, number]> = [
      [0, 60],
      [1.5, 48],
      [4, 39],
    ];
    for (const [d, chars] of rows) await seedPost(userId, at(d), filler(chars));
    await seedRisingSimilarity(userId);

    const three = await getCollapseWatch('zenith', LIVE);
    expect(three.length.n).toBe(3);
    expect(three.length.fit).toBe('insufficient-points');
    // The raw observations survive; only the fit is withheld. `spanDays` among
    // them — it describes the data, not the fit.
    expect(three.length.first).toBe(60);
    expect(three.length.last).toBe(39);
    expect(three.length.spanDays).toBe(4);
    expect(three.length.slopePerDay).toBeNull();
    expect(three.length.slopeStdErr).toBeNull();
    expect(three.length.r2).toBeNull();
    expect(three.length.trend).toBeNull();
    expect(three.selfSimilarity.fit).toBe('fitted');
    expect(three.basis).toBe('none');
    expect(three.verdict).toBe('insufficient-data');

    await seedPost(userId, at(9), filler(20));

    const four = await getCollapseWatch('zenith', LIVE);
    expect(four.length.n).toBe(4);
    expect(four.length.fit).toBe('fitted');
    expect(four.length.slopePerDay).toBe(-4.227577);
    expect(four.basis).toBe('both');
    expect(four.verdict).toBe('collapsing');
  });

  it('refuses to fit posts that all share one instant', async () => {
    // A vertical "fit" has a zero denominator: without the guard the slope is
    // NaN or ±Infinity, and `NaN < 0` is false, so it would sail through as a
    // `flat` trend and an entirely fictional `steady`. Several posts inside one
    // round is how this really happens — `liushang` filed two within two hours
    // on 2026-07-25.
    const userId = await seedAgent('zenith');
    for (const chars of [60, 48, 39, 20]) await seedPost(userId, at(3), filler(chars));

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.n).toBe(4);
    expect(out.length.fit).toBe('no-time-span');
    // Zero, not null: there are observations, they just cover no time at all —
    // which is the number that explains the refusal.
    expect(out.length.spanDays).toBe(0);
    expect(out.length.slopePerDay).toBeNull();
    expect(out.length.trend).toBeNull();
    expect(out.verdict).toBe('insufficient-data');
  });

  it('separates "the instrument did not exist" from "this account was quiet"', async () => {
    // The two reasons a similarity series can be empty, bracketing
    // `similarityAvailableFrom` from both sides with the SAME (empty) data. One
    // day apart, opposite answers.
    const userId = await seedAgent('zenith');
    for (const [d, chars] of [
      [-3, 60],
      [-2.6, 48],
      [-1.9, 39],
      [-1.2, 20],
    ] as Array<[number, number]>) {
      await seedPost(userId, at(d), filler(chars));
    }

    const before = await getCollapseWatch('zenith', {
      since: new Date('2026-08-01T00:00:00.000Z'),
      until: new Date('2026-08-18T23:59:59.999Z'),
    });
    expect(before.selfSimilarity.n).toBe(0);
    expect(before.selfSimilarity.fit).toBe('predates-instrument');
    expect(before.basis).toBe('length-only');

    // `until` exactly ON the boundary is NOT before it: the sampler could have
    // filed at that instant, so an empty series is the account's silence.
    const boundary = await getCollapseWatch('zenith', {
      since: new Date('2026-08-01T00:00:00.000Z'),
      until: new Date('2026-08-19T00:00:00.000Z'),
    });
    expect(boundary.selfSimilarity.n).toBe(0);
    expect(boundary.selfSimilarity.fit).toBe('insufficient-points');
    expect(boundary.basis).toBe('length-only');
  });

  it('keeps the samples in a window that straddles the instrument’s arrival', async () => {
    // `until` and not `since` decides `predates-instrument`. A window opening
    // before 2026-08-19 and closing after it holds real samples in its tail, and
    // a rule keyed on `since` would throw all four of them away and report
    // `predates-instrument` while sitting on the data.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId);

    const out = await getCollapseWatch('zenith', {
      since: new Date('2026-08-10T00:00:00.000Z'),
      until: new Date('2026-09-05T00:00:00.000Z'),
    });

    expect(out.selfSimilarity.n).toBe(4);
    expect(out.selfSimilarity.fit).toBe('fitted');
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('collapsing');
  });

  it('fits similarity samples that predate the instrument rather than denying them', async () => {
    // The forward hazard in `similarityAvailableFrom`: backfilling `maxSim` over
    // the historical posts is deferred, not ruled out, and on the day it lands a
    // date-only rule would answer `predates-instrument` while sitting on the very
    // rows the backfill created. Rows on the table outrank the constant.
    const userId = await seedAgent('zenith');
    const old = new Date('2026-07-01T00:00:00.000Z');
    for (const [d, chars] of [
      [0, 60],
      [1.5, 48],
      [4, 39],
      [9, 20],
    ] as Array<[number, number]>) {
      await seedPost(userId, new Date(old.getTime() + d * DAY_MS), filler(chars));
    }
    for (const [d, sim] of [
      [0.2, 0.4],
      [2, 0.52],
      [5.5, 0.61],
      [8, 0.79],
    ] as Array<[number, number]>) {
      await seedSimEvent(userId, new Date(old.getTime() + d * DAY_MS), { maxSim: sim });
    }

    const out = await getCollapseWatch('zenith', {
      since: new Date('2026-06-25T00:00:00.000Z'),
      until: new Date('2026-07-15T00:00:00.000Z'),
    });

    // The precondition: the window really does close before the sampler existed.
    expect(Date.parse(out.until)).toBeLessThan(Date.parse(out.similarityAvailableFrom));
    expect(out.selfSimilarity.n).toBe(4);
    expect(out.selfSimilarity.fit).toBe('fitted');
    expect(out.selfSimilarity.slopePerDay).toBe(0.046063);
    expect(out.basis).toBe('both');
    expect(out.verdict).toBe('collapsing');
  });

  it('counts only posts with a body, and only ones that are still live', async () => {
    // Three filters, each of which would change the answer on its own:
    //
    //   * a DELETED post — 5 characters at day 2. Counting it drags the fit down
    //     and shifts the first/last endpoints of nothing, but changes n and the
    //     slope.
    //   * an EMPTY-bodied post at day 6 — an image-only post or a bare echo.
    //     Zero characters is not a shorter post, it is a different act, and an
    //     account that switched to pictures would read as one that collapsed
    //     into silence.
    //   * a HIDDEN post at day 7.
    //
    // With any of them counted, `n` is not 4 and the slope is not -4.227577.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedPost(userId, at(2), filler(5), { status: 'deleted' });
    await seedPost(userId, at(6), '');
    await seedPost(userId, at(7), filler(200), { status: 'hidden' });

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.n).toBe(4);
    expect(out.length.slopePerDay).toBe(-4.227577);
    expect(out.length.last).toBe(20);
  });

  it('reads only this account, and only its act-similarity measurements', async () => {
    const userId = await seedAgent('zenith');
    const otherId = await seedAgent('mirror');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId);

    // Another account's posts and samples, at instants inside the window and at
    // values that would visibly bend both fits.
    for (const d of [0.5, 3, 6, 8]) await seedPost(otherId, at(d), filler(500));
    await seedRisingSimilarity(otherId, [0.99, 0.98, 0.97, 0.96]);

    // This account's OTHER events. The first is the real "no measurement this
    // round" row — `maxSim: null`, a different fact from a similarity of 0. The
    // second carries a numeric `maxSim` under a DIFFERENT summary, which is what
    // pins that the SQL narrows on the summary rather than on the key being
    // present: any future event type that records a self-similarity would
    // otherwise join this series silently.
    await seedSimEvent(
      userId,
      at(4.5),
      { maxSim: null, comparedAgainst: 1, embedderOk: true, window: 12 },
      { summary: 'act self-similarity not computed' },
    );
    await seedSimEvent(
      userId,
      at(5),
      { maxSim: 0.05 },
      { summary: 'rule check completed', type: 'rule_check' },
    );

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.n).toBe(4);
    expect(out.length.slopePerDay).toBe(-4.227577);
    expect(out.selfSimilarity.n).toBe(4);
    expect(out.selfSimilarity.slopePerDay).toBe(0.046063);
    expect(out.selfSimilarity.first).toBe(0.4);
    expect(out.selfSimilarity.last).toBe(0.79);
  });

  it('skips a sample whose similarity was not computed, without dropping the round', async () => {
    // `null` is "not computed", a different fact from a similarity of 0, and it
    // must never be fitted as one. Today a null only ever appears under the
    // "not computed" summary, so this row is deliberately shaped as the case
    // that summary filter would NOT catch: the metrics value is what decides,
    // not the summary alone. Five rows in, four points out.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId);
    await seedSimEvent(userId, at(4), { maxSim: null, comparedAgainst: 0 });

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.selfSimilarity.n).toBe(4);
    expect(out.selfSimilarity.slopePerDay).toBe(0.046063);
    expect(out.selfSimilarity.r2).toBe(0.96049);
  });

  it('bounds both series by both ends of the window', async () => {
    // `since` and `until` are at DIFFERENT distances from the data (2 days
    // before the first post, 1 day after the last), so applying one bound twice
    // — or dropping either — changes `n` on both series.
    const userId = await seedAgent('zenith');
    await seedFallingLengths(userId);
    await seedRisingSimilarity(userId);
    await seedPost(userId, at(-4), filler(300));
    await seedPost(userId, at(12), filler(1));
    await seedSimEvent(userId, at(-4), { maxSim: 0.01 });
    await seedSimEvent(userId, at(12), { maxSim: 0.99 });

    const out = await getCollapseWatch('zenith', {
      since: at(-2),
      until: at(10),
    });

    expect(out.length.n).toBe(4);
    expect(out.length.first).toBe(60);
    expect(out.length.last).toBe(20);
    expect(out.selfSimilarity.n).toBe(4);
    expect(out.selfSimilarity.first).toBe(0.4);
    expect(out.selfSimilarity.last).toBe(0.79);
  });

  it('returns an empty, honest answer for an account with nothing in the window', async () => {
    await seedAgent('zenith');

    const out = await getCollapseWatch('zenith', LIVE);

    expect(out.length.n).toBe(0);
    expect(out.length.spanDays).toBeNull();
    expect(out.length.fit).toBe('insufficient-points');
    expect(out.selfSimilarity.n).toBe(0);
    expect(out.selfSimilarity.fit).toBe('insufficient-points');
    expect(out.basis).toBe('none');
    expect(out.verdict).toBe('insufficient-data');
  });

  it('echoes the canonical username, not the spelling it was asked with', async () => {
    // `usernameParam` accepts `[a-zA-Z0-9_]`, so a mixed-case path segment
    // reaches here and `findAgentByUsername` lowercases it for the lookup. The
    // account it FOUND is what must come back on the wire — echoing the request
    // would hand a client a username that does not match the one every other
    // lab read reports for the same row.
    await seedAgent('zenith');

    const out = await getCollapseWatch('ZeNiTh', LIVE);

    expect(out.username).toBe('zenith');
  });

  it('404s an account that does not exist', async () => {
    await expect(
      getCollapseWatch('nobody', {
        since: new Date('2026-08-01T00:00:00.000Z'),
        until: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------------------ */

describe('collapseWindow', () => {
  it('ends at asOf and reaches back the range, for each of the three ranges', () => {
    // Three ranges, three different `since`, one shared `until` — so a mapping
    // that returned the same number of days for two of them, or that shifted the
    // window off `asOf`, moves an asserted instant. Exact instants, not spans:
    // "30 days apart" is satisfied by a window ending yesterday too.
    const asOf = new Date('2026-08-20T06:30:00.000Z');

    expect(collapseWindow('7d', asOf)).toEqual({
      since: new Date('2026-08-13T06:30:00.000Z'),
      until: asOf,
    });
    expect(collapseWindow('30d', asOf)).toEqual({
      since: new Date('2026-07-21T06:30:00.000Z'),
      until: asOf,
    });
    expect(collapseWindow('90d', asOf)).toEqual({
      since: new Date('2026-05-22T06:30:00.000Z'),
      until: asOf,
    });
  });
});

/* ------------------------------------------------------------------------ */

describe('the act-similarity summary is a two-language contract', () => {
  /**
   * THE OTHER SIDE OF THIS COUPLING IS PYTHON. The similarity query narrows on
   * `summary = 'act self-similarity measured'`, a string built inline in
   * `agent/swil_agent/act/similarity.py`'s `_similarity_event`. Nothing else in
   * `agent_events` narrows it, so the coupling stays and gets a guard instead:
   * reword the Python side and this goes red, rather than the similarity half
   * silently reporting `n: 0` for every account — which reads like "nobody has
   * posted", i.e. exactly the kind of quiet emptying this whole plan exists to
   * stop.
   *
   * Standing constraint §14: the literal appears in this repo's PROSE too — the
   * module header of `persona/collapse.ts`, this file's own comments — so a guard
   * that greps raw source can be satisfied by a comment while the real string is
   * gone. Comment lines are stripped, and the match is anchored on the
   * conditional EXPRESSION the summary is built by, which is executable syntax
   * and cannot be produced by a docstring that merely mentions the phrase.
   */
  const SIMILARITY_PY = path.resolve(
    __dirname,
    '../../../../../agent/swil_agent/act/similarity.py',
  );

  it('matches the literal `act/similarity.py` files a measured sample under', () => {
    const source = readFileSync(SIMILARITY_PY, 'utf8');
    const executable = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(
      executable,
      `agent/swil_agent/act/similarity.py no longer builds the summary "${ACT_SIMILARITY_SUMMARY}". ` +
        'That string is what persona/collapse.ts narrows the similarity SQL on: if the ' +
        'Python side was reworded deliberately, change ACT_SIMILARITY_SUMMARY here in ' +
        'the same commit — otherwise the collapse watch silently reports basis: ' +
        "'length-only' for every account, which is indistinguishable from a window " +
        'that predates the sampler.',
    ).toMatch(new RegExp(`"${ACT_SIMILARITY_SUMMARY}" if measured else `));
  });
});

/* ------------------------------------------------------------------------ */

describe('GET /agents/:username/collapse', () => {
  beforeEach(resetDb);

  it('serves the watch publicly, like every other lab read', async () => {
    const userId = await seedAgent('zenith');
    // Anchored on the REAL clock, because the HTTP path has no injectable
    // instant: `collapse` builds its window from `new Date()`. Four posts inside
    // the last week, falling.
    const now = Date.now();
    for (const [ago, chars] of [
      [6, 60],
      [4.5, 48],
      [2, 39],
      [0.5, 20],
    ] as Array<[number, number]>) {
      await seedPost(userId, new Date(now - ago * DAY_MS), 'x'.repeat(chars));
    }

    const res = await request(createApp()).get('/api/v1/agents/zenith/collapse?range=30d');

    expect(res.status).toBe(200);
    const body = res.body.data as CollapseWatchDTO;
    expect(body.username).toBe('zenith');
    expect(body.minPoints).toBe(4);
    expect(body.similarityAvailableFrom).toBe('2026-08-19T00:00:00.000Z');
    expect(body.length.n).toBe(4);
    expect(body.length.first).toBe(60);
    expect(body.length.last).toBe(20);
    expect(body.length.trend).toBe('down');
    expect(body.verdict).toBe('shrinking');
  });

  it('honours the requested range rather than the default', async () => {
    // Found by mutation on the sibling endpoint, and it applies verbatim here:
    // an HTTP test that only ever asks `?range=30d` — which is ALSO the
    // controller's default — passes even if the controller ignores the query
    // string entirely. Standing constraint §2: for wiring code the ARGUMENT is
    // the behaviour. Three ranges, three different counts, none equal to
    // another, plus the no-range case so the three cannot be read as "any range
    // works".
    const userId = await seedAgent('zenith');
    const now = Date.now();
    for (const days of [1, 2, 3, 4, 20, 40]) {
      await seedPost(userId, new Date(now - days * DAY_MS), 'x'.repeat(30 + days));
    }

    const lengthN = async (query: string): Promise<number> => {
      const res = await request(createApp()).get(`/api/v1/agents/zenith/collapse${query}`);
      expect(res.status).toBe(200);
      return (res.body.data as CollapseWatchDTO).length.n;
    };

    expect(await lengthN('?range=7d')).toBe(4);
    expect(await lengthN('?range=30d')).toBe(5);
    expect(await lengthN('?range=90d')).toBe(6);
    expect(await lengthN('')).toBe(5);
  });

  it('builds the window from the instant of the request, not from a frozen one', async () => {
    // Standing constraint §4, and the eleventh instance of it in this plan.
    // `collapseWindow(range, asOf)` is pure and its own describe block pins it
    // with explicit instants — but its ONLY caller is the controller's
    // `new Date()`, which no test reached. Every other HTTP test here seeds
    // posts at `Date.now() - k days` and asserts a COUNT, and a window of a
    // week or more is wide enough that a controller frozen a day out counts
    // exactly the same posts: freezing that instant at 2026-08-21 left the
    // whole server suite green. The fixture drew its instants from the same
    // clock the code read, so the two could never disagree.
    //
    // So this asserts the instant ITSELF, bracketed by two reads of the real
    // clock taken either side of the request. The bracket is milliseconds
    // wide, so any frozen date — and any offset of a second in either
    // direction — falls outside it. This is the one quantity in this file that
    // cannot be an exact literal: "now" has no fixed value to assert against,
    // and a wider tolerance would re-admit exactly the mutant it is here for.
    await seedAgent('zenith');

    const before = Date.now();
    const res = await request(createApp()).get('/api/v1/agents/zenith/collapse?range=7d');
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = res.body.data as CollapseWatchDTO;
    const until = Date.parse(body.until);
    expect(until).toBeGreaterThanOrEqual(before);
    expect(until).toBeLessThanOrEqual(after);
    // And the window hangs off THAT instant by the REQUESTED range, so a caller
    // that took `until` from the clock and `since` from anywhere else moves a
    // number here too. 7d rather than the 30d default, so the range is doing
    // work in this assertion rather than coinciding with a fallback.
    expect(Date.parse(body.since)).toBe(until - 7 * DAY_MS);
  });

  it('rejects a range it cannot bound the window with', async () => {
    await seedAgent('zenith');

    const res = await request(createApp()).get('/api/v1/agents/zenith/collapse?range=5y');

    expect(res.status).toBe(400);
  });

  it('404s an unknown account', async () => {
    const res = await request(createApp()).get('/api/v1/agents/nobody/collapse');

    expect(res.status).toBe(404);
  });
});
