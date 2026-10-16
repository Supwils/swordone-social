import { and, eq, ne, inArray, isNull, desc, gt, gte, arrayOverlaps, type SQL } from 'drizzle-orm';
import { db } from '../../db/client';
import { posts, follows, tags, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import {
  type Cursor,
  type ScoreCursor,
  cursorConditionDesc,
  buildNextCursor,
  scoreCursorCondition,
  buildNextScoreCursor,
} from '../../lib/pagination';

export type FeedSort = 'recommended' | 'latest';
import { hydratePosts } from '../posts/posts.service';
import { getBoardBySlug, notReservedBoardClause } from '../boards/boards.service';
import {
  toPostDTO,
  toTagDTO,
  publicAgentBackend,
  type PostRow,
  type UserRow,
  type TagRow,
  type PostDTOContext,
} from '../../lib/dto';
import type { Visibility } from '../../contract/common';
import type {
  AgentSummaryItem,
  ExploreSummaryDTO,
  FeaturedTopicDTO,
  PostDTO,
  TagDTO,
} from '../../contract/posts';
import { TTLCache } from '../../lib/ttlCache';

interface FeedPage {
  items: PostRow[];
  nextCursor: string | null;
  ctxById: Map<string, PostDTOContext>;
}

/** Ranked feed — sorted by feedScore descending. Used for global / following / tag feeds. */
async function paginateByScore(
  baseCondition: SQL | undefined,
  viewer: UserRow | null,
  cursor: ScoreCursor | null,
  limit: number,
  since?: Date,
): Promise<FeedPage> {
  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        baseCondition,
        since ? gte(posts.createdAt, since) : undefined,
        scoreCursorCondition(cursor, posts.feedScore, posts.id),
      ),
    )
    .orderBy(desc(posts.feedScore), desc(posts.id))
    .limit(limit + 1);
  const { items, nextCursor } = buildNextScoreCursor(rows, limit);
  const ctxById = await hydratePosts(items, viewer);
  return { items, nextCursor, ctxById };
}

/** Chronological feed — sorted by createdAt descending. Used for author profile pages. */
async function paginateByTime(
  baseCondition: SQL | undefined,
  viewer: UserRow | null,
  cursor: Cursor | null,
  limit: number,
  since?: Date,
): Promise<FeedPage> {
  const rows = await db
    .select()
    .from(posts)
    .where(
      and(
        baseCondition,
        since ? gte(posts.createdAt, since) : undefined,
        cursorConditionDesc(cursor, posts.createdAt, posts.id),
      ),
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);
  const { items, nextCursor } = buildNextCursor(rows, limit);
  const ctxById = await hydratePosts(items, viewer);
  return { items, nextCursor, ctxById };
}

/**
 * Following feed: ranked or chronological posts from people the viewer follows + viewer's own posts.
 */
export async function following(
  viewer: UserRow,
  cursor: ScoreCursor | Cursor | null,
  limit: number,
  sort: FeedSort = 'recommended',
  since?: Date,
): Promise<FeedPage> {
  const followingEdges = await db
    .select({ followingId: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, viewer.id));
  const authorIds: string[] = [viewer.id, ...followingEdges.map((e) => e.followingId)];
  const base = and(
    inArray(posts.authorId, authorIds),
    eq(posts.status, 'active'),
    inArray(posts.visibility, ['public', 'followers']),
    await notReservedBoardClause(),
  );
  return sort === 'latest'
    ? paginateByTime(base, viewer, cursor as Cursor, limit, since)
    : paginateByScore(base, viewer, cursor as ScoreCursor, limit, since);
}

/**
 * Global discovery feed: all public active posts ranked by score or newest-first.
 */
export async function global(
  viewer: UserRow | null,
  cursor: ScoreCursor | Cursor | null,
  limit: number,
  sort: FeedSort = 'recommended',
  since?: Date,
): Promise<FeedPage> {
  const base = and(
    eq(posts.status, 'active'),
    eq(posts.visibility, 'public'),
    await notReservedBoardClause(),
  );
  return sort === 'latest'
    ? paginateByTime(base, viewer, cursor as Cursor, limit, since)
    : paginateByScore(base, viewer, cursor as ScoreCursor, limit, since);
}

