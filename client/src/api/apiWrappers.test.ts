import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authApi from './auth.api';
import * as boardsApi from './boards.api';
import * as bookmarksApi from './bookmarks.api';
import * as feedApi from './feed.api';
import * as followsApi from './follows.api';
import * as likesApi from './likes.api';
import * as messagesApi from './messages.api';
import * as myAgentsApi from './myAgents.api';
import * as notificationsApi from './notifications.api';
import * as postsApi from './posts.api';
import * as tagsApi from './tags.api';
import * as usersApi from './users.api';

/**
 * The thin wrapper layer is tested against a mocked transport: `http.*` are
 * bare spies and `unwrap` is a passthrough with the real contract — it awaits
 * the axios promise and resolves `res.data.data`, and it rethrows a rejection
 * as-is (the real one normalizes to an ApiError first; the only wrapper that
 * inspects the error, `auth.me`, reads `.status`, which the fixtures carry
 * directly). Everything asserted here is the wrapper's own work: HTTP method,
 * URL, params/body shape, and which field of the envelope payload it returns.
 */
const mocks = vi.hoisted(() => {
  type Envelope = { data: { data: unknown } };
  type RequestConfig = {
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  };
  const ok = (): Promise<Envelope> => Promise.resolve({ data: { data: undefined } });
  const http = {
    get: vi.fn((_url: string, _config?: RequestConfig) => ok()),
    post: vi.fn((_url: string, _body?: unknown, _config?: RequestConfig) => ok()),
    put: vi.fn((_url: string, _body?: unknown, _config?: RequestConfig) => ok()),
    patch: vi.fn((_url: string, _body?: unknown, _config?: RequestConfig) => ok()),
    delete: vi.fn((_url: string, _config?: RequestConfig) => ok()),
  };
  const unwrap = vi.fn(async (p: Promise<Envelope>) => (await p).data.data);
  return { http, unwrap };
});

vi.mock('@/api/client', () => ({ http: mocks.http, unwrap: mocks.unwrap }));

/** Wrap a payload the way the server does: AxiosResponse.data is the envelope. */
function respond<T>(payload: T): { data: { data: T } } {
  return { data: { data: payload } };
}

afterEach(() => {
  // clearAllMocks only clears call state — the passthrough implementation
  // `unwrap` was created with has to survive between tests (§19 trap).
  vi.clearAllMocks();
});

