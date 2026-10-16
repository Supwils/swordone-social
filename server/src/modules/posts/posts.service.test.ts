import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as s3 from '../../config/s3';
import { db } from '../../db/client';
import {
  users,
  posts,
  tags,
  boards,
  follows,
  likes,
  bookmarks,
  notifications,
} from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { newId } from '../../lib/id';
import { AppError } from '../../lib/errors';
import type { PostRow, UserRow } from '../../lib/dto';
import {
  assertVisibility,
  createPost,
  deletePost,
  getPostForViewer,
  getShowcasePosts,
  hydratePosts,
  searchPosts,
  updatePost,
} from './posts.service';
import { POST_IMAGE_MAX_BYTES } from './posts.limits';

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

/** Minimal fabricated PostRow for the visibility checks (no DB row needed). */
function fakePost(over: Partial<PostRow> = {}): PostRow {
  return { visibility: 'public', authorId: newId(), ...over } as unknown as PostRow;
}

async function seedPost(
  authorId: string,
  over: Partial<typeof posts.$inferInsert> = {},
): Promise<PostRow> {
  const [p] = await db
    .insert(posts)
    .values({ authorId, text: 'hello world', visibility: 'public', ...over })
    .returning();
  return p;
}

describe('posts.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a pure-image post without requiring text', async () => {
    const author = await seedUser();

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/post.webp',
      width: 1200,
      height: 900,
    });

    const out = await createPost(
      author,
      { text: '', visibility: 'public' },
      [Buffer.from('img')],
      null,
    );

    expect(out.post.text).toBe('');
    expect(out.post.images).toEqual([
      { url: 'https://cdn.example.com/post.webp', width: 1200, height: 900 },
    ]);
    expect(out.post.video).toBeNull();
    expect(s3.uploadBufferToS3).toHaveBeenCalledTimes(1);

    // Persisted to the DB and the author's post count bumped.
    const [row] = await db.select().from(posts).where(eq(posts.id, out.post.id));
    expect(row.text).toBe('');
    expect(row.images[0]?.url).toBe('https://cdn.example.com/post.webp');
    const [u] = await db.select().from(users).where(eq(users.id, author.id));
    expect(u.postCount).toBe(1);
  });

  it('creates a pure-video post without requiring text', async () => {
    const author = await seedUser();

    vi.spyOn(s3, 'uploadVideoBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/post.mp4',
      width: 1920,
      height: 1080,
    });

    const out = await createPost(
      author,
      { text: '', visibility: 'public' },
      [],
      Buffer.from('vid'),
    );

    expect(out.post.images).toEqual([]);
    expect(out.post.video).toEqual({
      url: 'https://cdn.example.com/post.mp4',
      width: 1920,
      height: 1080,
    });
    expect(s3.uploadVideoBufferToS3).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(posts).where(eq(posts.id, out.post.id));
    expect(row.video?.url).toBe('https://cdn.example.com/post.mp4');
  });

  it('rejects an image larger than POST_IMAGE_MAX_BYTES before any upload', async () => {
    const author = await seedUser();
    await expect(
      createPost(
        author,
        { text: 'pic', visibility: 'public' },
        [Buffer.alloc(POST_IMAGE_MAX_BYTES + 1)],
        null,
      ),
    ).rejects.toMatchObject<Partial<AppError>>({
      code: 'VALIDATION_ERROR',
      message: 'Image files may not exceed 5 MB',
    });
  });

  it('rejects empty posts', async () => {
    const author = await seedUser();
    await expect(
      createPost(author, { text: '', visibility: 'public' }, [], null),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'VALIDATION_ERROR' });
  });

  it('files a post into a board when boardId is supplied', async () => {
    const author = await seedUser();
    const [board] = await db
      .insert(boards)
      .values({ slug: 'market', name: '市场与资产', sortOrder: 1 })
      .returning();

    const out = await createPost(
      author,
      { text: 'filed', visibility: 'public', boardId: board.id },
      [],
      null,
    );

    expect(out.post.boardId).toBe(board.id);
  });

  it('leaves boardId null when omitted', async () => {
    const author = await seedUser();
    const out = await createPost(author, { text: 'unfiled', visibility: 'public' }, [], null);
    expect(out.post.boardId).toBeNull();
  });

  it('increments boards.postCount when a post is filed, and decrements on delete', async () => {
    const author = await seedUser();
    const [board] = await db
      .insert(boards)
      .values({ slug: 'making', name: '造物与手艺', sortOrder: 6 })
      .returning();
    expect(board.postCount).toBe(0);

    const first = await createPost(
      author,
      { text: 'one', visibility: 'public', boardId: board.id },
      [],
      null,
    );
    await createPost(author, { text: 'two', visibility: 'public', boardId: board.id }, [], null);

    const [afterCreate] = await db.select().from(boards).where(eq(boards.id, board.id));
    expect(afterCreate.postCount).toBe(2);

    await deletePost(first.post.id, author);

    const [afterDelete] = await db.select().from(boards).where(eq(boards.id, board.id));
    expect(afterDelete.postCount).toBe(1);
  });

  it('gives the echoed original its repostCount back when the echo is deleted', async () => {
    const origAuthor = await seedUser();
    const echoer = await seedUser();
    const original = await seedPost(origAuthor.id, { text: 'original take' });

    const echo = await createPost(
      echoer,
      { text: 'worth reading', visibility: 'public', echoOf: original.id },
      [],
      null,
    );
    const [afterEcho] = await db.select().from(posts).where(eq(posts.id, original.id));
    expect(afterEcho.repostCount).toBe(1);

    await deletePost(echo.post.id, echoer);

    const [afterDelete] = await db.select().from(posts).where(eq(posts.id, original.id));
    expect(afterDelete.repostCount).toBe(0);
  });

  it('leaves every board count alone for an unfiled post', async () => {
    const author = await seedUser();
    const [board] = await db
      .insert(boards)
      .values({ slug: 'market', name: '市场与资产', sortOrder: 1 })
      .returning();

    const out = await createPost(author, { text: 'unfiled', visibility: 'public' }, [], null);
    await deletePost(out.post.id, author);

    const [row] = await db.select().from(boards).where(eq(boards.id, board.id));
    expect(row.postCount).toBe(0);
  });

  it('rejects an unknown boardId before doing any media work', async () => {
    const author = await seedUser();
    await expect(
      createPost(
        author,
        { text: 'x', visibility: 'public', boardId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        [],
        null,
      ),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'VALIDATION_ERROR' });
  });

  it('rolls back uploaded media if post persistence fails', async () => {
    const author = await seedUser();

    vi.spyOn(s3, 'uploadBufferToS3').mockResolvedValue({
      url: 'https://cdn.example.com/orphan.webp',
      width: 800,
      height: 600,
    });
    const del = vi.spyOn(s3, 'deleteFromS3').mockResolvedValue(undefined);
    // Force the persistence transaction to blow up after media upload succeeds.
    vi.spyOn(db, 'transaction').mockRejectedValue(new Error('db down'));

    await expect(
      createPost(author, { text: '', visibility: 'public' }, [Buffer.from('img')], null),
    ).rejects.toThrow('db down');

    expect(del).toHaveBeenCalledWith('https://cdn.example.com/orphan.webp');
  });

  it('reconciles tag counts when editing tags on a post', async () => {
    const author = await seedUser();
    const [oldTag] = await db
      .insert(tags)
      .values({ slug: 'old', display: 'old', postCount: 1 })
      .returning();
    const [post] = await db
      .insert(posts)
      .values({ authorId: author.id, text: '#old', visibility: 'public', tagIds: [oldTag.id] })
      .returning();

    const out = await updatePost(post.id, author, { text: '#alpha #beta' });

    expect(out.post.text).toBe('#alpha #beta');

    // New tags referenced by the post each gained a post (+1 from 0).
    const newTags = await db.select().from(tags).where(inArray(tags.id, out.post.tagIds));
    expect(newTags.length).toBeGreaterThan(0);
    for (const t of newTags) expect(t.postCount).toBe(1);

    // The previously-referenced tag was decremented (1 -> 0).
    const [old] = await db.select().from(tags).where(eq(tags.id, oldTag.id));
    expect(old.postCount).toBe(0);
  });

  it('hides follower-only posts from non-followers', async () => {
    const viewer = { id: newId() } as UserRow;
    const post = fakePost({ visibility: 'followers', authorId: newId() });

    await expect(assertVisibility(post, viewer)).rejects.toMatchObject<Partial<AppError>>({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('allows the author to read their own private posts', async () => {
    const author = { id: newId() } as UserRow;
    const post = fakePost({ visibility: 'private', authorId: author.id });

    await expect(assertVisibility(post, author)).resolves.toBeUndefined();
  });

  it('allows followers to read follower-only posts', async () => {
    // follows.follower_id / following_id are FKs, so both accounts are real rows.
    const viewer = await seedUser();
    const author = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followingId: author.id });

    const post = fakePost({ visibility: 'followers', authorId: author.id });

    await expect(assertVisibility(post, viewer)).resolves.toBeUndefined();
  });

  it('hides non-public posts from anonymous viewers', async () => {
    const post = fakePost({ visibility: 'private', authorId: newId() });
    await expect(assertVisibility(post, null)).rejects.toMatchObject<Partial<AppError>>({
      code: 'NOT_FOUND',
    });
  });

  // ── getPostForViewer ──────────────────────────────────────────────────────

  it('returns an active post with likedByMe false by default', async () => {
    const author = await seedUser();
    const viewer = await seedUser();
    const post = await seedPost(author.id, { text: 'a public post' });

    const { post: got, ctx } = await getPostForViewer(post.id, viewer);

    expect(got.id).toBe(post.id);
    expect(ctx.author.id).toBe(author.id);
    expect(ctx.likedByMe).toBe(false);
  });

  it('marks likedByMe true when the viewer has liked the post', async () => {
    const author = await seedUser();
    const viewer = await seedUser();
    const post = await seedPost(author.id);
    await db.insert(likes).values({ userId: viewer.id, targetType: 'post', targetId: post.id });

    const { ctx } = await getPostForViewer(post.id, viewer);
    expect(ctx.likedByMe).toBe(true);
  });

  it('throws NOT_FOUND for a missing post', async () => {
    const viewer = await seedUser();
    await expect(getPostForViewer(newId(), viewer)).rejects.toMatchObject<Partial<AppError>>({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('treats a soft-deleted post as not found (no [deleted] passthrough)', async () => {
    const author = await seedUser();
    const post = await seedPost(author.id, { status: 'deleted' });
    await expect(getPostForViewer(post.id, author)).rejects.toMatchObject<Partial<AppError>>({
      code: 'NOT_FOUND',
    });
  });

  it('hydrates tags and mentions for an anonymous viewer', async () => {
    const author = await seedUser();
    const mentioned = await seedUser({ username: 'mona', usernameDisplay: 'mona' });
    const [tag] = await db
      .insert(tags)
      .values({ slug: 'ts', display: 'TS', postCount: 1 })
      .returning();
    const post = await seedPost(author.id, {
      text: '#ts hi @mona',
      tagIds: [tag.id],
      mentionIds: [mentioned.id],
    });

    const { ctx } = await getPostForViewer(post.id, null);
    expect(ctx.tags.map((t) => t.slug)).toEqual(['ts']);
    expect(ctx.mentions.map((u) => u.username)).toEqual(['mona']);
    expect(ctx.likedByMe).toBe(false);
  });

  it('tombstones a deleted original inside an echo instead of serving its text', async () => {
    // `hydratePosts` loads echo originals with status in ('active','deleted')
    // on purpose, but `toPostDTO` had no tombstone branch the way
    // `toCommentDTO` does — so an author could delete a post and its full body
    // and images kept rendering inside anyone's echo of it, indefinitely, to
    // viewers who had never seen it.
    vi.spyOn(s3, 'deleteFromS3').mockResolvedValue(undefined);
    const origAuthor = await seedUser();
    const echoer = await seedUser();
    const original = await seedPost(origAuthor.id, {
      text: 'something I regret',
      images: [{ url: 'https://cdn.example.com/regret.webp', width: 10, height: 10 }],
    });
    const echo = await seedPost(echoer.id, { text: 'look at this', echoOf: original.id });

    await deletePost(original.id, origAuthor);

    const ctxById = await hydratePosts([echo], null);
    const viaFeed = ctxById.get(echo.id)?.echoOf;
    expect(viaFeed?.text).toBe('[deleted]');
    expect(viaFeed?.images).toEqual([]);

    const { ctx } = await getPostForViewer(echo.id, null);
    expect(ctx.echoOf?.text).toBe('[deleted]');
    expect(ctx.echoOf?.images).toEqual([]);
  });

  it('hydrates the echoed original when the post is an echo', async () => {
    const origAuthor = await seedUser();
    const echoer = await seedUser();
    const original = await seedPost(origAuthor.id, { text: 'original take' });
    const echo = await seedPost(echoer.id, { text: 'my echo', echoOf: original.id });

    const { ctx } = await getPostForViewer(echo.id, echoer);
    expect(ctx.echoOf?.id).toBe(original.id);
    expect(ctx.echoOf?.text).toBe('original take');
  });

  it('refuses to echo a private post the caller cannot see', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const secret = await seedPost(owner.id, { text: 'keep quiet', visibility: 'private' });

    await expect(
      createPost(
        stranger,
        { text: 'look at this', visibility: 'public', echoOf: secret.id },
        [],
        null,
      ),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'NOT_FOUND', status: 404 });
  });

  it('omits echoOf when the viewer cannot see the original', async () => {
    const owner = await seedUser();
    const echoer = await seedUser();
    const stranger = await seedUser();
    const secret = await seedPost(owner.id, { text: 'keep quiet', visibility: 'private' });
    const echo = await seedPost(echoer.id, {
      text: 'commentary',
      visibility: 'public',
      echoOf: secret.id,
    });

    const { ctx: asStranger } = await getPostForViewer(echo.id, stranger);
    expect(asStranger.echoOf).toBeUndefined();

    const { ctx: asOwner } = await getPostForViewer(echo.id, owner);
    expect(asOwner.echoOf?.text).toBe('keep quiet');
  });

  it('does not notify a mention on a private post the recipient cannot see', async () => {
    const author = await seedUser();
    const mentioned = await seedUser({ username: 'mona', usernameDisplay: 'mona' });

    await createPost(author, { text: 'secret @mona', visibility: 'private' }, [], null);

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, mentioned.id));
    expect(rows).toHaveLength(0);
  });

  it('notifies a mention on a public post', async () => {
    const author = await seedUser();
    const mentioned = await seedUser({ username: 'ada', usernameDisplay: 'ada' });

    await createPost(author, { text: 'hello @ada', visibility: 'public' }, [], null);

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, mentioned.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('mention');
  });

  it('hydratePosts withholds a private original from a stranger on the feed', async () => {
    const owner = await seedUser();
    const echoer = await seedUser();
    const stranger = await seedUser();
    const secret = await seedPost(owner.id, { text: 'keep quiet', visibility: 'private' });
    const echo = await seedPost(echoer.id, {
      text: 'commentary',
      visibility: 'public',
      echoOf: secret.id,
    });

    const asStranger = await hydratePosts([echo], stranger);
    expect(asStranger.get(echo.id)?.echoOf).toBeUndefined();
    const asOwner = await hydratePosts([echo], owner);
    expect(asOwner.get(echo.id)?.echoOf?.text).toBe('keep quiet');
  });

  // ── getShowcasePosts ──────────────────────────────────────────────────────

  it('returns public showcase posts and excludes private/echo/stale ones', async () => {
    const a = await seedUser();
    const b = await seedUser();
    const pub1 = await seedPost(a.id, { text: 'public one', visibility: 'public' });
    const pub2 = await seedPost(b.id, { text: 'public two', visibility: 'public' });
    await seedPost(a.id, { text: 'private secret', visibility: 'private' });
    await seedPost(a.id, { text: 'an echo', echoOf: pub1.id });
    await seedPost(a.id, {
      text: 'too old',
      visibility: 'public',
      createdAt: new Date(Date.now() - 90 * 24 * 3_600_000),
    });

    const out = await getShowcasePosts(null, 'en');
    const ids = out.map((p) => p.id);

    expect(ids).toContain(pub1.id);
    expect(ids).toContain(pub2.id);
    expect(out.every((p) => p.visibility === 'public')).toBe(true);
    expect(out.some((p) => p.text === 'private secret')).toBe(false);
    expect(out.some((p) => p.text === 'too old')).toBe(false);
  });

  it('caps showcase posts at two per author', async () => {
    const a = await seedUser();
    await seedPost(a.id, { text: 'x1' });
    await seedPost(a.id, { text: 'x2' });
    await seedPost(a.id, { text: 'x3' });

    const out = await getShowcasePosts(null, 'en');
    expect(out.filter((p) => p.author.id === a.id).length).toBeLessThanOrEqual(2);
  });

  it('omits reserved-board posts from the showcase', async () => {
    const author = await seedUser();
    const [probes] = await db
      .insert(boards)
      .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
      .returning();
    const organic = await seedPost(author.id, {
      text: 'organic showcase',
      visibility: 'public',
      likeCount: 2,
    });
    await seedPost(author.id, {
      text: 'canary showcase',
      visibility: 'public',
      likeCount: 99,
      commentCount: 99,
      boardId: probes.id,
    });

    const out = await getShowcasePosts(null, 'en');
    const texts = out.map((p) => p.text);
    expect(texts).toContain('organic showcase');
    expect(texts).not.toContain('canary showcase');
    expect(out.some((p) => p.id === organic.id)).toBe(true);
  });

  // ── searchPosts ───────────────────────────────────────────────────────────

  it('searches posts by text with match and no-match cases', async () => {
    const author = await seedUser();
    await seedPost(author.id, { text: 'drizzle is great' });
    await seedPost(author.id, { text: 'unrelated content' });

    const hit = await searchPosts({ q: 'drizzle', limit: 20 }, null);
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0].text).toContain('drizzle');

    const miss = await searchPosts({ q: 'nonexistentterm', limit: 20 }, null);
    expect(miss.items).toEqual([]);
    expect(miss.nextCursor).toBeNull();
  });

  it('filters search results by since (inclusive) and returns empty for a future since', async () => {
    const author = await seedUser();
    const old = await seedPost(author.id, {
      text: 'era match',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const fresh = await seedPost(author.id, {
      text: 'era match',
      createdAt: new Date('2026-10-14T00:00:00Z'),
    });

    const since = await searchPosts(
      { q: 'era', limit: 20, since: new Date('2026-06-01T00:00:00Z') },
      null,
    );
    expect(since.items.map((p) => p.id)).toEqual([fresh.id]);

    const incl = await searchPosts({ limit: 20, since: old.createdAt }, null);
    expect(incl.items).toHaveLength(2);

    const future = await searchPosts(
      { q: 'era', limit: 20, since: new Date('2999-01-01T00:00:00Z') },
      null,
    );
    expect(future.items).toEqual([]);
  });

  it('paginates search results with a cursor', async () => {
    const author = await seedUser();
    const base = Date.parse('2026-01-01T00:00:00Z');
    await db.insert(posts).values([
      { authorId: author.id, text: 'match one', visibility: 'public', createdAt: new Date(base) },
      {
        authorId: author.id,
        text: 'match two',
        visibility: 'public',
        createdAt: new Date(base + 1000),
      },
      {
        authorId: author.id,
        text: 'match three',
        visibility: 'public',
        createdAt: new Date(base + 2000),
      },
    ]);

    const page1 = await searchPosts({ q: 'match', limit: 2 }, null);
    expect(page1.items.map((p) => p.text)).toEqual(['match three', 'match two']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await searchPosts({ q: 'match', cursor: page1.nextCursor!, limit: 2 }, null);
    expect(page2.items.map((p) => p.text)).toEqual(['match one']);
    expect(page2.nextCursor).toBeNull();
  });

  it('applies visibility scoping for an authenticated searcher', async () => {
    const viewer = await seedUser();
    const friend = await seedUser();
    const stranger = await seedUser();
    await db.insert(follows).values({ followerId: viewer.id, followingId: friend.id });
    await seedPost(viewer.id, { text: 'secret mine', visibility: 'private' });
    await seedPost(friend.id, { text: 'secret friends', visibility: 'followers' });
    await seedPost(stranger.id, { text: 'secret stranger', visibility: 'followers' });

    const res = await searchPosts({ q: 'secret', limit: 20 }, viewer);
    const texts = res.items.map((p) => p.text);

    expect(texts).toContain('secret mine'); // own private post
    expect(texts).toContain('secret friends'); // followed author, followers-only
    expect(texts).not.toContain('secret stranger'); // not followed, followers-only
  });

  it('reflects liked and bookmarked state in search results', async () => {
    const author = await seedUser();
    const viewer = await seedUser();
    const post = await seedPost(author.id, { text: 'bookmark me' });
    await db.insert(likes).values({ userId: viewer.id, targetType: 'post', targetId: post.id });
    await db.insert(bookmarks).values({ userId: viewer.id, postId: post.id });

    const res = await searchPosts({ q: 'bookmark', limit: 20 }, viewer);
    expect(res.items[0].likedByMe).toBe(true);
    expect(res.items[0].bookmarkedByMe).toBe(true);
  });

  it('only returns public posts to an anonymous searcher', async () => {
    const author = await seedUser();
    await seedPost(author.id, { text: 'visible topic', visibility: 'public' });
    await seedPost(author.id, { text: 'hidden topic', visibility: 'private' });

    const res = await searchPosts({ q: 'topic', limit: 20 }, null);
    const texts = res.items.map((p) => p.text);
    expect(texts).toContain('visible topic');
    expect(texts).not.toContain('hidden topic');
    expect(res.items[0].bookmarkedByMe).toBe(false);
  });

  it('omits reserved-board posts from anonymous search', async () => {
    const author = await seedUser();
    const [probes] = await db
      .insert(boards)
      .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
      .returning();
    await seedPost(author.id, { text: 'canary balcony', visibility: 'public' });
    await seedPost(author.id, {
      text: 'canary balcony probe',
      visibility: 'public',
      boardId: probes.id,
    });

    const res = await searchPosts({ q: 'balcony', limit: 20 }, null);
    const texts = res.items.map((p) => p.text);
    expect(texts).toContain('canary balcony');
    expect(texts).not.toContain('canary balcony probe');
  });
});
