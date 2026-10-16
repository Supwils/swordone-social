import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DRAFT_TTL_MS, pruneDrafts, useDrafts } from './draft.store';

/**
 * Drafts hold text the user typed but has not posted, so a bug here loses
 * work silently. The store is persisted, which makes cross-key leakage and
 * stale-clear the failure modes worth pinning.
 */
function reset(): void {
  useDrafts.setState({ drafts: {}, ownerId: null });
}

describe('draft.store', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it('returns undefined for a key that was never written', () => {
    expect(useDrafts.getState().getDraft('post.new')).toBeUndefined();
  });

  it('round-trips text for a key', () => {
    useDrafts.getState().setDraft('post.new', 'half a thought');
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('half a thought');
  });

  it('keeps drafts for different keys independent', () => {
    useDrafts.getState().setDraft('post.new', 'top level');
    useDrafts.getState().setDraft('comment.abc123', 'a reply');

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('top level');
    expect(useDrafts.getState().getDraft('comment.abc123')?.text).toBe('a reply');
  });

  it('overwrites rather than appends on repeated writes to one key', () => {
    useDrafts.getState().setDraft('post.new', 'first');
    useDrafts.getState().setDraft('post.new', 'second');

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('second');
    expect(Object.keys(useDrafts.getState().drafts)).toHaveLength(1);
  });

  it('stamps updatedAt on every write', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    useDrafts.getState().setDraft('post.new', 'a');
    const first = useDrafts.getState().getDraft('post.new')!.updatedAt;

    vi.setSystemTime(new Date('2026-06-15T12:00:05.000Z'));
    useDrafts.getState().setDraft('post.new', 'b');
    const second = useDrafts.getState().getDraft('post.new')!.updatedAt;

    expect(second).toBeGreaterThan(first);
  });

  it('clearDraft removes only the target key', () => {
    useDrafts.getState().setDraft('post.new', 'keep me');
    useDrafts.getState().setDraft('comment.abc123', 'delete me');

    useDrafts.getState().clearDraft('comment.abc123');

    expect(useDrafts.getState().getDraft('comment.abc123')).toBeUndefined();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('keep me');
  });

  it('clearDraft on an absent key is a no-op, not a throw', () => {
    useDrafts.getState().setDraft('post.new', 'keep me');
    expect(() => useDrafts.getState().clearDraft('never.existed')).not.toThrow();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('keep me');
  });

  it('stores empty string as a real draft rather than dropping it', () => {
    // The composer clears text to '' before the user navigates away; that must
    // be distinguishable from "no draft" so the caller can decide.
    useDrafts.getState().setDraft('post.new', '');
    expect(useDrafts.getState().getDraft('post.new')).toBeDefined();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('');
  });

  it('clearDraft on an absent key writes nothing to storage', () => {
    // Every mounted comment box clears its draft when empty — ~20 per feed
    // page. A no-op `set` still persisted, i.e. one localStorage write each.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    useDrafts.getState().clearDraft('comment.never');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('clearAll drops every draft', () => {
    useDrafts.getState().setDraft('post.new', 'a');
    useDrafts.getState().setDraft('comment.abc123', 'b');

    useDrafts.getState().clearAll();

    expect(useDrafts.getState().drafts).toEqual({});
  });

  it('expires drafts older than the TTL when the store rehydrates', async () => {
    const now = Date.now();
    localStorage.setItem(
      'swil.drafts',
      JSON.stringify({
        state: {
          drafts: {
            'post.new': { text: 'fresh', updatedAt: now - 1000 },
            'comment.old': { text: 'stale', updatedAt: now - DRAFT_TTL_MS - 1000 },
          },
        },
        version: 0,
      }),
    );

    await useDrafts.persist.rehydrate();

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('fresh');
    expect(useDrafts.getState().getDraft('comment.old')).toBeUndefined();
    localStorage.removeItem('swil.drafts');
  });

  it('pruneDrafts keeps the edge inside the TTL and drops malformed rows', () => {
    const now = 10 * DRAFT_TTL_MS;
    const out = pruneDrafts(
      {
        a: { text: 'edge', updatedAt: now - DRAFT_TTL_MS + 1 },
        b: { text: 'gone', updatedAt: now - DRAFT_TTL_MS },
        c: { text: 'bad' } as unknown as { text: string; updatedAt: number },
      },
      now,
    );
    expect(Object.keys(out)).toEqual(['a']);
  });

  it('writes the pruned drafts back to storage after rehydrating', async () => {
    // merge's result is not persisted by itself: without a write-back the
    // expired draft stayed in localStorage indefinitely.
    const now = Date.now();
    localStorage.setItem(
      'swil.drafts',
      JSON.stringify({
        state: {
          drafts: {
            'post.new': { text: 'fresh', updatedAt: now - 1000 },
            'comment.old': { text: 'stale secret', updatedAt: now - DRAFT_TTL_MS - 1000 },
          },
          ownerId: 'u1',
        },
        version: 0,
      }),
    );

    await useDrafts.persist.rehydrate();

    const stored = localStorage.getItem('swil.drafts') ?? '';
    expect(stored).not.toContain('stale secret');
    expect(stored).toContain('fresh');
    expect(useDrafts.getState().ownerId).toBe('u1');
    localStorage.removeItem('swil.drafts');
  });

  it('claim keeps drafts for the same owner and drops them for another', () => {
    useDrafts.getState().claim('u1');
    useDrafts.getState().setDraft('post.new', 'mine');

    useDrafts.getState().claim('u1');
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('mine');

    useDrafts.getState().claim('u2');
    expect(useDrafts.getState().drafts).toEqual({});
    expect(useDrafts.getState().ownerId).toBe('u2');
  });
});