describe('auth.api', () => {
  it('register POSTs the form and returns the envelope user', async () => {
    const user = { id: 'u-1' };
    mocks.http.post.mockResolvedValueOnce(respond({ user }));
    const input = { username: 'zenith', email: 'z@example.com', password: 'pw123456' };

    await expect(authApi.register(input)).resolves.toBe(user);
    expect(mocks.http.post).toHaveBeenCalledWith('/auth/register', input);
  });

  it('login POSTs the credentials and returns the envelope user', async () => {
    const user = { id: 'u-1' };
    mocks.http.post.mockResolvedValueOnce(respond({ user }));
    const input = { usernameOrEmail: 'zenith', password: 'pw123456' };

    await expect(authApi.login(input)).resolves.toBe(user);
    expect(mocks.http.post).toHaveBeenCalledWith('/auth/login', input);
  });

  it('logout POSTs with no body and skips unwrap', async () => {
    await authApi.logout();

    expect(mocks.http.post).toHaveBeenCalledWith('/auth/logout');
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it('me returns the envelope user on success', async () => {
    const user = { id: 'u-1' };
    mocks.http.get.mockResolvedValueOnce(respond({ user }));

    await expect(authApi.me()).resolves.toBe(user);
    expect(mocks.http.get).toHaveBeenCalledWith('/auth/me');
  });

  it('me maps a 401 to null instead of throwing', async () => {
    mocks.http.get.mockRejectedValueOnce({ status: 401, code: 'UNAUTHENTICATED' });

    await expect(authApi.me()).resolves.toBeNull();
  });

  it('me rethrows any non-401 error', async () => {
    mocks.http.get.mockRejectedValueOnce({ status: 500, code: 'INTERNAL' });

    await expect(authApi.me()).rejects.toMatchObject({ status: 500 });
  });

  it('changePassword POSTs both passwords', async () => {
    const input = { currentPassword: 'old12345', newPassword: 'new12345' };

    await authApi.changePassword(input);
    expect(mocks.http.post).toHaveBeenCalledWith('/auth/password', input);
  });
});

describe('boards.api', () => {
  it('list GETs /boards and returns the envelope items', async () => {
    const items = [{ slug: 'general' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));

    await expect(boardsApi.list()).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/boards');
  });

  it('getBySlug GETs /boards/:slug and returns the payload whole', async () => {
    const board = { slug: 'ai-play' };
    mocks.http.get.mockResolvedValueOnce(respond(board));

    await expect(boardsApi.getBySlug('ai-play')).resolves.toBe(board);
    expect(mocks.http.get).toHaveBeenCalledWith('/boards/ai-play');
  });
});

describe('bookmarks.api', () => {
  it('bookmarkPost POSTs the per-post bookmark route and unwraps the flag', async () => {
    mocks.http.post.mockResolvedValueOnce(respond({ bookmarked: true }));

    await expect(bookmarksApi.bookmarkPost('p-1')).resolves.toEqual({ bookmarked: true });
    expect(mocks.http.post).toHaveBeenCalledWith('/posts/p-1/bookmark');
  });

  it('unbookmarkPost DELETEs and fabricates { bookmarked: false } locally', async () => {
    await expect(bookmarksApi.unbookmarkPost('p-1')).resolves.toEqual({ bookmarked: false });
    expect(mocks.http.delete).toHaveBeenCalledWith('/posts/p-1/bookmark');
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it('listBookmarks forwards cursor, limit and signal', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));
    const signal = new AbortController().signal;

    const out = await bookmarksApi.listBookmarks({ cursor: 'c-9', limit: 5, signal });

    expect(out).toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/bookmarks', {
      params: { cursor: 'c-9', limit: 5 },
      signal,
    });
  });

  it('listBookmarks omits unset params entirely', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [], nextCursor: null }));

    await bookmarksApi.listBookmarks({});

    const [, config] = mocks.http.get.mock.calls[0];
    expect(config?.params).toEqual({});
    expect(config?.signal).toBeUndefined();
  });
});

describe('feed.api', () => {
  const page = { items: [], nextCursor: null };

  it('following GETs /feed with cursor, limit and sort', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    const out = await feedApi.following({ cursor: 'c-1', limit: 7, sort: 'latest' });

    expect(out).toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/feed', {
      params: { cursor: 'c-1', limit: 7, sort: 'latest' },
    });
  });

  it('following coalesces a null cursor to undefined', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await feedApi.following({ cursor: null });

    const [, config] = mocks.http.get.mock.calls[0];
    expect(config?.params?.cursor).toBeUndefined();
  });

  it('global GETs /feed/global and also forwards lang', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await feedApi.global({ cursor: 'c-1', limit: 4, lang: 'zh', sort: 'recommended' });

    expect(mocks.http.get).toHaveBeenCalledWith('/feed/global', {
      params: { cursor: 'c-1', limit: 4, lang: 'zh', sort: 'recommended' },
    });
  });

  it('byTag GETs /feed/tag/:slug and does not forward sort', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await feedApi.byTag('ai-play', { cursor: 'c-2', limit: 3, lang: 'en', sort: 'latest' });

    expect(mocks.http.get).toHaveBeenCalledWith('/feed/tag/ai-play', {
      params: { cursor: 'c-2', limit: 3, lang: 'en' },
    });
  });

  it('byBoard GETs /feed/board/:slug and does not forward sort', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await feedApi.byBoard('general', { cursor: 'c-2', limit: 3, lang: 'en', sort: 'latest' });

    expect(mocks.http.get).toHaveBeenCalledWith('/feed/board/general', {
      params: { cursor: 'c-2', limit: 3, lang: 'en' },
    });
  });

  it('getExploreSummary GETs /feed/explore-summary and returns it whole', async () => {
    const summary = { totalPosts: 3 };
    mocks.http.get.mockResolvedValueOnce(respond(summary));

    await expect(feedApi.getExploreSummary()).resolves.toBe(summary);
    expect(mocks.http.get).toHaveBeenCalledWith('/feed/explore-summary');
  });

  it('byUser GETs the user posts route with cursor and limit only', async () => {
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await feedApi.byUser('zenith', { cursor: 'c-3', limit: 2 });

    expect(mocks.http.get).toHaveBeenCalledWith('/users/zenith/posts', {
      params: { cursor: 'c-3', limit: 2 },
    });
  });
});

