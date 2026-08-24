import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  unfollow: vi.fn(),
  isFollowing: vi.fn(),
  listFollowing: vi.fn(),
  listFollowers: vi.fn(),
}));

vi.mock('./follows.service', () => ({
  follow: mocks.follow,
  unfollow: mocks.unfollow,
  isFollowing: mocks.isFollowing,
  listFollowing: mocks.listFollowing,
  listFollowers: mocks.listFollowers,
}));

import { encodeCursor } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import {
  checkFollowing,
  follow,
  listFollowers,
  listFollowing,
  unfollow,
} from './follows.controller';

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
  return res as unknown as Response & {
    statusCode: number;
    payload: unknown;
    ended: boolean;
  };
}

describe('follows.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('follows a user and returns 204', async () => {
    const viewer = makeUser();
    const res = makeRes();

    await follow({ user: viewer, params: { username: 'ada' } } as never, res);

    expect(mocks.follow).toHaveBeenCalledWith(viewer, 'ada');
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('checks follow state for an authenticated user', async () => {
    const viewer = makeUser();
    mocks.isFollowing.mockResolvedValue(true);
    const res = makeRes();

    await checkFollowing({ user: viewer, params: { username: 'ada' } } as never, res);

    expect(mocks.isFollowing).toHaveBeenCalledWith(viewer, 'ada');
    expect(res.payload).toEqual({
      data: { following: true },
      meta: { requestId: 'req-1' },
    });
  });

  it('parses cursor, limit and search for following lists', async () => {
    const cursor = encodeCursor({
      t: '2026-04-24T00:00:00.000Z',
      id: newId(),
    });
    mocks.listFollowing.mockResolvedValue({ items: [], nextCursor: null });
    const res = makeRes();

    await listFollowing(
      {
        params: { username: 'ada' },
        query: { cursor, limit: '7', search: ' bob ' },
      } as never,
      res,
    );

    expect(mocks.listFollowing).toHaveBeenCalledWith(
      'ada',
      expect.objectContaining({ t: '2026-04-24T00:00:00.000Z' }),
      7,
      ' bob ',
    );
    expect(res.statusCode).toBe(200);
  });

  it('uses default pagination for follower lists', async () => {
    mocks.listFollowers.mockResolvedValue({ items: [], nextCursor: null });
    const res = makeRes();

    await listFollowers({ params: { username: 'ada' }, query: {} } as never, res);

    expect(mocks.listFollowers).toHaveBeenCalledWith('ada', null, 20, undefined);
    expect(res.payload).toEqual({
      data: { items: [], nextCursor: null },
      meta: { requestId: 'req-1' },
    });
  });

  it('rejects anonymous unfollow attempts', async () => {
    await expect(
      unfollow({ params: { username: 'ada' } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(mocks.unfollow).not.toHaveBeenCalled();
  });
});
