import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { posts, comments, tags, users } from '../db/schema';
import { resetDb } from '../test/db-reset';
import { env } from '../config/env';
import type {
  PostRow,
  CommentRow,
  TagRow,
  UserRow,
  PostDTOContext,
  CommentDTOContext,
} from './dto';
import {
  settleTranslationCacheWrites,
  translatePosts,
  translateComments,
  translateTags,
} from './translate';

const ORIGINAL_KEY = env.GOOGLE_TRANSLATE_API_KEY;

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `user${seq}`,
      usernameDisplay: `user${seq}`,
      email: `user${seq}@example.com`,
      displayName: `User ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

async function seedPost(
  authorId: string,
  over: Partial<typeof posts.$inferInsert> = {},
): Promise<PostRow> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: '你好世界', ...over })
    .returning();
  return p;
}

async function seedComment(
  postId: string,
  authorId: string,
  over: Partial<typeof comments.$inferInsert> = {},
): Promise<CommentRow> {
  const [c] = await db
    .insert(comments)
    .values({ postId, authorId, text: '你好世界', ...over })
    .returning();
  return c;
}

async function seedTag(over: Partial<typeof tags.$inferInsert> = {}): Promise<TagRow> {
  seq += 1;
  const [t] = await db
    .insert(tags)
    .values({ slug: `tag-${seq}`, display: '技术', ...over })
    .returning();
  return t;
}

function makePostCtx(author: UserRow, tagList: TagRow[] = []): PostDTOContext {
  return { author, tags: tagList, mentions: [] };
}

function makeCommentCtx(author: UserRow): CommentDTOContext {
  return { author };
}

/**
 * Stub global fetch to emulate the Google Translate v2 endpoint. `map` provides
 * the translated text per input string; anything unmapped is echoed back
 * unchanged (exercising the "translation === original → skip" branch).
 */
function stubTranslate(map: Record<string, string> = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { q: string[] };
    const translations = body.q.map((q) => ({ translatedText: map[q] ?? q }));
    return { ok: true, json: async () => ({ data: { translations } }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stub fetch to a non-2xx response (translateBatch returns originals unchanged). */
function stubTranslateFailure(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Poll an assertion until it passes — needed for the fire-and-forget DB caches. */
async function eventually(check: () => Promise<void>, tries = 50, delayMs = 10): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await check();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

afterEach(() => {
  env.GOOGLE_TRANSLATE_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('translatePosts', () => {
  beforeEach(resetDb);

  it('short-circuits when the translate API key is not configured', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = undefined;
    const fetchMock = stubTranslate();
    const author = await seedUser();
    const post = await seedPost(author.id);
    const ctx = makePostCtx(author);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.translatedText).toBeUndefined();
    expect(ctx.lang).toBeUndefined(); // returned before the lang-stamping loop
  });

  it('short-circuits on an empty post list without calling the API', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate();

    await translatePosts([], new Map(), 'en');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the cached translation and never calls the API (cache-hit branch)', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate();
    const author = await seedUser();
    const post = await seedPost(author.id, {
      text: '你好世界',
      translations: { en: 'cached hello' },
    });
    const ctx = makePostCtx(author);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.translatedText).toBe('cached hello');
    expect(ctx.originalLang).toBe('zh');
    expect(ctx.lang).toBe('en'); // still stamped at the end
  });

  it('translates a post, mutates the ctx, and persists translations[lang]', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate({ 你好世界: 'Hello world' });
    const author = await seedUser();
    const post = await seedPost(author.id, { text: '你好世界' });
    const ctx = makePostCtx(author);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.translatedText).toBe('Hello world');
    expect(ctx.originalLang).toBe('zh');
    expect(ctx.lang).toBe('en');

    await eventually(async () => {
      const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
      expect(row.translations).toEqual({ en: 'Hello world' });
    });
  });

  it('does not cache a translation of a body that was edited while the provider answered', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const author = await seedUser();
    const post = await seedPost(author.id, { text: '你好世界' });
    // The edit lands mid-request, exactly as updatePost writes it: new text,
    // translations cleared.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await db
          .update(posts)
          .set({ text: '再见世界', translations: {} })
          .where(eq(posts.id, post.id));
        return {
          ok: true,
          json: async () => ({ data: { translations: [{ translatedText: 'Hello world' }] } }),
        };
      }),
    );

    await translatePosts([post], new Map([[post.id, makePostCtx(author)]]), 'en');
    await settleTranslationCacheWrites();

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.text).toBe('再见世界');
    expect(row.translations).toEqual({});
  });

  it('does not persist or set ctx when the translation equals the original', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    // no map entry → identity translation → translatedText === post.text
    const fetchMock = stubTranslate();
    const author = await seedUser();
    const post = await seedPost(author.id, { text: '你好世界' });
    const ctx = makePostCtx(author);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.translatedText).toBeUndefined();
    expect(ctx.lang).toBe('en'); // lang still stamped

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.translations).toEqual({}); // untouched
  });

  it('leaves the post unchanged when the translate API errors (non-2xx)', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslateFailure();
    const author = await seedUser();
    const post = await seedPost(author.id, { text: '你好世界' });
    const ctx = makePostCtx(author);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.translatedText).toBeUndefined();

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row.translations).toEqual({});
  });

  it('translates tags embedded in the post contexts', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate({ 技术: 'Technology' });
    const author = await seedUser();
    // empty-text post is skipped, isolating the tag path
    const post = await seedPost(author.id, { text: '' });
    const tag = await seedTag({ display: '技术' });
    const ctx = makePostCtx(author, [tag]);

    await translatePosts([post], new Map([[post.id, ctx]]), 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // translateTags mutates the tag object in memory
    expect(tag.translations).toEqual({ en: 'Technology' });

    await eventually(async () => {
      const [row] = await db.select().from(tags).where(eq(tags.id, tag.id));
      expect(row.translations).toEqual({ en: 'Technology' });
    });
  });
});

describe('translateComments', () => {
  beforeEach(resetDb);

  it('short-circuits when the translate API key is not configured', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = undefined;
    const fetchMock = stubTranslate();
    const author = await seedUser();
    const post = await seedPost(author.id);
    const comment = await seedComment(post.id, author.id);
    const ctx = makeCommentCtx(author);

    await translateComments([comment], new Map([[comment.id, ctx]]), 'en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.translatedText).toBeUndefined();
  });

  it('uses cached translations and skips deleted / empty comments (no API call)', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate();
    const author = await seedUser();
    const post = await seedPost(author.id);
    const cached = await seedComment(post.id, author.id, {
      text: '你好',
      translations: { en: 'cached hi' },
    });
    const deleted = await seedComment(post.id, author.id, { text: '你好', status: 'deleted' });
    const cachedCtx = makeCommentCtx(author);
    const deletedCtx = makeCommentCtx(author);

    await translateComments(
      [cached, deleted],
      new Map([
        [cached.id, cachedCtx],
        [deleted.id, deletedCtx],
      ]),
      'en',
    );

    expect(fetchMock).not.toHaveBeenCalled(); // nothing pending → early return
    expect(cachedCtx.translatedText).toBe('cached hi');
    expect(deletedCtx.translatedText).toBeUndefined();
  });

  it('translates a comment, mutates the ctx, and persists translations[lang]', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate({ 你好世界: 'Hello world' });
    const author = await seedUser();
    const post = await seedPost(author.id);
    const comment = await seedComment(post.id, author.id, { text: '你好世界' });
    const ctx = makeCommentCtx(author);

    await translateComments([comment], new Map([[comment.id, ctx]]), 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.translatedText).toBe('Hello world');

    await eventually(async () => {
      const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
      expect(row.translations).toEqual({ en: 'Hello world' });
    });
  });
});

describe('translateComments edit race', () => {
  beforeEach(resetDb);

  it('does not cache a translation of a comment edited while the provider answered', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const author = await seedUser();
    const post = await seedPost(author.id);
    const comment = await seedComment(post.id, author.id, { text: '你好世界' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await db
          .update(comments)
          .set({ text: '再见世界', translations: {} })
          .where(eq(comments.id, comment.id));
        return {
          ok: true,
          json: async () => ({ data: { translations: [{ translatedText: 'Hello world' }] } }),
        };
      }),
    );

    await translateComments([comment], new Map([[comment.id, makeCommentCtx(author)]]), 'en');
    await settleTranslationCacheWrites();

    const [row] = await db.select().from(comments).where(eq(comments.id, comment.id));
    expect(row.translations).toEqual({});
  });
});

describe('translateTags', () => {
  beforeEach(resetDb);

  it('short-circuits when the translate API key is not configured', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = undefined;
    const fetchMock = stubTranslate();
    const tag = await seedTag({ display: '技术' });

    await translateTags([tag], 'en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tag.translations).toEqual({});
  });

  it('skips tags that already have the target-lang translation (no API call)', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate();
    const tag = await seedTag({ display: '技术', translations: { en: 'Tech' } });

    await translateTags([tag], 'en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tag.translations).toEqual({ en: 'Tech' });
  });

  it('translates a tag, mutates it in memory, and persists translations[lang]', async () => {
    env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubTranslate({ 技术: 'Technology' });
    const tag = await seedTag({ display: '技术' });

    await translateTags([tag], 'en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tag.translations).toEqual({ en: 'Technology' });

    await eventually(async () => {
      const [row] = await db.select().from(tags).where(eq(tags.id, tag.id));
      expect(row.translations).toEqual({ en: 'Technology' });
    });
  });
});