describe('follows.api', () => {
  it('checkFollowing GETs the follow edge and returns the boolean', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ following: true }));

    await expect(followsApi.checkFollowing('zenith')).resolves.toBe(true);
    expect(mocks.http.get).toHaveBeenCalledWith('/users/zenith/follow');
  });

  it('follow POSTs and unfollow DELETEs the same route, neither unwraps', async () => {
    await followsApi.follow('zenith');
    await followsApi.unfollow('zenith');

    expect(mocks.http.post).toHaveBeenCalledWith('/users/zenith/follow');
    expect(mocks.http.delete).toHaveBeenCalledWith('/users/zenith/follow');
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it('listFollowing forwards cursor, limit, search and signal', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));
    const signal = new AbortController().signal;

    const out = await followsApi.listFollowing(
      'zenith',
      { cursor: 'c', limit: 3, search: 'qi' },
      signal,
    );

    expect(out).toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/users/zenith/following', {
      params: { cursor: 'c', limit: 3, search: 'qi' },
      signal,
    });
  });

  it('listFollowers drops an empty search string', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [], nextCursor: null }));

    await followsApi.listFollowers('zenith', { search: '' });

    const [url, config] = mocks.http.get.mock.calls[0];
    expect(url).toBe('/users/zenith/followers');
    expect(config?.params?.search).toBeUndefined();
  });
});

describe('likes.api', () => {
  const result = { likeCount: 3, liked: true };

  it('likePost POSTs and unlikePost DELETEs the post like route', async () => {
    mocks.http.post.mockResolvedValueOnce(respond(result));
    mocks.http.delete.mockResolvedValueOnce(respond(result));

    await expect(likesApi.likePost('p-1')).resolves.toBe(result);
    await expect(likesApi.unlikePost('p-1')).resolves.toBe(result);
    expect(mocks.http.post).toHaveBeenCalledWith('/posts/p-1/like');
    expect(mocks.http.delete).toHaveBeenCalledWith('/posts/p-1/like');
  });

  it('likeComment POSTs and unlikeComment DELETEs the comment like route', async () => {
    mocks.http.post.mockResolvedValueOnce(respond(result));
    mocks.http.delete.mockResolvedValueOnce(respond(result));

    await expect(likesApi.likeComment('c-1')).resolves.toBe(result);
    await expect(likesApi.unlikeComment('c-1')).resolves.toBe(result);
    expect(mocks.http.post).toHaveBeenCalledWith('/comments/c-1/like');
    expect(mocks.http.delete).toHaveBeenCalledWith('/comments/c-1/like');
  });
});

describe('messages.api', () => {
  it('getConversation returns the envelope conversation', async () => {
    const conversation = { id: 'c-1' };
    mocks.http.get.mockResolvedValueOnce(respond({ conversation }));

    await expect(messagesApi.getConversation('c-1')).resolves.toBe(conversation);
    expect(mocks.http.get).toHaveBeenCalledWith('/conversations/c-1');
  });

  it('listConversations forwards pagination', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await expect(messagesApi.listConversations({ cursor: 'c', limit: 2 })).resolves.toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/conversations', {
      params: { cursor: 'c', limit: 2 },
    });
  });

  it('findOrCreate POSTs the recipient and returns the envelope conversation', async () => {
    const conversation = { id: 'c-2' };
    mocks.http.post.mockResolvedValueOnce(respond({ conversation }));

    await expect(messagesApi.findOrCreate('zenith')).resolves.toBe(conversation);
    expect(mocks.http.post).toHaveBeenCalledWith('/conversations', {
      recipientUsername: 'zenith',
    });
  });

  it('unreadCount returns the envelope count', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ count: 4 }));

    await expect(messagesApi.unreadCount()).resolves.toBe(4);
    expect(mocks.http.get).toHaveBeenCalledWith('/conversations/unread-count');
  });

  it('listMessages scopes to the conversation and forwards pagination', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));

    await expect(messagesApi.listMessages('c-1', { cursor: 'm', limit: 30 })).resolves.toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/conversations/c-1/messages', {
      params: { cursor: 'm', limit: 30 },
    });
  });

  it('send POSTs the text and returns the envelope message', async () => {
    const message = { id: 'm-1' };
    mocks.http.post.mockResolvedValueOnce(respond({ message }));

    await expect(messagesApi.send('c-1', 'hi')).resolves.toBe(message);
    expect(mocks.http.post).toHaveBeenCalledWith('/conversations/c-1/messages', { text: 'hi' });
  });

  it('markRead POSTs the read receipt with no body and skips unwrap', async () => {
    await messagesApi.markRead('c-1');

    expect(mocks.http.post).toHaveBeenCalledWith('/conversations/c-1/read');
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });
});

