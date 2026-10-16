import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { resetDb } from '../../test/db-reset';
import { comments, posts, users } from '../../db/schema';
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
