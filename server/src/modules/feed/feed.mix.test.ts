import { describe, expect, it } from 'vitest';
import type { PostRow } from '../../lib/dto';
import { decodeMixCursor, encodeMixCursor, mergeMixPage, type MixCursor } from './feed.mix';

let seq = 0;
function row(text = 'a plain opening'): PostRow {
  seq += 1;
  return { id: `p${seq}`, text } as unknown as PostRow;
}
const CLOCK = '周日傍晚六点十五，我去窗台看了一眼。';
const ID = 'a'.repeat(24);

describe('mergeMixPage', () => {
  it('alternates recent and archive, recent first', () => {
    const r = [row(), row()];
    const a = [row(), row()];
    const page = mergeMixPage(r, a, 4);
    expect(page.items).toEqual([r[0], a[0], r[1], a[1]]);
    expect(page.tookRecent).toBe(r[1]);
    expect(page.tookArchive).toBe(a[1]);
    expect(page.more).toBe(false);
  });

  it('lets the archive go first once the clock budget is spent', () => {
    const r = Array.from({ length: 6 }, () => row(CLOCK));
    const a = Array.from({ length: 6 }, () => row());
    const page = mergeMixPage(r, a, 6); // budget = 2
    expect(page.items.filter((p) => p.text === CLOCK)).toHaveLength(2);
    // A prefix of each stream was taken, so the cursor loses nothing.
    expect(page.tookRecent).toBe(r[1]);
    expect(page.tookArchive).toBe(a[3]);
    expect(page.more).toBe(true);
  });

  it('relaxes the budget when only clock openings are left', () => {
    const r = Array.from({ length: 5 }, () => row(CLOCK));
    const page = mergeMixPage(r, [], 4);
    expect(page.items).toEqual(r.slice(0, 4));
    expect(page.more).toBe(true);
  });

  it('returns an empty last page cleanly', () => {
    const page = mergeMixPage([], [], 20);
    expect(page).toEqual({ items: [], tookRecent: null, tookArchive: null, more: false });
  });
});

describe('mix cursor', () => {
  it('round-trips', () => {
    const c: MixCursor = {
      c: '2026-09-17T00:00:00.000Z',
      r: { s: 1.25, id: ID },
      a: null,
    };
    expect(decodeMixCursor(encodeMixCursor(c))).toEqual(c);
  });

  it.each([
    ['empty', ''],
    ['not base64 JSON', 'nope'],
    ['a member score cursor', Buffer.from(JSON.stringify({ s: 1, id: ID })).toString('base64url')],
    [
      'a bad id',
      Buffer.from(JSON.stringify({ m: 1, c: '2026-09-17', r: { s: 1, id: '../x' } })).toString(
        'base64url',
      ),
    ],
    [
      'a bad cutoff',
      Buffer.from(JSON.stringify({ m: 1, c: 'yesterday', r: null, a: null })).toString('base64url'),
    ],
  ])('reads %s as the first page', (_label, raw) => {
    expect(decodeMixCursor(raw)).toBeNull();
  });
});