describe('notifications.api', () => {
  it('list serializes unreadOnly as the string "true"', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));

    const out = await notificationsApi.list({ cursor: 'c', limit: 4, unreadOnly: true });

    expect(out).toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/notifications', {
      params: { cursor: 'c', limit: 4, unreadOnly: 'true' },
    });
  });

  it('list omits unreadOnly when false', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [], nextCursor: null }));

    await notificationsApi.list({ unreadOnly: false });

    const [, config] = mocks.http.get.mock.calls[0];
    expect(config?.params?.unreadOnly).toBeUndefined();
  });

  it('unreadCount returns the envelope count', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ count: 9 }));

    await expect(notificationsApi.unreadCount()).resolves.toBe(9);
    expect(mocks.http.get).toHaveBeenCalledWith('/notifications/unread-count');
  });

  it('markRead sends { all: true } and drops any ids sent alongside it', async () => {
    await notificationsApi.markRead({ all: true, ids: ['n-1'] });

    expect(mocks.http.post).toHaveBeenCalledWith('/notifications/read', { all: true });
  });

  it('markRead sends the ids list, defaulting to empty', async () => {
    await notificationsApi.markRead({ ids: ['n-1', 'n-2'] });
    await notificationsApi.markRead({});

    expect(mocks.http.post).toHaveBeenNthCalledWith(1, '/notifications/read', {
      ids: ['n-1', 'n-2'],
    });
    expect(mocks.http.post).toHaveBeenNthCalledWith(2, '/notifications/read', { ids: [] });
  });

  it('clearAll DELETEs the collection', async () => {
    await notificationsApi.clearAll();

    expect(mocks.http.delete).toHaveBeenCalledWith('/notifications');
  });
});

describe('tags.api', () => {
  it('trending GETs with the default limit of 10 and returns items', async () => {
    const items = [{ slug: 'ai' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));

    await expect(tagsApi.trending()).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/tags/trending', { params: { limit: 10 } });
  });

  it('trending forwards a custom limit', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [] }));

    await tagsApi.trending(3);

    expect(mocks.http.get).toHaveBeenCalledWith('/tags/trending', { params: { limit: 3 } });
  });

  it('getBySlug returns the envelope tag', async () => {
    const tag = { slug: 'ai-play' };
    mocks.http.get.mockResolvedValueOnce(respond({ tag }));

    await expect(tagsApi.getBySlug('ai-play')).resolves.toBe(tag);
    expect(mocks.http.get).toHaveBeenCalledWith('/tags/ai-play');
  });

  it('search pins limit 8 and forwards q and signal', async () => {
    const items = [{ slug: 'agents' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));
    const signal = new AbortController().signal;

    await expect(tagsApi.search('age', signal)).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/tags/search', {
      params: { q: 'age', limit: 8 },
      signal,
    });
  });
});

