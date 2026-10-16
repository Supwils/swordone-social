import { and, or, eq, inArray, isNull, gte, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/client';
import { posts } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { decodeCursor, buildNextCursor, cursorConditionDesc } from '../../lib/pagination';
import { escapeLike } from '../../lib/sql';
import { translatePostsForRead } from '../../lib/translate';
import type { ReadTranslation } from '../../lib/lang';
import type { PostDTOContext, PostDTO, PostRow, UserRow } from '../../lib/dto';
import { notReservedBoardClause } from '../boards/boards.service';
import type { SearchPostsQuery } from './posts.schemas';
import { hydratePosts, toPostDTOs } from './posts.hydrate';
import { assertVisibility, followedAuthorsSubquery } from './posts.visibility';

/**
 * One post as a viewer may see it, hydrated by the same `hydratePosts` every
 * feed uses — so `likedByMe`, `bookmarkedByMe` and the embedded `echoOf` agree
 * with the feed's copy of the same post. (A hand-rolled hydrate here drifted:
 * it never set `bookmarkedByMe`, and embedded an echo original whatever its
 * status.)
 */
export async function getPostForViewer(
  postId: string,
  viewer: UserRow | null,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  const ctx = (await hydratePosts([post], viewer)).get(post.id);
  if (!ctx) throw AppError.notFound('Author missing');
  return { post, ctx };
}

export async function getShowcasePosts(
  viewer: UserRow | null,
  translate: ReadTranslation | null,
): Promise<PostDTO[]> {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3_600_000);

  const candidates = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.status, 'active'),
        eq(posts.visibility, 'public'),
        isNull(posts.echoOf),
        gte(posts.createdAt, sixtyDaysAgo),
        notReservedBoardClause(),
      ),
    )
    .orderBy(desc(posts.feedScore), desc(posts.id))
    .limit(120);

  // Compute showcase score in memory:
  // - comments weighted 3× (vs 2× in feedScore) — active discussion = platform health
  // - image bonus 1.5× — visual richness matters for a public showcase
  // - softer time decay (1.1, 48h offset) — allows quality older content to surface
  const now = Date.now();
  const scored = candidates.map((p) => {
    const ageHours = (now - new Date(p.createdAt).getTime()) / 3_600_000;
    const engagement = p.likeCount + p.commentCount * 3 + p.repostCount * 2 + 1;
    const imageBonus = p.images.length > 0 ? 1.5 : 1.0;
    const score = (engagement * imageBonus) / Math.pow(ageHours + 48, 1.1);
    return { post: p, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Author diversity: cap at 2 posts per author
  const authorCount = new Map<string, number>();
  const diverse: PostRow[] = [];
  for (const { post } of scored) {
    const aid = post.authorId;
    const n = authorCount.get(aid) ?? 0;
    if (n < 2) {
      diverse.push(post);
      authorCount.set(aid, n + 1);
    }
  }

  // Tier-based Fisher-Yates shuffle for variety across refreshes
  const tierSize = Math.ceil(diverse.length / 3);
  const shuffled: PostRow[] = [];
  for (let t = 0; t < 3; t++) {
    const tier = diverse.slice(t * tierSize, (t + 1) * tierSize);
    for (let i = tier.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tier[i], tier[j]] = [tier[j], tier[i]];
    }
    shuffled.push(...tier);
  }

  const pagePosts = shuffled.slice(0, 24);
  const ctxMap = await hydratePosts(pagePosts, viewer);
  await translatePostsForRead(pagePosts, ctxMap, translate);

  return toPostDTOs(pagePosts, ctxMap);
}

export async function searchPosts(
  query: SearchPostsQuery,
  viewer: UserRow | null,
  translate?: ReadTranslation | null,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.cursor);
  const limit = query.limit ?? 20;
  const q = query.q?.trim();

  // Followers-only posts by followed authors: the follow list stays in SQL.
  const visibilityClause = viewer
    ? or(
        eq(posts.visibility, 'public'),
        eq(posts.authorId, viewer.id),
        and(
          eq(posts.visibility, 'followers'),
          inArray(posts.authorId, followedAuthorsSubquery(viewer.id)),
        ),
      )
    : eq(posts.visibility, 'public');

  const where = and(
    eq(posts.status, 'active'),
    q ? ilike(posts.text, `%${escapeLike(q)}%`) : undefined,
    visibilityClause,
    cursorConditionDesc(cursor, posts.createdAt, posts.id),
    query.since ? gte(posts.createdAt, query.since) : undefined,
    notReservedBoardClause(),
  );

  const rawPosts = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  const { items: pagePosts, nextCursor } = buildNextCursor(rawPosts, limit);
  const ctxMap = await hydratePosts(pagePosts, viewer);
  await translatePostsForRead(pagePosts, ctxMap, translate);

  const items = toPostDTOs(pagePosts, ctxMap);

  return { items, nextCursor };
}
