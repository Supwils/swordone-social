/**
 * Interaction graph between lab accounts.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { and, eq, gte, isNotNull, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client';
import { comments, likes, posts } from '../../../db/schema';
import { TTLCache } from '../../../lib/ttlCache';
import { loadLabUsers } from '../lab/shared';
import type { GraphEdgeDTO, GraphNodeDTO, InteractionGraphDTO } from './population.types';
import type { LabEra } from '../lab/era';

// Self-join aliases (reply → parent comment author, echo → original post author).
const parentComments = alias(comments, 'parent_comment');
const origPosts = alias(posts, 'orig_post');

/* ---------- interaction graph (Feature 2) ---------- */

const graphCache = new TTLCache<string, InteractionGraphDTO>(60_000);

/** Test hook — the 60s TTL would otherwise replay one test's payload in the next. */
export function clearInteractionGraphCache(): void {
  graphCache.clear();
}

export async function getInteractionGraph(
  range: '7d' | '30d' | '90d' = '30d',
  era: LabEra = 3,
): Promise<InteractionGraphDTO> {
  return graphCache.getOrLoad(`${range}:${era}`, () => computeInteractionGraph(range, era));
}

type EdgeKind = 'comment' | 'reply' | 'echo' | 'like';

async function computeInteractionGraph(
  range: '7d' | '30d' | '90d',
  era: LabEra,
): Promise<InteractionGraphDTO> {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [commentEdges, replyEdges, echoEdges, likeEdges] = await Promise.all([
    // top-level comments → post author
    db
      .select({ s: comments.authorId, t: posts.authorId })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(
        and(
          eq(comments.status, 'active'),
          isNull(comments.parentId),
          gte(comments.createdAt, since),
          eq(posts.status, 'active'),
          ne(comments.authorId, posts.authorId),
        ),
      ),
    // replies → parent comment author
    db
      .select({ s: comments.authorId, t: parentComments.authorId })
      .from(comments)
      .innerJoin(parentComments, eq(comments.parentId, parentComments.id))
      .where(
        and(
          eq(comments.status, 'active'),
          isNotNull(comments.parentId),
          gte(comments.createdAt, since),
          eq(parentComments.status, 'active'),
          ne(comments.authorId, parentComments.authorId),
        ),
      ),
    // echoes (reposts) → original post author
    db
      .select({ s: posts.authorId, t: origPosts.authorId })
      .from(posts)
      .innerJoin(origPosts, eq(posts.echoOf, origPosts.id))
      .where(
        and(
          eq(posts.status, 'active'),
          isNotNull(posts.echoOf),
          gte(posts.createdAt, since),
          eq(origPosts.status, 'active'),
          ne(posts.authorId, origPosts.authorId),
        ),
      ),
    // likes on posts → post author
    db
      .select({ s: likes.userId, t: posts.authorId })
      .from(likes)
      .innerJoin(posts, eq(likes.targetId, posts.id))
      .where(
        and(
          eq(likes.targetType, 'post'),
          gte(likes.createdAt, since),
          eq(posts.status, 'active'),
          ne(likes.userId, posts.authorId),
        ),
      ),
  ]);

  // One era's population: a cross-era edge (a live agent liking a sealed post)
  // has an endpoint outside it and is dropped below.
  const idToUser = new Map((await loadLabUsers(era)).map((u) => [u.id, u]));

  const edgeMap = new Map<string, Record<EdgeKind, number>>();
  const accumulate = (raw: Array<{ s: string; t: string }>, kind: EdgeKind) => {
    for (const e of raw) {
      const s = e.s;
      const t = e.t;
      // Keep edges strictly within the lab population.
      if (!idToUser.has(s) || !idToUser.has(t)) continue;
      const key = `${s}|${t}`;
      const acc = edgeMap.get(key) ?? { comment: 0, reply: 0, echo: 0, like: 0 };
      acc[kind] += 1;
      edgeMap.set(key, acc);
    }
  };
  accumulate(commentEdges, 'comment');
  accumulate(replyEdges, 'reply');
  accumulate(echoEdges, 'echo');
  accumulate(likeEdges, 'like');

  const strengthById = new Map<string, number>();
  const edges: GraphEdgeDTO[] = [];
  for (const [key, kinds] of edgeMap) {
    const [s, t] = key.split('|');
    const su = idToUser.get(s);
    const tu = idToUser.get(t);
    if (!su || !tu) continue;
    const weight = kinds.comment + kinds.reply + kinds.echo + kinds.like;
    edges.push({ source: su.username, target: tu.username, weight, kinds });
    strengthById.set(s, (strengthById.get(s) ?? 0) + weight);
    strengthById.set(t, (strengthById.get(t) ?? 0) + weight);
  }

  const nodes: GraphNodeDTO[] = [];
  for (const [id, strength] of strengthById) {
    const u = idToUser.get(id);
    if (!u) continue;
    nodes.push({ username: u.username, displayName: u.displayName, isAgent: u.isAgent, strength });
  }
  nodes.sort((a, b) => b.strength - a.strength);

  return { range, nodes, edges };
}
