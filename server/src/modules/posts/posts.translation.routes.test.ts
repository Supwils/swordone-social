import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { apiKeys, comments, follows, posts, users } from '../../db/schema';
import { createHash, randomBytes } from 'crypto';
import { env } from '../../config/env';
import * as envModule from '../../config/env';

/**
 * The X-style on-demand translation endpoints and the auto-translate
 * preference, end to end through the real router stack. Google Translate is
 * stubbed at `fetch`; `translateEnabled` is a module constant computed at
 * import, so it is spied per test.
 */
const ORIGINAL_KEY = env.GOOGLE_TRANSLATE_API_KEY;

function stubTranslate(map: Record<string, string>) {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { q: string[] };
    return {
      ok: true,
      json: async () => ({
        data: { translations: body.q.map((q) => ({ translatedText: map[q] ?? q })) },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function enableTranslate(on: boolean) {
  env.GOOGLE_TRANSLATE_API_KEY = on ? 'test-key' : undefined;
  vi.spyOn(envModule, 'translateEnabled', 'get').mockReturnValue(on);
}

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `tr${seq}`,
      usernameDisplay: `tr${seq}`,
      email: `tr${seq}@example.com`,
      displayName: `Tr ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.GOOGLE_TRANSLATE_API_KEY = ORIGINAL_KEY;
});

describe('GET /posts/:id/translation', () => {
  it('translates a Chinese post to English on demand and caches it on the row', async () => {
    enableTranslate(true);
    const fetchMock = stubTranslate({ 你好世界: 'Hello world' });
    const author = await seedUser();
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '你好世界' })
      .returning();

    const res = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=en`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: post.id,
      from: 'zh',
      to: 'en',
      text: 'Hello world',
      translated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Persisted → a second call is served from the row, no upstream call.
    await vi.waitFor(async () => {
      const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
      expect(row.translations?.en).toBe('Hello world');
    });
    const again = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=en`);
    expect(again.body.data.text).toBe('Hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the original untranslated when the target is the source language', async () => {
    enableTranslate(true);
    const fetchMock = stubTranslate({});
    const author = await seedUser();
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '你好世界' })
      .returning();

    const res = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=zh`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      from: 'zh',
      to: 'zh',
      text: '你好世界',
      translated: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown target language before touching the post', async () => {
    const author = await seedUser();
    const [post] = await db.insert(posts).values({ authorId: author.id, text: 'hi' }).returning();

    const res = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=fr`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 503 UNAVAILABLE when no provider is configured', async () => {
    enableTranslate(false);
    const author = await seedUser();
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '你好世界' })
      .returning();

    const res = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=en`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
  });

  it('answers 503 when the provider fails instead of passing the original off as a translation', async () => {
    enableTranslate(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const author = await seedUser();
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '你好世界' })
      .returning();

    const res = await request(createApp()).get(`/api/v1/posts/${post.id}/translation?to=en`);

    expect(res.status).toBe(503);
  });

  it('404s an unknown post', async () => {
    const res = await request(createApp()).get(
      '/api/v1/posts/aaaaaaaaaaaaaaaaaaaaaaaa/translation?to=en',
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /comments/:id/translation', () => {
  it('translates one comment and refuses a deleted one', async () => {
    enableTranslate(true);
    stubTranslate({ 说得好: 'Well said' });
    const author = await seedUser();
    const [post] = await db.insert(posts).values({ authorId: author.id, text: 'x' }).returning();
    const [comment] = await db
      .insert(comments)
      .values({ postId: post.id, authorId: author.id, text: '说得好' })
      .returning();
    const [gone] = await db
      .insert(comments)
      .values({ postId: post.id, authorId: author.id, text: '再见', status: 'deleted' })
      .returning();

    const ok = await request(createApp()).get(`/api/v1/comments/${comment.id}/translation?to=en`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      from: 'zh',
      to: 'en',
      text: 'Well said',
      translated: true,
    });

    const missing = await request(createApp()).get(`/api/v1/comments/${gone.id}/translation?to=en`);
    expect(missing.status).toBe(404);
  });
});

describe('auto-translate preference and the lang field', () => {
  it('every post DTO carries the detected source language', async () => {
    // Switch the auto path off explicitly (whatever key the env carries) so
    // the bodies come back verbatim and can be looked up by text.
    enableTranslate(false);
    const author = await seedUser();
    await db.insert(posts).values({ authorId: author.id, text: '中文帖子' });
    await db.insert(posts).values({ authorId: author.id, text: 'english post' });

    const res = await request(createApp()).get('/api/v1/feed/global?sort=latest');

    expect(res.status).toBe(200);
    const langs = new Map(
      (res.body.data.items as Array<{ text: string; lang: string }>).map((p) => [p.text, p.lang]),
    );
    expect(langs.get('中文帖子')).toBe('zh');
    expect(langs.get('english post')).toBe('en');
  });

  it('a signed-in user with autoTranslate=false gets original bodies, and can turn it back on', async () => {
    enableTranslate(true);
    const fetchMock = stubTranslate({ 中文帖子: 'Chinese post' });
    const author = await seedUser();
    await db.insert(posts).values({ authorId: author.id, text: '中文帖子' });

    const agent = request.agent(createApp());
    await agent
      .post('/api/v1/auth/register')
      .send({ username: 'reader', email: 'reader@example.com', password: 'password123' })
      .expect(201);
    await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { language: 'en', autoTranslate: false } })
      .expect(200);

    const off = await agent.get('/api/v1/feed/global?sort=latest').expect(200);
    const item = off.body.data.items.find((p: { text: string }) => p.text === '中文帖子');
    expect(item).toBeDefined();
    expect(item.originalText).toBeUndefined();
    expect(item.lang).toBe('zh');
    expect(fetchMock).not.toHaveBeenCalled();

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.user.preferences.autoTranslate).toBe(false);

    await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { autoTranslate: true } })
      .expect(200);
    const on = await agent.get('/api/v1/feed/global?sort=latest').expect(200);
    const translated = on.body.data.items.find(
      (p: { originalText?: string }) => p.originalText === '中文帖子',
    );
    expect(translated?.text).toBe('Chinese post');
  });
});

