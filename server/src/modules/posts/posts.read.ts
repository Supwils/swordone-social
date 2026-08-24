import { and, or, eq, inArray, isNull, gte, lt, desc, ilike } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, posts, tags, likes, follows } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { decodeCursor, buildNextCursor } from '../../lib/pagination';
import { translatePosts } from '../../lib/translate';
import {
  toPostDTO,
  type PostDTOContext,
  type PostDTO,
  type PostRow,
  type UserRow,
  type TagRow,
} from '../../lib/dto';
import { notReservedBoardClause } from '../boards/boards.service';
import type { SearchPostsQuery } from './posts.schemas';
import { hydratePosts } from './posts.hydrate';
import { assertVisibility } from './posts.write';
import { canViewPost, followingSet } from './posts.visibility';

/** Escape LIKE/ILIKE wildcards so user input can't inject `%` / `_` patterns. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export async function getPostForViewer(
  postId: string,
  viewer: UserRow | null,
): Promise<{ post: PostRow; ctx: PostDTOContext }> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== 'active') throw AppError.notFound('Post not found');
  await assertVisibility(post, viewer);

  const [authorRows, tagRows, mentionRows, likedByMe] = await Promise.all([
    db.select().from(users).where(eq(users.id, post.authorId)).limit(1),
    post.tagIds.length
      ? db.select().from(tags).where(inArray(tags.id, post.tagIds))
      : Promise.resolve([] as TagRow[]),
    post.mentionIds.length
      ? db.select().from(users).where(inArray(users.id, post.mentionIds))
      : Promise.resolve([] as UserRow[]),
    viewer
      ? db
          .select({ id: likes.id })
          .from(likes)
          .where(
            and(
              eq(likes.userId, viewer.id),
              eq(likes.targetType, 'post'),
              eq(likes.targetId, post.id),
            ),
          )
          .limit(1)
          .then((r) => r.length > 0)
      : Promise.resolve(false),
  ]);
  const author = authorRows[0];
  if (!author) throw AppError.notFound('Author missing');

  let echoOfDto: PostDTO | undefined;
  if (post.echoOf) {
    const [origPost] = await db.select().from(posts).where(eq(posts.id, post.echoOf)).limit(1);
    if (origPost) {
      const followAuthors = origPost.visibility === 'followers' ? [origPost.authorId] : [];
      const following = await followingSet(viewer, followAuthors);
      if (canViewPost(origPost, viewer, following)) {
        const [origAuthor] = await db
          .select()
          .from(users)
          .where(eq(users.id, origPost.authorId))
          .limit(1);
        if (origAuthor) {
          echoOfDto = toPostDTO(origPost, {
            author: origAuthor,
            tags: [],
            mentions: [],
            likedByMe: false,
          });
        }
      }
    }
  }

  return {
    post,
    ctx: { author, tags: tagRows, mentions: mentionRows, likedByMe, echoOf: echoOfDto },
  };
}

export async function getShowcasePosts(
  viewer: UserRow | null,
  lang: string,
  content = true,
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
        await notReservedBoardClause(),
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
  await translatePosts(pagePosts, ctxMap, lang, { content });

  return pagePosts
    .map((p) => {
      const ctx = ctxMap.get(p.id);
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);
}

export async function searchPosts(
  query: SearchPostsQuery,
  viewer: UserRow | null,
): Promise<{ items: PostDTO[]; nextCursor: string | null }> {
  const cursor = decodeCursor(query.cursor);
  const limit = query.limit ?? 20;
  const q = query.q?.trim();

  let visibilityClause;
  if (viewer) {
    const followingRows = await db
      .select({ followingId: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, viewer.id));
    const followingIds = followingRows.map((f) => f.followingId);
    visibilityClause = or(
      eq(posts.visibility, 'public'),
      eq(posts.authorId, viewer.id),
      followingIds.length
        ? and(eq(posts.visibility, 'followers'), inArray(posts.authorId, followingIds))
        : undefined,
    );
  } else {
    visibilityClause = eq(posts.visibility, 'public');
  }

  const cursorClause = cursor
    ? or(
        lt(posts.createdAt, new Date(cursor.t)),
        and(eq(posts.createdAt, new Date(cursor.t)), lt(posts.id, cursor.id)),
      )
    : undefined;

  const where = and(
    eq(posts.status, 'active'),
    q ? ilike(posts.text, `%${escapeLike(q)}%`) : undefined,
    visibilityClause,
    cursorClause,
    await notReservedBoardClause(),
  );

  const rawPosts = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1);

  const { items: pagePosts, nextCursor } = buildNextCursor(rawPosts, limit);
  const ctxMap = await hydratePosts(pagePosts, viewer);

  const items = pagePosts
    .map((p) => {
      const ctx = ctxMap.get(p.id);
      return ctx ? toPostDTO(p, ctx) : null;
    })
    .filter((x): x is PostDTO => x !== null);

  return { items, nextCursor };
}