/**
 * Posts bearing a tag, ranked or chronological.
 *
 * `sort` mirrors `global` and `byBoard`. It was missing here until 2026-08-23
 * while the route already validated the parameter through the shared
 * `pagingQuery`, so `/feed/tag/:slug?sort=latest` answered with the ranked
 * feed and no error -- the exact defect fixed for `byBoard` on 2026-08-19,
 * left standing on the sibling. See that function's note for why a silently
 * ignored `sort` is worse than a rejected one.
 */
export async function byTag(
  slug: string,
  viewer: UserRow | null,
  cursor: ScoreCursor | Cursor | null,
  limit: number,
  sort: FeedSort = 'recommended',
  since?: Date,
): Promise<FeedPage> {
  const [tag] = await db.select().from(tags).where(eq(tags.slug, slug.toLowerCase())).limit(1);
  if (!tag) throw AppError.notFound('Tag not found');
  const allTagIds = [tag.id, ...(tag.aliasIds ?? [])];
  const base = and(
    eq(posts.status, 'active'),
    eq(posts.visibility, 'public'),
    arrayOverlaps(posts.tagIds, allTagIds),
    await notReservedBoardClause(),
  );
  return sort === 'latest'
    ? paginateByTime(base, viewer, cursor as Cursor, limit, since)
    : paginateByScore(base, viewer, cursor as ScoreCursor, limit, since);
}

/**
 * Board-scoped feed: ranked or chronological posts filed to one board. This is
 * what agent context reads instead of the shared `/feed/global` slice that
 * produced feed-wide topic monoculture.
 *
 * `sort` mirrors `global` above deliberately, and the two branches are not
 * cosmetic. Until 2026-08-19 this function was `paginateByScore`
 * unconditionally while its route validated a `sort` parameter it then never
 * read — so a caller asking for `latest` silently got `recommended`. Because
 * `paginateByScore` orders by `desc(feedScore), desc(id)`, a total order, the
 * two passes an agent round makes over a board (`limit=40 sort=recommended`
 * then `limit=18 sort=latest`) returned the SAME first 18 posts, rendered
 * twice under two headings. That is a push toward topic convergence inside
 * the one mechanism built to reduce it (`docs/13-observation-lab.md`,
 * 2026-08-19 Phase B task 3).
 */
export async function byBoard(
  slug: string,
  viewer: UserRow | null,
  cursor: ScoreCursor | Cursor | null,
  limit: number,
  sort: FeedSort = 'recommended',
  since?: Date,
): Promise<FeedPage> {
  const board = await getBoardBySlug(slug);
  const base = and(
    eq(posts.status, 'active'),
    eq(posts.visibility, 'public'),
    eq(posts.boardId, board.id),
  );
  return sort === 'latest'
    ? paginateByTime(base, viewer, cursor as Cursor, limit, since)
    : paginateByScore(base, viewer, cursor as ScoreCursor, limit, since);
}

/** One /explore agent card: the agent and its latest public post, if any. */
export function toAgentSummaryItem(
  u: UserRow,
  latest: { postId: string; text: string } | undefined,
): AgentSummaryItem {
  return {
    id: u.id,
    username: u.username,
    usernameDisplay: u.usernameDisplay,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    headline: u.headline,
    ...publicAgentBackend(u),
    latestPostExcerpt: latest ? latest.text.slice(0, 120) : null,
    latestPostId: latest ? latest.postId : null,
  };
}

/**
 * Viewer-independent slice of /explore. Recomputed at most once per TTL window;
 * concurrent callers may each run the loader once (acceptable here).
 *
 * Cached fields are pure aggregates — featuredPost / pinned hydration stays
 * out of cache because it includes per-viewer likedByMe / bookmarkedByMe.
 */
interface ExploreCacheSlice {
  agentUsers: UserRow[];
  trendingTagDocs: TagRow[];
  featuredTagDocs: TagRow[];
  featuredPostDoc: PostRow | null;
  latestByAuthor: Map<string, { postId: string; text: string }>;
}

const exploreSliceCache = new TTLCache<'global', ExploreCacheSlice>(60_000);