describe('every post-returning read translates the way /feed/global does', () => {
  it('search, explore-summary (anonymous ?lang=), bookmarks and the following feed', async () => {
    enableTranslate(true);
    stubTranslate({ 中文帖子: 'Chinese post' });
    const author = await seedUser({ isAgent: true });
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '中文帖子' })
      .returning();

    // Anonymous: `?lang=` decides (search used to strip it in validation).
    const search = await request(createApp())
      .get(`/api/v1/posts/search?q=${encodeURIComponent('中文')}&lang=en`)
      .expect(200);
    expect(search.body.data.items[0]).toMatchObject({
      text: 'Chinese post',
      originalText: '中文帖子',
    });

    const explore = await request(createApp())
      .get('/api/v1/feed/explore-summary?lang=en')
      .expect(200);
    expect(explore.body.data.featuredPost).toMatchObject({ id: post.id, text: 'Chinese post' });

    // Signed in: the stored preference wins, and auto-translate is honoured.
    const agent = request.agent(createApp());
    await agent
      .post('/api/v1/auth/register')
      .send({ username: 'reader', email: 'reader@example.com', password: 'password123' })
      .expect(201);
    await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { language: 'en', autoTranslate: true } })
      .expect(200);
    await agent.post(`/api/v1/users/${author.username}/follow`).expect(204);
    await agent.post(`/api/v1/posts/${post.id}/bookmark`).expect(201);

    const bookmarks = await agent.get('/api/v1/bookmarks').expect(200);
    expect(bookmarks.body.data.items[0]).toMatchObject({ text: 'Chinese post' });
    const following = await agent.get('/api/v1/feed').expect(200);
    expect(following.body.data.items[0]).toMatchObject({ text: 'Chinese post' });

    await agent
      .patch('/api/v1/users/me')
      .send({ preferences: { autoTranslate: false } })
      .expect(200);
    const off = await agent.get('/api/v1/feed').expect(200);
    // The following feed used to translate whatever the preference said.
    expect(off.body.data.items[0]).toMatchObject({ text: '中文帖子' });
    expect(off.body.data.items[0].originalText).toBeUndefined();
    const offBookmarks = await agent.get('/api/v1/bookmarks').expect(200);
    expect(offBookmarks.body.data.items[0].originalText).toBeUndefined();
  });
});

describe('first-party agents always read originals (experiment input)', () => {
  async function bearerFor(over: Partial<typeof users.$inferInsert>): Promise<{
    id: string;
    auth: string;
  }> {
    const u = await seedUser(over);
    const raw = `sk-swil-${randomBytes(8).toString('hex')}`;
    await db.insert(apiKeys).values({
      userId: u.id,
      name: 'test',
      keyHash: createHash('sha256').update(raw).digest('hex'),
    });
    return { id: u.id, auth: `Bearer ${raw}` };
  }

  it('no read translates for an isAgent account with no owner; fetch is never called', async () => {
    enableTranslate(true);
    const fetchMock = stubTranslate({ 中文帖子: 'Chinese post', 中文评论: 'Chinese comment' });
    const author = await seedUser({ isAgent: true });
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '中文帖子' })
      .returning();
    await db.insert(comments).values({ postId: post.id, authorId: author.id, text: '中文评论' });
    const agent = await bearerFor({ isAgent: true });
    await db.insert(follows).values({ followerId: agent.id, followingId: author.id });

    const app = createApp();
    const reads = [
      '/api/v1/feed/global',
      '/api/v1/feed/global?sort=latest&lang=en',
      '/api/v1/feed',
      `/api/v1/posts/search?q=${encodeURIComponent('中文')}`,
      `/api/v1/posts/${post.id}`,
      '/api/v1/feed/explore-summary',
    ];
    for (const path of reads) {
      const res = await request(app).get(path).set('Authorization', agent.auth).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('Chinese post');
      expect(JSON.stringify(res.body)).toContain('中文帖子');
    }
    const thread = await request(app)
      .get(`/api/v1/posts/${post.id}/comments`)
      .set('Authorization', agent.auth)
      .expect(200);
    expect(thread.body.data.items[0]).toMatchObject({ text: '中文评论' });
    expect(thread.body.data.items[0].originalText).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    // A BYOA (owned) agent and a human keep their translation.
    const owner = await seedUser();
    const byoa = await bearerFor({ isAgent: true, ownerId: owner.id });
    const human = await bearerFor({});
    for (const who of [byoa, human]) {
      const res = await request(app)
        .get('/api/v1/feed/global')
        .set('Authorization', who.auth)
        .expect(200);
      expect(res.body.data.items[0]).toMatchObject({
        text: 'Chinese post',
        originalText: '中文帖子',
      });
    }
    expect(fetchMock).toHaveBeenCalled();
  });
});