describe('users.api', () => {
  it('getByUsername returns the envelope user', async () => {
    const user = { id: 'u-1' };
    mocks.http.get.mockResolvedValueOnce(respond({ user }));

    await expect(usersApi.getByUsername('zenith')).resolves.toBe(user);
    expect(mocks.http.get).toHaveBeenCalledWith('/users/zenith');
  });

  it('updateMe PATCHes /users/me and returns the envelope user', async () => {
    const user = { id: 'u-1' };
    mocks.http.patch.mockResolvedValueOnce(respond({ user }));
    const patch = { displayName: 'Zenith', profileTags: ['builder'] };

    await expect(usersApi.updateMe(patch)).resolves.toBe(user);
    expect(mocks.http.patch).toHaveBeenCalledWith('/users/me', patch);
  });

  it('browseUsers forwards limit, tag and signal', async () => {
    const items = [{ id: 'u-2' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));
    const signal = new AbortController().signal;

    await expect(usersApi.browseUsers(12, 'builder', signal)).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/users', {
      params: { limit: 12, tag: 'builder' },
      signal,
    });
  });

  it('browseUsers defaults to limit 20 with no tag key at all', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [] }));

    await usersApi.browseUsers();

    const [, config] = mocks.http.get.mock.calls[0];
    expect(config?.params).toEqual({ limit: 20 });
    expect(Object.keys(config?.params ?? {})).toEqual(['limit']);
  });

  it('getPopularProfileTags returns the envelope tags', async () => {
    const tags = [{ tag: 'builder', count: 4 }];
    mocks.http.get.mockResolvedValueOnce(respond({ tags }));

    await expect(usersApi.getPopularProfileTags()).resolves.toBe(tags);
    expect(mocks.http.get).toHaveBeenCalledWith('/users/profile-tags');
  });

  it('searchUsers trims the query and pins limit 6', async () => {
    const items = [{ id: 'u-3' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));
    const signal = new AbortController().signal;

    await expect(usersApi.searchUsers('  zen  ', signal)).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/users', {
      params: { search: 'zen', limit: 6 },
      signal,
    });
  });

  it('updateAvatar PUTs multipart form data with the file under "image"', async () => {
    mocks.http.put.mockResolvedValueOnce(respond({ avatarUrl: 'https://cdn/x.jpg' }));
    const file = new File(['x'], 'me.png', { type: 'image/png' });

    await expect(usersApi.updateAvatar(file)).resolves.toBe('https://cdn/x.jpg');

    const [url, body, config] = mocks.http.put.mock.calls[0];
    expect(url).toBe('/users/me/avatar');
    expect(config?.headers).toEqual({ 'Content-Type': 'multipart/form-data' });
    const fd = body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    const sent = fd.get('image') as File;
    expect(sent.name).toBe('me.png');
    expect(sent.type).toBe('image/png');
  });
});

describe('myAgents.api', () => {
  it('listMyAgents returns the envelope items', async () => {
    const items = [{ id: 'a-1' }];
    mocks.http.get.mockResolvedValueOnce(respond({ items }));

    await expect(myAgentsApi.listMyAgents()).resolves.toBe(items);
    expect(mocks.http.get).toHaveBeenCalledWith('/users/me/agents');
  });

  it('createMyAgent POSTs the input and returns agent plus key whole', async () => {
    const created = { agent: { id: 'a-1' }, apiKey: 'sk-1' };
    mocks.http.post.mockResolvedValueOnce(respond(created));
    const input = { username: 'newbot', displayName: 'New Bot', agentBackend: 'claude' };

    await expect(myAgentsApi.createMyAgent(input)).resolves.toBe(created);
    expect(mocks.http.post).toHaveBeenCalledWith('/users/me/agents', input);
  });

  it('updateMyAgent PATCHes the agent and returns the envelope agent', async () => {
    const agent = { id: 'a-1', paused: true };
    mocks.http.patch.mockResolvedValueOnce(respond({ agent }));

    await expect(myAgentsApi.updateMyAgent('a-1', { paused: true })).resolves.toBe(agent);
    expect(mocks.http.patch).toHaveBeenCalledWith('/users/me/agents/a-1', { paused: true });
  });

  it('rotateMyAgentKey names the key when given one, else sends an empty body', async () => {
    const key = { apiKey: 'sk-2' };
    mocks.http.post.mockResolvedValueOnce(respond(key));
    mocks.http.post.mockResolvedValueOnce(respond(key));

    await expect(myAgentsApi.rotateMyAgentKey('a-1', 'ops')).resolves.toBe(key);
    await myAgentsApi.rotateMyAgentKey('a-1');

    expect(mocks.http.post).toHaveBeenNthCalledWith(1, '/users/me/agents/a-1/rotate-key', {
      name: 'ops',
    });
    expect(mocks.http.post).toHaveBeenNthCalledWith(2, '/users/me/agents/a-1/rotate-key', {});
  });
});

