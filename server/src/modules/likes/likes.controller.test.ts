import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  like: vi.fn(),
  unlike: vi.fn(),
}));

vi.mock('./likes.service', () => ({
  like: mocks.like,
  unlike: mocks.unlike,
}));

import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import { likeComment, likePost, unlikeComment, unlikePost } from './likes.controller';

function makeUser(id = newId()): UserRow {
  return { id } as unknown as UserRow;
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    req: { id: 'req-1' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

describe('likes.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('likes posts through the service and returns the payload', async () => {
    const user = makeUser();
    const id = newId();
    mocks.like.mockResolvedValue({ likeCount: 3, liked: true });

    const res = makeRes();
    await likePost({ user, params: { id } } as never, res);

    expect(mocks.like).toHaveBeenCalledWith(user, 'post', id);
    expect(res.payload).toEqual({
      data: { likeCount: 3, liked: true },
      meta: { requestId: 'req-1' },
    });
  });

  it('unlikes comments through the service and returns the payload', async () => {
    const user = makeUser();
    const id = newId();
    mocks.unlike.mockResolvedValue({ likeCount: 1, liked: false });

    const res = makeRes();
    await unlikeComment({ user, params: { id } } as never, res);

    expect(mocks.unlike).toHaveBeenCalledWith(user, 'comment', id);
    expect(res.payload).toEqual({
      data: { likeCount: 1, liked: false },
      meta: { requestId: 'req-1' },
    });
  });

  it('rejects anonymous post likes', async () => {
    await expect(
      likePost({ params: { id: newId() } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(mocks.like).not.toHaveBeenCalled();
  });

  it('rejects anonymous comment unlikes', async () => {
    await expect(
      unlikePost({ params: { id: newId() } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(mocks.unlike).not.toHaveBeenCalled();
  });

  it('likes comments through the service', async () => {
    const user = makeUser();
    const id = newId();
    mocks.like.mockResolvedValue({ likeCount: 4, liked: true });

    const res = makeRes();
    await likeComment({ user, params: { id } } as never, res);

    expect(mocks.like).toHaveBeenCalledWith(user, 'comment', id);
    expect(res.statusCode).toBe(200);
  });

  it('unlikes posts through the service', async () => {
    const user = makeUser();
    const id = newId();
    mocks.unlike.mockResolvedValue({ likeCount: 0, liked: false });

    const res = makeRes();
    await unlikePost({ user, params: { id } } as never, res);

    expect(mocks.unlike).toHaveBeenCalledWith(user, 'post', id);
    expect(res.statusCode).toBe(200);
  });
});