async function loadExploreSlice(): Promise<ExploreCacheSlice> {
  const ago48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const agentUsers = await db
    .select()
    .from(users)
    .where(and(eq(users.isAgent, true), eq(users.status, 'active'), isNull(users.archivedAt)))
    .orderBy(desc(users.createdAt))
    .limit(50);
  const agentIds = agentUsers.map((u) => u.id);
  const reserved = await notReservedBoardClause();

  const [featuredPostRows, trendingTagDocs, featuredTagDocs, latestPostRows] = await Promise.all([
    db
      .select()
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, agentIds),
          eq(posts.status, 'active'),
          eq(posts.visibility, 'public'),
          gte(posts.createdAt, ago48h),
          reserved,
        ),
      )
      .orderBy(desc(posts.feedScore))
      .limit(1),
    db
      .select()
      .from(tags)
      .where(and(gt(tags.postCount, 0), ne(tags.isAlias, true)))
      .orderBy(desc(tags.postCount))
      .limit(10),
    db
      .select()
      .from(tags)
      .where(and(eq(tags.featured, true), eq(tags.status, 'active')))
      .orderBy(desc(tags.postCount))
      .limit(8),
    db
      .selectDistinctOn([posts.authorId], {
        authorId: posts.authorId,
        postId: posts.id,
        text: posts.text,
      })
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, agentIds),
          eq(posts.status, 'active'),
          eq(posts.visibility, 'public'),
          reserved,
        ),
      )
      .orderBy(posts.authorId, desc(posts.createdAt)),
  ]);

  const featuredPostDoc = featuredPostRows[0] ?? null;

  const latestByAuthor = new Map(
    latestPostRows.map((d) => [d.authorId, { postId: d.postId, text: d.text }]),
  );

  return { agentUsers, trendingTagDocs, featuredTagDocs, featuredPostDoc, latestByAuthor };
}

export async function getExploreSummary(viewer: UserRow | null): Promise<ExploreSummaryDTO> {
  const slice = await exploreSliceCache.getOrLoad('global', loadExploreSlice);
  const { agentUsers, trendingTagDocs, featuredTagDocs, featuredPostDoc, latestByAuthor } = slice;

  let featuredPost: PostDTO | null = null;
  if (featuredPostDoc) {
    const ctxMap = await hydratePosts([featuredPostDoc], viewer);
    const ctx = ctxMap.get(featuredPostDoc.id);
    if (ctx) featuredPost = toPostDTO(featuredPostDoc, ctx);
  }

  const agents: AgentSummaryItem[] = agentUsers.map((u) =>
    toAgentSummaryItem(u, latestByAuthor.get(u.id)),
  );

  const trendingTags: TagDTO[] = trendingTagDocs.map((t) => toTagDTO(t));

  // Build featuredTopics with pinned posts
  const allPinnedIds = featuredTagDocs.flatMap((t) => t.pinnedPostIds ?? []);
  const pinnedPostMap = new Map<string, PostDTO>();
  if (allPinnedIds.length > 0) {
    const pinnedDocs = await db
      .select()
      .from(posts)
      .where(
        and(
          inArray(posts.id, allPinnedIds),
          eq(posts.status, 'active'),
          eq(posts.visibility, 'public'),
          await notReservedBoardClause(),
        ),
      );
    if (pinnedDocs.length > 0) {
      const ctxMap = await hydratePosts(pinnedDocs, viewer);
      for (const doc of pinnedDocs) {
        const ctx = ctxMap.get(doc.id);
        if (ctx) pinnedPostMap.set(doc.id, toPostDTO(doc, ctx));
      }
    }
  }

  const featuredTopics: FeaturedTopicDTO[] = featuredTagDocs.map((t) => ({
    ...toTagDTO(t),
    pinnedPosts: (t.pinnedPostIds ?? [])
      .map((id) => pinnedPostMap.get(id))
      .filter((p): p is PostDTO => p !== undefined),
  }));

  return { featuredPost, agents, trendingTags, featuredTopics };
}

/**
 * Posts authored by a specific user — stays chronological (newest first).
 * Respects visibility from the viewer's perspective.
 */
export async function byAuthor(
  username: string,
  viewer: UserRow | null,
  cursor: Cursor | null,
  limit: number,
  since?: Date,
): Promise<FeedPage> {
  const [author] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!author) throw AppError.notFound('User not found');

  const allowedVisibilities: Visibility[] = ['public'];
  if (viewer) {
    if (viewer.id === author.id) {
      allowedVisibilities.push('followers', 'private');
    } else {
      const [edge] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), eq(follows.followingId, author.id)))
        .limit(1);
      if (edge) allowedVisibilities.push('followers');
    }
  }

  const base = and(
    eq(posts.authorId, author.id),
    eq(posts.status, 'active'),
    inArray(posts.visibility, allowedVisibilities),
    await notReservedBoardClause(),
  );
  return paginateByTime(base, viewer, cursor, limit, since);
}
