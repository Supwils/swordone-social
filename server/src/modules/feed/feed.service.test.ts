import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client';
import { boards, follows, posts, tags, users } from '../../db/schema';
import type { PostRow, UserRow } from '../../lib/dto';
import { decodeCursor, decodeScoreCursor } from '../../lib/pagination';
import { resetDb } from '../../test/db-reset';
import { byAuthor, byBoard, byTag, following, getExploreSummary, global } from './feed.service';

// ── seed helpers ─────────────────────────────────────────────────────────────

async function seedUser(
  username: string,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({
      username,
      usernameDisplay: username,
      email: `${username}@example.com`,
      displayName: username,
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
    .values({ authorId, text: 'sample', ...over })
    .returning();
  return p;
}

async function seedFollow(followerId: string, followingId: string): Promise<void> {
  await db.insert(follows).values({ followerId, followingId });
}

async function seedTag(
  slug: string,
  over: Partial<typeof tags.$inferInsert> = {},
): Promise<typeof tags.$inferSelect> {
  const [t] = await db
    .insert(tags)
    .values({ slug, display: slug, ...over })
    .returning();
  return t;
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

describe('feed.service', () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('since filter', () => {
    const OLD = new Date('2026-01-01T00:00:00Z');
    const NEW = new Date('2026-10-14T00:00:00Z');
    const SINCE = new Date('2026-06-01T00:00:00Z');

    async function seedOldAndNew(authorId: string, extra: Partial<typeof posts.$inferInsert> = {}) {
      const old = await seedPost(authorId, { text: 'old', createdAt: OLD, ...extra });
      const fresh = await seedPost(authorId, { text: 'new', createdAt: NEW, ...extra });
      return { old, fresh };
    }

    it('global filters both sort paths', async () => {
      const a = await seedUser('since-global');
      const { fresh } = await seedOldAndNew(a.id);
      const ranked = await global(null, null, 10, 'recommended', SINCE);
      expect(ranked.items.map((p) => p.id)).toEqual([fresh.id]);
      const latest = await global(null, null, 10, 'latest', SINCE);
      expect(latest.items.map((p) => p.id)).toEqual([fresh.id]);
    });

    it('treats since as inclusive and absent since as unfiltered', async () => {
      const a = await seedUser('since-incl');
      const { old, fresh } = await seedOldAndNew(a.id);
      const incl = await global(null, null, 10, 'latest', OLD);
      expect(incl.items.map((p) => p.id).sort()).toEqual([old.id, fresh.id].sort());
      const none = await global(null, null, 10, 'latest');
      expect(none.items).toHaveLength(2);
    });

    it('a future since yields an empty page', async () => {
      const a = await seedUser('since-future');
      await seedOldAndNew(a.id);
      const out = await global(null, null, 10, 'latest', new Date('2999-01-01T00:00:00Z'));
      expect(out.items).toEqual([]);
      expect(out.nextCursor).toBeNull();
    });

    it('following filters', async () => {
      const viewer = await seedUser('since-viewer');
      const a = await seedUser('since-followed');
      await seedFollow(viewer.id, a.id);
      const { fresh } = await seedOldAndNew(a.id);
      const out = await following(viewer, null, 10, 'latest', SINCE);
      expect(out.items.map((p) => p.id)).toEqual([fresh.id]);
    });

    it('byTag filters', async () => {
      const a = await seedUser('since-tag');
      const tag = await seedTag('since-tag-slug');
      const { fresh } = await seedOldAndNew(a.id, { tagIds: [tag.id] });
      const out = await byTag('since-tag-slug', null, null, 10, 'recommended', SINCE);
      expect(out.items.map((p) => p.id)).toEqual([fresh.id]);
    });

    it('byBoard filters', async () => {
      const a = await seedUser('since-board');
      const [board] = await db
        .insert(boards)
        .values({ slug: 'since-board', name: 'Since', sortOrder: 5 })
        .returning();
      const { fresh } = await seedOldAndNew(a.id, { boardId: board.id });
      const out = await byBoard('since-board', null, null, 10, 'latest', SINCE);
      expect(out.items.map((p) => p.id)).toEqual([fresh.id]);
    });

    it('byAuthor filters', async () => {
      const a = await seedUser('since-author');
      const { fresh } = await seedOldAndNew(a.id);
      const out = await byAuthor('since-author', null, null, 10, SINCE);
      expect(out.items.map((p) => p.id)).toEqual([fresh.id]);
    });
  });

  describe('global (ranked / score)', () => {
    it('omits public posts filed to a reserved board', async () => {
      const author = await seedUser('author-reserved');
      const [probes] = await db
        .insert(boards)
        .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
        .returning();
      const visible = await seedPost(author.id, { text: 'ok', feedScore: 10 });
      await seedPost(author.id, { text: 'canary', feedScore: 99, boardId: probes.id });

      const out = await global(null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([visible.id]);
    });

    it('orders by feedScore descending and excludes non-public/non-active posts', async () => {
      const author = await seedUser('author');
      const hi = await seedPost(author.id, { text: 'hi', feedScore: 30 });
      const mid = await seedPost(author.id, { text: 'mid', feedScore: 20 });
      const lo = await seedPost(author.id, { text: 'lo', feedScore: 10 });
      // Should be filtered out:
      await seedPost(author.id, { text: 'followers', feedScore: 99, visibility: 'followers' });
      await seedPost(author.id, { text: 'deleted', feedScore: 99, status: 'deleted' });

      const out = await global(null, null, 10, 'recommended');
      expect(out.items.map((p) => p.id)).toEqual([hi.id, mid.id, lo.id]);
      expect(out.nextCursor).toBeNull();
    });

    it('paginates with a score cursor (page 1 → cursor → page 2)', async () => {
      const author = await seedUser('author');
      const hi = await seedPost(author.id, { feedScore: 30 });
      const mid = await seedPost(author.id, { feedScore: 20 });
      const lo = await seedPost(author.id, { feedScore: 10 });

      const page1 = await global(null, null, 2, 'recommended');
      expect(page1.items.map((p) => p.id)).toEqual([hi.id, mid.id]);
      expect(page1.nextCursor).not.toBeNull();

      const cursor = decodeScoreCursor(page1.nextCursor);
      expect(cursor).not.toBeNull();

      const page2 = await global(null, cursor, 2, 'recommended');
      expect(page2.items.map((p) => p.id)).toEqual([lo.id]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('global (chrono / latest)', () => {
    it('orders by createdAt descending and paginates with a time cursor', async () => {
      const author = await seedUser('author');
      const newest = await seedPost(author.id, { createdAt: ago(0) });
      const middle = await seedPost(author.id, { createdAt: ago(1000) });
      const oldest = await seedPost(author.id, { createdAt: ago(2000) });

      const page1 = await global(null, null, 2, 'latest');
      expect(page1.items.map((p) => p.id)).toEqual([newest.id, middle.id]);
      expect(page1.nextCursor).not.toBeNull();

      const cursor = decodeCursor(page1.nextCursor);
      expect(cursor).not.toBeNull();

      const page2 = await global(null, cursor, 2, 'latest');
      expect(page2.items.map((p) => p.id)).toEqual([oldest.id]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('following (fan-out)', () => {
    it('includes followed authors + self, excludes non-followed and private posts', async () => {
      const viewer = await seedUser('viewer');
      const followed = await seedUser('followed');
      const stranger = await seedUser('stranger');
      await seedFollow(viewer.id, followed.id);

      const own = await seedPost(viewer.id, { text: 'own', feedScore: 5 });
      const followedPub = await seedPost(followed.id, { text: 'fpub', feedScore: 4 });
      const followedFol = await seedPost(followed.id, {
        text: 'ffol',
        feedScore: 3,
        visibility: 'followers',
      });
      const followedPriv = await seedPost(followed.id, {
        text: 'fpriv',
        feedScore: 2,
        visibility: 'private',
      });
      const strangerPost = await seedPost(stranger.id, { text: 'spub', feedScore: 100 });

      const out = await following(viewer, null, 10, 'recommended');
      const ids = out.items.map((p) => p.id);
      expect(ids).toContain(own.id);
      expect(ids).toContain(followedPub.id);
      expect(ids).toContain(followedFol.id); // followers-visibility from a followed author
      expect(ids).not.toContain(followedPriv.id); // private excluded
      expect(ids).not.toContain(strangerPost.id); // not followed
    });

    it('omits reserved-board posts from a followed author', async () => {
      const viewer = await seedUser('viewer-probe');
      const followed = await seedUser('attacker');
      await seedFollow(viewer.id, followed.id);
      const [probes] = await db
        .insert(boards)
        .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
        .returning();
      const visible = await seedPost(followed.id, { text: 'organic', feedScore: 10 });
      await seedPost(followed.id, { text: 'canary', feedScore: 99, boardId: probes.id });

      const out = await following(viewer, null, 10, 'recommended');
      expect(out.items.map((p) => p.id)).toEqual([visible.id]);
    });

    it('returns only own posts when the viewer follows nobody (chrono sort)', async () => {
      const lonely = await seedUser('lonely');
      const other = await seedUser('other');
      const own = await seedPost(lonely.id, { text: 'mine' });
      await seedPost(other.id, { text: 'theirs', feedScore: 50 });

      const out = await following(lonely, null, 10, 'latest');
      expect(out.items.map((p) => p.id)).toEqual([own.id]);
    });
  });

  describe('byTag', () => {
    it('returns posts overlapping the tag (incl. aliases) and skips non-matches', async () => {
      const author = await seedUser('author');
      const tag = await seedTag('typescript', { aliasIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'] });

      const direct = await seedPost(author.id, { text: 'direct', tagIds: [tag.id], feedScore: 10 });
      const viaAlias = await seedPost(author.id, {
        text: 'alias',
        tagIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
        feedScore: 9,
      });
      await seedPost(author.id, { text: 'other', tagIds: ['bbbbbbbbbbbbbbbbbbbbbbbb'] });
      await seedPost(author.id, { text: 'untagged' });

      const out = await byTag('TypeScript', null, null, 10); // upper-case slug → lowercased
      const ids = out.items.map((p) => p.id).sort();
      expect(ids).toEqual([direct.id, viaAlias.id].sort());
    });

    it('omits reserved-board posts even when they carry the tag', async () => {
      const author = await seedUser('tag-probe');
      const tag = await seedTag('garden');
      const [probes] = await db
        .insert(boards)
        .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
        .returning();
      const visible = await seedPost(author.id, {
        text: 'organic garden',
        tagIds: [tag.id],
        feedScore: 10,
      });
      await seedPost(author.id, {
        text: 'canary garden',
        tagIds: [tag.id],
        feedScore: 99,
        boardId: probes.id,
      });

      const out = await byTag('garden', null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([visible.id]);
    });

    it('rejects an unknown tag slug with 404', async () => {
      await expect(byTag('does-not-exist', null, null, 10)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('byBoard', () => {
    async function seedBoard(slug: string, sortOrder = 0) {
      const [b] = await db.insert(boards).values({ slug, name: slug, sortOrder }).returning();
      return b;
    }

    it('still serves reserved-board posts when that board is requested by slug', async () => {
      const author = await seedUser('author-probe');
      const probes = await seedBoard('probes', 99);
      const canary = await seedPost(author.id, {
        text: 'canary',
        boardId: probes.id,
        feedScore: 1,
      });

      const out = await byBoard('probes', null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([canary.id]);
    });

    it('returns only posts in that board, excluding other boards and unassigned', async () => {
      const author = await seedUser('author');
      const market = await seedBoard('market', 1);
      const living = await seedBoard('living', 5);

      const mine = await seedPost(author.id, {
        text: 'in market',
        boardId: market.id,
        feedScore: 10,
      });
      await seedPost(author.id, { text: 'in living', boardId: living.id, feedScore: 9 });
      await seedPost(author.id, { text: 'no board' });

      const out = await byBoard('market', null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([mine.id]);
    });

    it('lowercases the slug like byTag does', async () => {
      const author = await seedUser('author2');
      const market = await seedBoard('market', 1);
      const p = await seedPost(author.id, { text: 'x', boardId: market.id, feedScore: 1 });

      const out = await byBoard('MARKET', null, null, 10);
      expect(out.items.map((i) => i.id)).toEqual([p.id]);
    });

    it('rejects an unknown board slug with 404', async () => {
      await expect(byBoard('does-not-exist', null, null, 10)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('defaults to the ranked order when no sort is given', async () => {
      const author = await seedUser('author3');
      const market = await seedBoard('market', 1);
      const hi = await seedPost(author.id, { boardId: market.id, feedScore: 30 });
      const lo = await seedPost(author.id, { boardId: market.id, feedScore: 10 });

      const out = await byBoard('market', null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([hi.id, lo.id]);
    });

    it("orders by createdAt descending under sort='latest'", async () => {
      const author = await seedUser('author4');
      const market = await seedBoard('market', 1);
      const newest = await seedPost(author.id, { boardId: market.id, createdAt: ago(0) });
      const middle = await seedPost(author.id, { boardId: market.id, createdAt: ago(1000) });
      const oldest = await seedPost(author.id, { boardId: market.id, createdAt: ago(2000) });

      const out = await byBoard('market', null, null, 10, 'latest');
      expect(out.items.map((p) => p.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it("paginates with a TIME cursor under sort='latest'", async () => {
      const author = await seedUser('author5');
      const market = await seedBoard('market', 1);
      const newest = await seedPost(author.id, { boardId: market.id, createdAt: ago(0) });
      const middle = await seedPost(author.id, { boardId: market.id, createdAt: ago(1000) });
      const oldest = await seedPost(author.id, { boardId: market.id, createdAt: ago(2000) });

      const page1 = await byBoard('market', null, null, 2, 'latest');
      expect(page1.items.map((p) => p.id)).toEqual([newest.id, middle.id]);
      expect(page1.nextCursor).not.toBeNull();

      // decodeCursor, not decodeScoreCursor: a `latest` page emits a TIME
      // cursor, which is why the route has to pick its decoder off the sort.
      const cursor = decodeCursor(page1.nextCursor);
      expect(cursor).not.toBeNull();

      const page2 = await byBoard('market', null, cursor, 2, 'latest');
      expect(page2.items.map((p) => p.id)).toEqual([oldest.id]);
      expect(page2.nextCursor).toBeNull();
    });

    it('gives a different slice for latest than for recommended', async () => {
      // The regression that mattered (2026-08-19): `byBoard` ignored `sort`
      // entirely, so the two agent-context passes over one board returned the
      // same posts in the same order and the prompt rendered them twice.
      // feedScore is seeded INVERSE to recency, so the two orders can only
      // agree if one of them is not being applied.
      const author = await seedUser('author6');
      const market = await seedBoard('market', 1);
      const newestLowScore = await seedPost(author.id, {
        boardId: market.id,
        createdAt: ago(0),
        feedScore: 1,
      });
      const oldestHighScore = await seedPost(author.id, {
        boardId: market.id,
        createdAt: ago(2000),
        feedScore: 99,
      });

      const ranked = await byBoard('market', null, null, 10, 'recommended');
      const chrono = await byBoard('market', null, null, 10, 'latest');

      expect(ranked.items.map((p) => p.id)).toEqual([oldestHighScore.id, newestLowScore.id]);
      expect(chrono.items.map((p) => p.id)).toEqual([newestLowScore.id, oldestHighScore.id]);
      expect(ranked.items.map((p) => p.id)).not.toEqual(chrono.items.map((p) => p.id));
    });
  });

  describe('byAuthor (visibility)', () => {
    async function seedAuthorWithPosts() {
      const author = await seedUser('poster');
      const pub = await seedPost(author.id, { text: 'pub', createdAt: ago(0) });
      const fol = await seedPost(author.id, {
        text: 'fol',
        visibility: 'followers',
        createdAt: ago(1000),
      });
      const priv = await seedPost(author.id, {
        text: 'priv',
        visibility: 'private',
        createdAt: ago(2000),
      });
      await seedPost(author.id, { text: 'gone', status: 'deleted' });
      return { author, pub, fol, priv };
    }

    it('omits reserved-board posts from a public profile feed', async () => {
      const author = await seedUser('probe-author');
      const [probes] = await db
        .insert(boards)
        .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
        .returning();
      const visible = await seedPost(author.id, { text: 'organic', createdAt: ago(0) });
      await seedPost(author.id, {
        text: 'canary',
        createdAt: ago(1000),
        boardId: probes.id,
      });

      const out = await byAuthor(author.username, null, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([visible.id]);
    });

    it('anonymous viewer sees only public posts', async () => {
      const { pub } = await seedAuthorWithPosts();
      const out = await byAuthor('POSTER', null, null, 10); // upper-case → lowercased
      expect(out.items.map((p) => p.id)).toEqual([pub.id]);
    });

    it('a stranger (non-follower) sees only public posts', async () => {
      const { author, pub } = await seedAuthorWithPosts();
      const stranger = await seedUser('stranger');
      const out = await byAuthor(author.username, stranger, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([pub.id]);
    });

    it('a follower additionally sees followers-only posts', async () => {
      const { author, pub, fol, priv } = await seedAuthorWithPosts();
      const follower = await seedUser('follower');
      await seedFollow(follower.id, author.id);
      const out = await byAuthor(author.username, follower, null, 10);
      const ids = out.items.map((p) => p.id);
      expect(ids).toEqual([pub.id, fol.id]); // chrono desc, private excluded
      expect(ids).not.toContain(priv.id);
    });

    it('the author sees their own public, followers, and private posts', async () => {
      const { author, pub, fol, priv } = await seedAuthorWithPosts();
      const out = await byAuthor(author.username, author, null, 10);
      expect(out.items.map((p) => p.id)).toEqual([pub.id, fol.id, priv.id]);
    });

    it('rejects an unknown / non-active author with 404', async () => {
      await expect(byAuthor('ghost', null, null, 10)).rejects.toMatchObject({ status: 404 });
      const suspended = await seedUser('banned', { status: 'suspended' });
      await expect(byAuthor(suspended.username, null, null, 10)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('getExploreSummary (distinct-author slice)', () => {
    // NOTE: getExploreSummary is backed by a module-level 60s TTLCache keyed
    // 'global'. It must be called at most once per test file to stay
    // deterministic — everything is seeded before the single call below.
    it('summarizes agents (latest post per author), trending tags, and a featured post', async () => {
      const viewer = await seedUser('viewer');
      const agent = await seedUser('agentbot', { isAgent: true, agentBackend: 'claude' });
      // A second agent with no backend and no posts covers the falsy arms of the
      // `agentBackend ? …` and `latest ? …` conditionals in the agents mapping.
      const bareAgent = await seedUser('bareagent', { isAgent: true });
      const human = await seedUser('humanguy');
      const sealed = await seedUser('sealedbot', { isAgent: true, archivedAt: new Date() });

      // Agent has two posts; distinct-on(author) must surface the newest.
      await seedPost(agent.id, { text: 'first agent post', createdAt: ago(2000), feedScore: 1 });
      const latestAgentPost = await seedPost(agent.id, {
        text: 'second agent post',
        createdAt: ago(1000),
        feedScore: 50,
      });
      // Human post must NOT appear in the agents slice.
      await seedPost(human.id, { text: 'human post', feedScore: 99 });

      const tag = await seedTag('rust', { postCount: 7, display: 'Rust' });

      // A featured topic with a pinned post exercises the pinned-hydration path.
      const pinned = await seedPost(human.id, { text: 'pinned post' });
      const [probes] = await db
        .insert(boards)
        .values({ slug: 'probes', name: 'Probes', sortOrder: 99 })
        .returning();
      const canaryPinned = await seedPost(human.id, {
        text: 'canary pinned',
        boardId: probes.id,
      });
      const featuredTag = await seedTag('golang', {
        display: 'Go',
        postCount: 3,
        featured: true,
        pinnedPostIds: [pinned.id, canaryPinned.id],
      });

      const summary = await getExploreSummary(viewer);

      const agentEntry = summary.agents.find((a) => a.id === agent.id);
      expect(agentEntry).toBeDefined();
      expect(agentEntry?.agentBackend).toBe('claude');
      expect(agentEntry?.latestPostId).toBe(latestAgentPost.id);
      expect(agentEntry?.latestPostExcerpt).toBe('second agent post');

      const bareEntry = summary.agents.find((a) => a.id === bareAgent.id);
      expect(bareEntry).toBeDefined();
      expect(bareEntry?.agentBackend).toBeUndefined();
      expect(bareEntry?.latestPostId).toBeNull();
      expect(bareEntry?.latestPostExcerpt).toBeNull();

      expect(summary.agents.find((a) => a.id === human.id)).toBeUndefined();
      expect(summary.agents.find((a) => a.id === sealed.id)).toBeUndefined();
      expect(summary.trendingTags.map((t) => t.slug)).toContain(tag.slug);
      expect(summary.featuredPost).not.toBeNull();

      const topic = summary.featuredTopics.find((t) => t.slug === featuredTag.slug);
      expect(topic).toBeDefined();
      expect(topic?.pinnedPosts.map((p) => p.id)).toEqual([pinned.id]);
    });
  });
});
