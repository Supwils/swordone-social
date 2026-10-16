import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import request from 'supertest';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { boards, comments, posts, tags, users } from '../../db/schema';
import { env } from '../../config/env';
import * as envModule from '../../config/env';
import { resetDb } from '../../test/db-reset';
import { envelopeData, expectContract } from '../../test/contract';
import { paginated } from '../../contract/common';
import {
  BoardDTOSchema,
  CommentDTOSchema,
  ExploreSummaryDTOSchema,
  PostDTOSchema,
  TagDTOSchema,
  TranslationDTOSchema,
} from '../../contract/posts';

/**
 * Post, comment, tag, board, translation and explore bodies as SERIALISED by
 * the real router stack, against the contract. Seeds cover the shapes that
 * strict schemas could trip on: media, tags, mentions, a board, an echo of a
 * deleted post (tombstone) by a deleted author, deleted comments, featured and
 * archived tags.
 */

const postBody = z.object({ post: PostDTOSchema }).strict();
const postPage = paginated(PostDTOSchema);
const commentPage = paginated(CommentDTOSchema);
const tagItems = z.object({ items: z.array(TagDTOSchema) }).strict();

const ORIGINAL_KEY = env.GOOGLE_TRANSLATE_API_KEY;

/** Google Translate stubbed at `fetch` (see posts.translation.routes.test.ts). */
function enableTranslate(map: Record<string, string>) {
  env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
  vi.spyOn(envModule, 'translateEnabled', 'get').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { q: string[] };
      return {
        ok: true,
        json: async () => ({
          data: { translations: body.q.map((q) => ({ translatedText: map[q] ?? q })) },
        }),
      };
    }),
  );
}

let seq = 0;
async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({
      username: `pc${seq}`,
      usernameDisplay: `pc${seq}`,
      email: `pc${seq}@example.com`,
      displayName: `Pc ${seq}`,
      ...over,
    })
    .returning();
  return u;
}

async function seedWorld() {
  const author = await seedUser({ isAgent: true, agentBackend: 'grok:grok-4.6' });
  const mentioned = await seedUser();
  const goneAuthor = await seedUser({ status: 'deleted', deletedAt: new Date() });
  const [board] = await db
    .insert(boards)
    .values({ slug: 'tech', name: 'Tech', description: 'Machines', sortOrder: 1, postCount: 1 })
    .returning();
  const [plainTag] = await db
    .insert(tags)
    .values({ slug: 'rust', display: 'Rust', postCount: 2, translations: { zh: '锈' } })
    .returning();
  const [featuredTag] = await db
    .insert(tags)
    .values({
      slug: 'golang',
      display: 'Go',
      postCount: 3,
      featured: true,
      description: 'gophers',
      coverImage: 'https://cdn.example/go.png',
    })
    .returning();
  await db.insert(tags).values({ slug: 'perl', display: 'Perl', postCount: 1, status: 'archived' });

  const [rich] = await db
    .insert(posts)
    .values({
      authorId: author.id,
      text: 'hello rust and go',
      images: [{ url: 'https://cdn.example/a.png', width: 4, height: 3, blurhash: 'LKO2' }],
      video: { url: 'https://cdn.example/a.mp4', width: 640, height: 360, durationSec: 9 },
      tagIds: [plainTag.id, featuredTag.id],
      mentionIds: [mentioned.id],
      boardId: board.id,
      editedAt: new Date(),
      feedScore: 10,
    })
    .returning();
  await db
    .update(tags)
    .set({ pinnedPostIds: [rich.id] })
    .where(eq(tags.id, featuredTag.id));

  const [deletedOriginal] = await db
    .insert(posts)
    .values({
      authorId: goneAuthor.id,
      text: 'a secret',
      images: [{ url: 'https://cdn.example/gone.png', width: 1, height: 1 }],
      status: 'deleted',
      deletedAt: new Date(),
      editedAt: new Date(),
    })
    .returning();
  const [echo] = await db
    .insert(posts)
    .values({ authorId: author.id, text: 'still thinking about this', echoOf: deletedOriginal.id })
    .returning();

  const [zh] = await db.insert(posts).values({ authorId: author.id, text: '你好世界' }).returning();

  const [liveComment] = await db
    .insert(comments)
    .values({ postId: rich.id, authorId: mentioned.id, text: '你好', editedAt: new Date() })
    .returning();
  await db.insert(comments).values({
    postId: rich.id,
    authorId: goneAuthor.id,
    parentId: liveComment.id,
    text: 'gone',
    status: 'deleted',
    deletedAt: new Date(),
  });

  return { author, board, rich, echo, deletedOriginal, zh, liveComment };
}

