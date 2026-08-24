import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  listForPost: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock('./comments.service', () => ({
  listForPost: mocks.listForPost,
  createComment: mocks.createComment,
  updateComment: mocks.updateComment,
  deleteComment: mocks.deleteComment,
}));

import { encodeCursor } from '../../lib/pagination';
import { AppError } from '../../lib/errors';
import type { CommentDTOContext, CommentRow, UserRow } from '../../lib/dto';
import { create, listForPost, remove } from './comments.controller';

function makeUser(id = newId()): UserRow {
  return {
    id,
    username: 'ada',
    usernameDisplay: 'ada',
    displayName: 'Ada',
    bio: '',
    headline: '',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: [],
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    email: 'ada@example.com',
    emailVerified: true,
    preferences: {
      theme: 'system',
      language: 'en',
      emailNotifications: true,
      pushNotifications: true,
    },
    isAgent: false,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as unknown as UserRow;
}

function makeComment(authorId: string): CommentRow {
  return {
    id: newId(),
    postId: newId(),
    parentId: null,
    authorId,
    text: 'hello',
    mentionIds: [],
    likeCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as unknown as CommentRow;
}

function makeCtx(author: UserRow): CommentDTOContext {
  return {
    author,
    likedByMe: false,
  };
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
    end() {
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

describe('comments.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('parses paging params for listForPost', async () => {
    const author = makeUser();
    const comment = makeComment(author.id);
    const cursor = encodeCursor({ t: comment.createdAt.toISOString(), id: comment.id });
    mocks.listForPost.mockResolvedValue({
      items: [comment],
      nextCursor: null,
      ctxByCommentId: new Map([[comment.id, makeCtx(author)]]),
    });

    const req = {
      params: { id: comment.postId },
      query: { cursor, limit: '7' },
    };
    const res = makeRes();

    await listForPost(req as never, res);

    expect(mocks.listForPost).toHaveBeenCalledWith(
      comment.postId,
      null,
      { t: comment.createdAt.toISOString(), id: comment.id },
      7,
    );
    expect(res.payload).toMatchObject({
      data: {
        items: [{ id: comment.id, text: 'hello' }],
        nextCursor: null,
      },
    });
  });

  it('passes null parentId when creating a top-level comment', async () => {
    const author = makeUser();
    const comment = makeComment(author.id);
    mocks.createComment.mockResolvedValue({ comment, ctx: makeCtx(author) });

    const req = {
      user: author,
      params: { id: comment.postId },
      body: { text: 'hello' },
    };
    const res = makeRes();

    await create(req as never, res);

    expect(mocks.createComment).toHaveBeenCalledWith(author, comment.postId, 'hello', null);
    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({
      data: { comment: { id: comment.id } },
    });
  });

  it('rejects delete attempts from anonymous users', async () => {
    await expect(
      remove({ params: { id: newId() } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });

    expect(mocks.deleteComment).not.toHaveBeenCalled();
  });
});
