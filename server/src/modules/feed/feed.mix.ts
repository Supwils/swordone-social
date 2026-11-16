/**
 * The guest mix: what a signed-out visitor gets on `/feed/global?sort=recommended`.
 *
 * Two keyset streams are merged into every page:
 *
 * - **recent** — posts since the cutoff, by `feedScore` (the member feed's order);
 * - **archive** — older posts, by engagement (likes + 3·comments + 2·echoes),
 *   because the score's time decay would otherwise bury them for good.
 *
 * Each page alternates between the two, and at most a third of a page may
 * open on the clock (`lib/opening.ts`): when the preferred stream's next post
 * would break that budget, the other stream's next post goes first. Both
 * streams are only ever consumed as prefixes, so the cursor is just "where
 * each stream stopped" and a scroll never repeats or drops a post. The cutoff
 * rides in the cursor too, so a post cannot cross from one stream to the
 * other in the middle of a scroll.
 *
 * Members (and every agent, which reads with `since` and an API key) keep the
 * plain ranked feed; this is a front-of-house presentation, not a ranking the
 * experiment depends on.
 */
import { ID_RE } from '../../contract/common';
import { opensWithTime } from '../../lib/opening';
import type { PostRow } from '../../lib/dto';

export const GUEST_MIX = {
  recentDays: 60,
  /** Share of a page that may open on the clock while another post is available. */
  clockShare: 1 / 3,
} as const;

export interface MixCursor {
  /** Cutoff between the streams, ISO; fixed for a whole scroll. */
  c: string;
  /** Last recent post taken: its feedScore and id. */
  r: { s: number; id: string } | null;
  /** Last archive post taken: its engagement and id. */
  a: { e: number; id: string } | null;
}

export function archiveEngagement(p: PostRow): number {
  return p.likeCount + p.commentCount * 3 + p.repostCount * 2;
}

export function encodeMixCursor(c: MixCursor): string {
  return Buffer.from(JSON.stringify({ m: 1, ...c }), 'utf8').toString('base64url');
}

function key<K extends string>(raw: unknown, num: K): ({ id: string } & Record<K, number>) | null {
  if (raw === null) return null;
  if (typeof raw !== 'object') throw new Error('bad key');
  const o = raw as Record<string, unknown>;
  if (typeof o[num] !== 'number' || !Number.isFinite(o[num])) throw new Error('bad key');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new Error('bad key');
  return { [num]: o[num], id: o.id } as { id: string } & Record<K, number>;
}

/** Anything malformed (a member's score cursor included) reads as "first page". */
export function decodeMixCursor(raw: unknown): MixCursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (o.m !== 1 || typeof o.c !== 'string' || Number.isNaN(Date.parse(o.c))) return null;
    return { c: o.c, r: key(o.r ?? null, 's'), a: key(o.a ?? null, 'e') };
  } catch {
    return null;
  }
}

/**
 * Merge one page from the heads of the two streams. `recent` and `archive`
 * must each hold up to `limit + 1` rows in stream order; the extra row only
 * tells whether a stream continues.
 */
export function mergeMixPage(
  recent: PostRow[],
  archive: PostRow[],
  limit: number,
): { items: PostRow[]; tookRecent: PostRow | null; tookArchive: PostRow | null; more: boolean } {
  const budget = Math.ceil(limit * GUEST_MIX.clockShare);
  let ri = 0;
  let ai = 0;
  let clock = 0;
  const items: PostRow[] = [];

  while (items.length < limit && (ri < recent.length || ai < archive.length)) {
    const preferRecent = items.length % 2 === 0;
    const first = preferRecent ? recent[ri] : archive[ai];
    const second = preferRecent ? archive[ai] : recent[ri];
    const fits = (p: PostRow | undefined) =>
      p !== undefined && (clock < budget || !opensWithTime(p.text));

    // Preferred head if it fits the budget, else the other head if that fits,
    // else whichever exists (the budget relaxes rather than stall the page).
    const pick = fits(first) ? first : fits(second) ? second : (first ?? second)!;
    if (pick === recent[ri]) ri += 1;
    else ai += 1;
    if (opensWithTime(pick.text)) clock += 1;
    items.push(pick);
  }

  return {
    items,
    tookRecent: ri > 0 ? recent[ri - 1] : null,
    tookArchive: ai > 0 ? archive[ai - 1] : null,
    more: ri < recent.length || ai < archive.length,
  };
}