let world: Awaited<ReturnType<typeof seedWorld>>;

// One world for the whole file (fileParallelism is off, so nothing else
// touches the DB meanwhile). Read-only tests share it; the mutating tests sit
// in the last describe and assert only on rows they created themselves.
beforeAll(async () => {
  await resetDb();
  world = await seedWorld();
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.GOOGLE_TRANSLATE_API_KEY = ORIGINAL_KEY;
});

describe('post bodies (read-only)', () => {
  it('GET /posts/:id — a full post, and an echo whose original is a deleted tombstone', async () => {
    const { rich, echo, deletedOriginal } = world;
    const app = createApp();

    const full = expectContract(
      postBody,
      envelopeData((await request(app).get(`/api/v1/posts/${rich.id}`).expect(200)).body),
    ).post;
    expect(full.boardId).toBeDefined();
    expect(full.images[0].blurhash).toBe('LKO2');

    const echoed = expectContract(
      postBody,
      envelopeData((await request(app).get(`/api/v1/posts/${echo.id}`).expect(200)).body),
    ).post;
    expect(echoed.echoOf).toMatchObject({
      id: deletedOriginal.id,
      text: '[deleted]',
      images: [],
      video: null,
      editedAt: null,
    });
  });

  it('feeds and the author list are cursor pages of PostDTO', async () => {
    const { author, board } = world;
    const app = createApp();
    for (const path of [
      '/api/v1/feed/global?sort=latest',
      '/api/v1/feed/global',
      `/api/v1/users/${author.username}/posts`,
      `/api/v1/feed/board/${board.slug}?sort=latest`,
      '/api/v1/feed/tag/rust?sort=latest',
    ]) {
      const res = await request(app).get(path).expect(200);
      const page = expectContract(postPage, envelopeData(res.body));
      expect(page.items.length, path).toBeGreaterThan(0);
    }
    // The echo-of-a-tombstone card is in the global feed too (hydratePosts path).
    const global = expectContract(
      postPage,
      envelopeData((await request(app).get('/api/v1/feed/global?sort=latest').expect(200)).body),
    );
    expect(global.items.some((p) => p.echoOf?.text === '[deleted]')).toBe(true);
  });

  it('search and showcase', async () => {
    const app = createApp();
    const found = await request(app).get('/api/v1/posts/search?q=rust').expect(200);
    expect(expectContract(postPage, envelopeData(found.body)).items.length).toBeGreaterThan(0);
    const showcase = await request(app).get('/api/v1/posts/showcase').expect(200);
    expectContract(
      z.object({ posts: z.array(PostDTOSchema) }).strict(),
      envelopeData(showcase.body),
    );
  });
});

describe('comment bodies (read-only)', () => {
  it('GET /posts/:id/comments is a cursor page of CommentDTO, tombstones included', async () => {
    const { rich } = world;
    const res = await request(createApp()).get(`/api/v1/posts/${rich.id}/comments`).expect(200);
    const page = expectContract(commentPage, envelopeData(res.body));
    expect(page.items.length).toBeGreaterThan(0);
  });
});

describe('translation bodies', () => {
  it('post and comment translations, translated and same-language', async () => {
    const { zh, liveComment } = world;
    const app = createApp();

    const same = await request(app).get(`/api/v1/posts/${zh.id}/translation?to=zh`).expect(200);
    expect(expectContract(TranslationDTOSchema, envelopeData(same.body)).translated).toBe(false);

    enableTranslate({ 你好世界: 'Hello world', 你好: 'Hello' });
    const post = await request(app).get(`/api/v1/posts/${zh.id}/translation?to=en`).expect(200);
    expect(expectContract(TranslationDTOSchema, envelopeData(post.body))).toMatchObject({
      from: 'zh',
      to: 'en',
      translated: true,
    });
    const comment = await request(app)
      .get(`/api/v1/comments/${liveComment.id}/translation?to=en`)
      .expect(200);
    expect(expectContract(TranslationDTOSchema, envelopeData(comment.body)).text).toBe('Hello');

    // Auto-translated feed items carry originalText / originalLang.
    const feed = await request(app).get('/api/v1/feed/global?sort=latest&lang=en').expect(200);
    const translated = expectContract(postPage, envelopeData(feed.body)).items.find(
      (p) => p.originalText === '你好世界',
    );
    expect(translated?.originalLang).toBe('zh');
  });
});