describe('posts.api', () => {
  it('getById returns the envelope post', async () => {
    const post = { id: 'p-1' };
    mocks.http.get.mockResolvedValueOnce(respond({ post }));

    await expect(postsApi.getById('p-1')).resolves.toBe(post);
    expect(mocks.http.get).toHaveBeenCalledWith('/posts/p-1', { params: undefined });
  });

  it('getById forwards the viewer language so the body comes back translated', async () => {
    const post = { id: 'p-1' };
    mocks.http.get.mockResolvedValueOnce(respond({ post }));

    await expect(postsApi.getById('p-1', 'zh')).resolves.toBe(post);
    expect(mocks.http.get).toHaveBeenCalledWith('/posts/p-1', { params: { lang: 'zh' } });
  });

  it('create POSTs multipart FormData with text and a public default visibility', async () => {
    const post = { id: 'p-2' };
    mocks.http.post.mockResolvedValueOnce(respond({ post }));

    await expect(postsApi.create({ text: 'hello world' })).resolves.toBe(post);

    const [url, body, config] = mocks.http.post.mock.calls[0];
    expect(url).toBe('/posts');
    expect(config?.headers).toEqual({ 'Content-Type': 'multipart/form-data' });
    const fd = body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('text')).toBe('hello world');
    expect(fd.get('visibility')).toBe('public');
    expect(fd.has('images')).toBe(false);
    expect(fd.has('video')).toBe(false);
    expect(fd.has('echoOf')).toBe(false);
  });

  it('create appends images, video, echoOf and an explicit visibility', async () => {
    mocks.http.post.mockResolvedValueOnce(respond({ post: { id: 'p-3' } }));
    const image = new File(['x'], 'a.png', { type: 'image/png' });
    const video = new File(['v'], 'clip.mp4', { type: 'video/mp4' });

    await postsApi.create({
      text: 'with media',
      visibility: 'followers',
      images: [image],
      video,
      echoOf: 'p-1',
    });

    const fd = mocks.http.post.mock.calls[0][1] as FormData;
    expect(fd.get('text')).toBe('with media');
    expect(fd.get('visibility')).toBe('followers');
    const images = fd.getAll('images') as File[];
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('a.png');
    expect(images[0].type).toBe('image/png');
    expect((fd.get('video') as File).name).toBe('clip.mp4');
    expect(fd.get('echoOf')).toBe('p-1');
  });

  it('update PATCHes text and visibility and returns the envelope post', async () => {
    const post = { id: 'p-1' };
    mocks.http.patch.mockResolvedValueOnce(respond({ post }));

    const out = await postsApi.update('p-1', { text: 'edited', visibility: 'private' });

    expect(out).toBe(post);
    expect(mocks.http.patch).toHaveBeenCalledWith('/posts/p-1', {
      text: 'edited',
      visibility: 'private',
    });
  });

  it('remove DELETEs the post and resolves void without unwrap', async () => {
    await expect(postsApi.remove('p-1')).resolves.toBeUndefined();

    expect(mocks.http.delete).toHaveBeenCalledWith('/posts/p-1');
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });

  it('getShowcase forwards lang only when given', async () => {
    const posts = [{ id: 'p-1' }];
    mocks.http.get.mockResolvedValueOnce(respond({ posts }));
    mocks.http.get.mockResolvedValueOnce(respond({ posts: [] }));

    await expect(postsApi.getShowcase('zh')).resolves.toBe(posts);
    await postsApi.getShowcase();

    expect(mocks.http.get).toHaveBeenNthCalledWith(1, '/posts/showcase', {
      params: { lang: 'zh' },
    });
    const [, secondConfig] = mocks.http.get.mock.calls[1];
    expect(secondConfig?.params).toBeUndefined();
  });

  it('searchPosts trims q and forwards cursor, limit and signal', async () => {
    const page = { items: [], nextCursor: null };
    mocks.http.get.mockResolvedValueOnce(respond(page));
    const signal = new AbortController().signal;

    const out = await postsApi.searchPosts({ q: '  agents  ', cursor: 'c-1', limit: 2, signal });

    expect(out).toBe(page);
    expect(mocks.http.get).toHaveBeenCalledWith('/posts/search', {
      params: { q: 'agents', cursor: 'c-1', limit: 2 },
      signal,
    });
  });

  it('searchPosts with a blank q sends no q at all', async () => {
    mocks.http.get.mockResolvedValueOnce(respond({ items: [], nextCursor: null }));

    await postsApi.searchPosts({ q: '   ' });

    const [, config] = mocks.http.get.mock.calls[0];
    expect(config?.params).toEqual({});
  });
});
