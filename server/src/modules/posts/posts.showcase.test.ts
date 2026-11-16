import { describe, expect, it } from 'vitest';
import type { PostRow } from '../../lib/dto';
import {
  SHOWCASE,
  composeShowcase,
  scoreArchive,
  scoreRecent,
  tieredShuffle,
  type ShowcaseCandidate,
} from './posts.showcase';

let seq = 0;
function row(over: Partial<PostRow> = {}): PostRow {
  seq += 1;
  return {
    id: `p${seq}`,
    authorId: `a${seq}`,
    text: '罗勒掐顶之后侧芽会更快。',
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    images: [],
    createdAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  } as unknown as PostRow;
}

const cand = (post: PostRow, score = 1): ShowcaseCandidate => ({ post, score });
const CLOCK = '周四傍晚六点，今天的新闻标题说……';
const noShuffle = () => 0.999;

describe('composeShowcase', () => {
  it('alternates recent and archive posts, recent first', () => {
    const recent = [row({ id: 'r1' }), row({ id: 'r2' })].map((p) => cand(p));
    const archive = [row({ id: 'h1' }), row({ id: 'h2' })].map((p) => cand(p));

    const ids = composeShowcase(recent, archive, noShuffle).map((p) => p.id);
    expect(ids).toEqual(['r1', 'h1', 'r2', 'h2']);
  });

  it('caps clock openings while other posts can fill the page', () => {
    const recent = Array.from({ length: 30 }, () => cand(row({ text: CLOCK })));
    const archive = Array.from({ length: 30 }, () => cand(row()));

    const out = composeShowcase(recent, archive);
    expect(out).toHaveLength(SHOWCASE.pageSize);
    const clock = out.filter((p) => p.text === CLOCK).length;
    expect(clock).toBe(SHOWCASE.clockOpenings);
  });

  it('relaxes the clock cap rather than return a short wall', () => {
    const recent = Array.from({ length: 10 }, () => cand(row({ text: CLOCK })));

    const out = composeShowcase(recent, []);
    expect(out).toHaveLength(10);
  });

  it('keeps at most two posts per author across both pools', () => {
    const recent = [cand(row({ authorId: 'same' })), cand(row({ authorId: 'same' }))];
    const archive = [cand(row({ authorId: 'same' })), cand(row({ authorId: 'other' }))];

    const out = composeShowcase(recent, archive);
    expect(out.filter((p) => p.authorId === 'same')).toHaveLength(2);
    expect(out.some((p) => p.authorId === 'other')).toBe(true);
  });

  it('keeps the strongest posts in the first third of each pool', () => {
    const recent = Array.from({ length: 9 }, (_, i) => cand(row({ id: `r${i}` }), 9 - i));

    const out = composeShowcase(recent, []);
    expect(
      out
        .slice(0, 3)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['r0', 'r1', 'r2']);
  });
});

describe('scores', () => {
  it('lets an archive post compete on engagement alone', () => {
    const old = row({ likeCount: 10, createdAt: new Date('2026-05-01T00:00:00Z') });
    const older = row({ likeCount: 10, createdAt: new Date('2026-04-01T00:00:00Z') });
    expect(scoreArchive(old)).toBe(scoreArchive(older));
  });

  it('decays recent posts with age and rewards images', () => {
    const now = new Date('2026-11-10T00:00:00Z').getTime();
    const fresh = row({ createdAt: new Date('2026-11-09T00:00:00Z') });
    const stale = row({ createdAt: new Date('2026-10-20T00:00:00Z') });
    const pictured = row({
      createdAt: new Date('2026-11-09T00:00:00Z'),
      images: [{ url: 'x' }] as unknown as PostRow['images'],
    });
    expect(scoreRecent(fresh, now)).toBeGreaterThan(scoreRecent(stale, now));
    expect(scoreRecent(pictured, now)).toBeGreaterThan(scoreRecent(fresh, now));
  });
});

describe('tieredShuffle', () => {
  it('never moves an item out of its third', () => {
    const ranked = Array.from({ length: 12 }, (_, i) => i);
    const out = tieredShuffle(ranked);
    expect(out.slice(0, 4).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(out.slice(8).sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
  });

  it('handles an empty list', () => {
    expect(tieredShuffle([])).toEqual([]);
  });
});
