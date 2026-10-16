import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  createPost: vi.fn(),
  getPostForViewer: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
}));

vi.mock('./posts.service', () => ({
  createPost: mocks.createPost,
  getPostForViewer: mocks.getPostForViewer,
  updatePost: mocks.updatePost,
  deletePost: mocks.deletePost,
}));

import { AppError } from '../../lib/errors';
import type { PostDTOContext, PostRow, UserRow } from '../../lib/dto';
import { create, getById, remove, update } from './posts.controller';

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

function makePost(authorId: string): PostRow {
  return {
    id: newId(),
    authorId,
    text: 'Hello world',
    images: [],
    video: null,
    tagIds: [],
    mentionIds: [],
    visibility: 'public',
    likeCount: 0,
    commentCount: 0,
    repostCount: 0,
    status: 'active',
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-04-23T00:00:00.000Z'),
  } as unknown as PostRow;
}

function makeCtx(author: UserRow): PostDTOContext {
  return {
    author,
    tags: [],
    mentions: [],
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

describe('posts.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('maps uploaded images and video buffers into createPost', async () => {
    const author = makeUser();
    const post = makePost(author.id);
    const ctx = makeCtx(author);
    const imageA = Buffer.from('image-a');
    const imageB = Buffer.from('image-b');
    const video = Buffer.from('video');

    mocks.createPost.mockResolvedValue({ post, ctx });

    const req = {
      user: author,
      body: { text: 'Hello world', visibility: 'public' },
      files: {
        images: [{ buffer: imageA }, { buffer: imageB }],
        video: [{ buffer: video, mimetype: 'video/webm' }],
      },
    };
    const res = makeRes();

    await create(req as never, res);

    // The video's mimetype rides along so a webm is stored as webm, not mp4.
    expect(mocks.createPost).toHaveBeenCalledWith(
      author,
      req.body,
      [imageA, imageB],
      video,
      'video/webm',
    );
    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({
      data: {
        post: {
          id: post.id,
          text: 'Hello world',
        },
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('passes anonymous viewers through on getById', async () => {
    const author = makeUser();
    const post = makePost(author.id);
    const ctx = makeCtx(author);
    mocks.getPostForViewer.mockResolvedValue({ post, ctx });

    const req = { params: { id: post.id } };
    const res = makeRes();

    await getById(req as never, res);

    expect(mocks.getPostForViewer).toHaveBeenCalledWith(post.id, null);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      data: { post: { id: post.id } },
    });
  });

  it('forwards update payloads for authenticated users', async () => {
    const author = makeUser();
    const post = makePost(author.id);
    const ctx = makeCtx(author);
    mocks.updatePost.mockResolvedValue({ post, ctx });

    const req = {
      user: author,
      params: { id: post.id },
      body: { text: 'Updated text', visibility: 'followers' },
    };
    const res = makeRes();

    await update(req as never, res);

    expect(mocks.updatePost).toHaveBeenCalledWith(post.id, author, req.body);
    expect(res.payload).toMatchObject({
      data: { post: { id: post.id } },
    });
  });

  it('rejects delete attempts from anonymous users', async () => {
    await expect(
      remove({ params: { id: newId() } } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'UNAUTHENTICATED',
      status: 401,
    });

    expect(mocks.deletePost).not.toHaveBeenCalled();
  });
});