describe('tag, board and explore bodies (read-only)', () => {
  it('tags: search, trending and one tag (featured / archived fields present only when set)', async () => {
    const app = createApp();
    const search = await request(app).get('/api/v1/tags/search?q=go').expect(200);
    expect(expectContract(tagItems, envelopeData(search.body)).items[0]).toMatchObject({
      slug: 'golang',
      featured: true,
      description: 'gophers',
    });
    const trending = await request(app).get('/api/v1/tags/trending').expect(200);
    expectContract(tagItems, envelopeData(trending.body));
    const one = await request(app).get('/api/v1/tags/perl').expect(200);
    expect(
      expectContract(z.object({ tag: TagDTOSchema }).strict(), envelopeData(one.body)).tag.status,
    ).toBe('archived');
  });

  it('boards: list and one board', async () => {
    const { board } = world;
    const app = createApp();
    const list = await request(app).get('/api/v1/boards').expect(200);
    expectContract(z.object({ items: z.array(BoardDTOSchema) }).strict(), envelopeData(list.body));
    const one = await request(app).get(`/api/v1/boards/${board.slug}`).expect(200);
    expectContract(BoardDTOSchema, envelopeData(one.body));
  });

  it('GET /feed/explore-summary is an ExploreSummaryDTO', async () => {
    const res = await request(createApp()).get('/api/v1/feed/explore-summary').expect(200);
    const summary = expectContract(ExploreSummaryDTOSchema, envelopeData(res.body));
    expect(summary.agents.length).toBeGreaterThan(0);
    expect(summary.featuredTopics[0]?.pinnedPosts.length).toBe(1);
    expect(summary.trendingTags.find((t) => t.slug === 'golang')?.featured).toBe(true);
  });
});

// Last: these write rows (posts, an echo, a bookmark, a comment). Each asserts
// only the shape and its own ids, never counts the read tests depend on.
describe('write bodies (mutating)', () => {
  it('a signed-in write path: create, echo and bookmark list', async () => {
    const { rich } = world;
    const agent = request.agent(createApp());
    await agent
      .post('/api/v1/auth/register')
      .send({ username: 'writer', email: 'writer@example.com', password: 'password123' })
      .expect(201);

    const created = await agent.post('/api/v1/posts').field('text', 'my first post').expect(201);
    expectContract(postBody, envelopeData(created.body));

    const echoed = await agent
      .post('/api/v1/posts')
      .field('text', 'echoing')
      .field('echoOf', rich.id)
      .expect(201);
    // The create response is a read of the new echo, so it equals a later GET
    // (embedded original, echoCount and all).
    const echo = expectContract(postBody, envelopeData(echoed.body)).post;
    expect(echo.echoOf?.id).toBe(rich.id);
    const reread = await agent.get(`/api/v1/posts/${echo.id}`).expect(200);
    expect(envelopeData(echoed.body)).toEqual(envelopeData(reread.body));

    await agent.post(`/api/v1/posts/${rich.id}/bookmark`).expect(201);
    const saved = await agent.get('/api/v1/bookmarks').expect(200);
    const page = expectContract(postPage, envelopeData(saved.body));
    expect(page.items.map((p) => p.id)).toEqual([rich.id]);
    expect(page.items[0].bookmarkedByMe).toBe(true);
    // GET /posts/:id hydrates through the same path as the lists, so it agrees.
    const single = await agent.get(`/api/v1/posts/${rich.id}`).expect(200);
    expect(expectContract(postBody, envelopeData(single.body)).post.bookmarkedByMe).toBe(true);
  });

  it('POST /posts/:id/comments returns { comment }', async () => {
    const { rich } = world;
    const agent = request.agent(createApp());
    await agent
      .post('/api/v1/auth/register')
      .send({ username: 'talker', email: 'talker@example.com', password: 'password123' })
      .expect(201);
    const res = await agent
      .post(`/api/v1/posts/${rich.id}/comments`)
      .send({ text: 'nice' })
      .expect(201);
    expectContract(z.object({ comment: CommentDTOSchema }).strict(), envelopeData(res.body));
  });
});
