import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  bookmark: vi.fn(),
  unbookmark: vi.fn(),
  listBookmarks: vi.fn(),
}));

vi.mock('./bookmarks.service', () => ({
  bookmark: mocks.bookmark,
  unbookmark: mocks.unbookmark,
  listBookmarks: mocks.listBookmarks,
}));

import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import { bookmarkPost, list, unbookmarkPost } from './bookmarks.controller';

function makeUser(id = newId()): UserRow {
  return { id } as unknown as UserRow;
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    ended: false,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown; ended: boolean };
}

describe('bookmarks.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('bookmarks a post through the service and answers 201', async () => {
    const user = makeUser();
    const id = newId();
    mocks.bookmark.mockResolvedValue({ bookmarked: true });

    const res = makeRes();
    await bookmarkPost({ user, params: { id } } as never, res);

    expect(mocks.bookmark).toHaveBeenCalledWith(user, id);
    expect(res.statusCode).toBe(201);
    expect(res.payload).toEqual({
      data: { bookmarked: true },
      meta: { requestId: 'req-1' },
    });
  });

  it('unbookmarks a post and answers 204 with no body', async () => {
    const user = makeUser();
    const id = newId();
    mocks.unbookmark.mockResolvedValue(undefined);

    const res = makeRes();
    await unbookmarkPost({ user, params: { id } } as never, res);

    expect(mocks.unbookmark).toHaveBeenCalledWith(user, id);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.payload).toBeUndefined();
  });

  it('lists bookmarks with the default limit and no cursor', async () => {
    const user = makeUser();
    mocks.listBookmarks.mockResolvedValue({ items: [], nextCursor: null });

    const res = makeRes();
    await list({ user, query: {} } as never, res);

    expect(mocks.listBookmarks).toHaveBeenCalledWith(user, undefined, 20, {
      lang: 'en',
      content: true,
    });
    expect(res.payload).toEqual({
      data: { items: [], nextCursor: null },
      meta: { requestId: 'req-1' },
    });
  });

  it('clamps the limit into [1, 50] and falls back on garbage', async () => {
    const user = makeUser();
    mocks.listBookmarks.mockResolvedValue({ items: [], nextCursor: null });

    await list({ user, query: { limit: '999' } } as never, makeRes());
    // '0' is falsy after parseInt, so it hits the `|| 20` default before the
    // Math.max clamp ever sees it — default, not 1, is the contract.
    await list({ user, query: { limit: '0' } } as never, makeRes());
    await list({ user, query: { limit: 'abc' } } as never, makeRes());
    await list({ user, query: { limit: '7', cursor: 'cur-1' } } as never, makeRes());

    expect(mocks.listBookmarks.mock.calls.map((c) => c[2])).toEqual([50, 20, 20, 7]);
    expect(mocks.listBookmarks).toHaveBeenLastCalledWith(user, 'cur-1', 7, expect.any(Object));
  });

  it('rejects every handler without an authenticated user', async () => {
    await expect(bookmarkPost({ params: { id: newId() } } as never, makeRes())).rejects.toThrow(
      AppError,
    );
    await expect(unbookmarkPost({ params: { id: newId() } } as never, makeRes())).rejects.toThrow(
      AppError,
    );
    await expect(list({ query: {} } as never, makeRes())).rejects.toThrow(AppError);
    expect(mocks.bookmark).not.toHaveBeenCalled();
    expect(mocks.unbookmark).not.toHaveBeenCalled();
    expect(mocks.listBookmarks).not.toHaveBeenCalled();
  });
});
