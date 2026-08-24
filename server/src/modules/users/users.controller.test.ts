import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { newId } from '../../lib/id';

const mocks = vi.hoisted(() => ({
  findByUsername: vi.fn(),
  searchUsers: vi.fn(),
  getPopularProfileTags: vi.fn(),
  updateMe: vi.fn(),
  updateAvatar: vi.fn(),
}));

vi.mock('./users.service', () => ({
  findByUsername: mocks.findByUsername,
  searchUsers: mocks.searchUsers,
  getPopularProfileTags: mocks.getPopularProfileTags,
  updateMe: mocks.updateMe,
  updateAvatar: mocks.updateAvatar,
}));

import { TAG_CATEGORIES, ALL_PRESET_TAGS } from '../../lib/tagPresets';
import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';
import {
  getByUsername,
  getPopularProfileTags,
  getProfileTagPresets,
  search,
  updateAvatar,
  updateMe,
} from './users.controller';

function makeUser(id = newId(), username = 'ada'): UserRow {
  return {
    id,
    username,
    usernameDisplay: username,
    displayName: 'Ada',
    bio: 'Bio',
    headline: 'Headline',
    avatarUrl: null,
    coverUrl: null,
    location: null,
    website: null,
    profileTags: ['typescript'],
    followerCount: 1,
    followingCount: 2,
    postCount: 3,
    email: `${username}@example.com`,
    emailVerified: true,
    preferences: {
      theme: 'system',
      language: 'en',
      emailNotifications: true,
      pushNotifications: true,
    },
    isAgent: false,
    createdAt: new Date('2026-04-24T00:00:00.000Z'),
  } as unknown as UserRow;
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

describe('users.controller', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns self fields when viewing your own profile', async () => {
    const viewer = makeUser();
    mocks.findByUsername.mockResolvedValue(viewer);
    const res = makeRes();

    await getByUsername({ user: viewer, params: { username: 'ada' } } as never, res);

    expect(mocks.findByUsername).toHaveBeenCalledWith('ada');
    expect(res.payload).toMatchObject({
      data: {
        user: {
          id: viewer.id,
          email: 'ada@example.com',
          preferences: viewer.preferences,
        },
      },
    });
  });

  it('uses the default search limit when limit is omitted', async () => {
    mocks.searchUsers.mockResolvedValue([]);
    const res = makeRes();

    await search({ query: { search: 'ada', tag: 'typescript' } } as never, res);

    expect(mocks.searchUsers).toHaveBeenCalledWith('ada', 'typescript', 10);
    expect(res.payload).toEqual({
      data: { items: [] },
      meta: { requestId: 'req-1' },
    });
  });

  it('returns popular profile tags', async () => {
    mocks.getPopularProfileTags.mockResolvedValue(['typescript', 'node']);
    const res = makeRes();

    await getPopularProfileTags({} as never, res);

    expect(res.payload).toEqual({
      data: { tags: ['typescript', 'node'] },
      meta: { requestId: 'req-1' },
    });
  });

  it('returns preset profile tags from constants', async () => {
    const res = makeRes();

    await getProfileTagPresets({} as never, res);

    expect(res.payload).toEqual({
      data: {
        categories: TAG_CATEGORIES,
        all: ALL_PRESET_TAGS,
      },
      meta: { requestId: 'req-1' },
    });
  });

  it('updates the current user profile', async () => {
    const viewer = makeUser();
    mocks.updateMe.mockResolvedValue({ ...viewer, displayName: 'Ada Lovelace' });
    const res = makeRes();

    await updateMe(
      {
        user: viewer,
        body: { displayName: 'Ada Lovelace' },
      } as never,
      res,
    );

    expect(mocks.updateMe).toHaveBeenCalledWith(viewer, { displayName: 'Ada Lovelace' });
    expect(res.payload).toMatchObject({
      data: { user: { displayName: 'Ada Lovelace' } },
    });
  });

  it('rejects avatar updates without a file', async () => {
    await expect(
      updateAvatar({ user: makeUser() } as never, makeRes()),
    ).rejects.toMatchObject<AppError>({
      code: 'VALIDATION_ERROR',
      status: 400,
      fields: { image: 'required' },
    });
    expect(mocks.updateAvatar).not.toHaveBeenCalled();
  });
});
