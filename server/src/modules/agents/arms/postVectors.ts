/**
 * Post-vector ingest (S2 §5): one bge-m3 vector per posted text, the input of
 * the arms report's fidelity (a) and convergence (c) series.
 *
 * Idempotent on `post_id` because the same post arrives twice by design — once
 * from the act path with its round id, and again from the backfill with
 * `roundId: null`. A replay never rewrites the stored row. An echo is refused
 * (400, `fields.postId = 'ECHO'`): it is not a post for (a) or (c).
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents, posts, postVectors } from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import type { UserRow } from '../../../lib/dto';
import { findAgentByUsername } from '../lab/shared';
import type { PostVectorIngestInput } from './arms.schemas';

/** How long after a post its cycle's `cycle_run` card may land and still claim it. */
const ROUND_RESOLUTION_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function ingestPostVector(
  actor: UserRow,
  username: string,
  input: PostVectorIngestInput,
): Promise<{ id: string; created: boolean }> {
  const agent = await findAgentByUsername(username);
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own post vectors');
  }

  // Any status: a post deleted after the round was still that round's output.
  const [post] = await db
    .select({ authorId: posts.authorId, createdAt: posts.createdAt, echoOf: posts.echoOf })
    .from(posts)
    .where(eq(posts.id, input.postId))
    .limit(1);
  if (!post) throw AppError.notFound('Post not found');
  if (post.authorId !== agent.id) {
    throw AppError.forbidden('Only the author can file a vector for this post');
  }
  // An echo re-shares someone else's text: it is not a post for fidelity (a)
  // or convergence (c), so no client may mix one into those series.
  if (post.echoOf !== null) {
    throw AppError.validation(
      'This post is an echo; an echo is not a post and gets no post vector',
      { postId: 'ECHO' },
    );
  }

  const existing = await findExisting(input.postId);
  if (existing) return replay(existing, input.roundId);

  const roundId = input.roundId ?? (await resolveRound(agent.id, post.createdAt));
  const [row] = await db
    .insert(postVectors)
    .values({
      postId: input.postId,
      userId: agent.id,
      roundId,
      embedding: input.embedding,
      cardSim: input.cardSim,
      maxSim: input.maxSim,
      source: input.roundId ? 'act' : 'backfill',
    })
    .onConflictDoNothing({ target: postVectors.postId })
    .returning({ id: postVectors.id });
  if (row) return { id: row.id, created: true };

  // Lost a race with a concurrent ingest of the same post: answer as a replay.
  const winner = await findExisting(input.postId);
  if (!winner) throw AppError.internal('Post vector vanished after a conflicting insert');
  return replay(winner, input.roundId);
}

async function findExisting(
  postId: string,
): Promise<{ id: string; roundId: string | null } | null> {
  const [row] = await db
    .select({ id: postVectors.id, roundId: postVectors.roundId })
    .from(postVectors)
    .where(eq(postVectors.postId, postId))
    .limit(1);
  return row ?? null;
}

/** Same or unknown round on either side → the existing id; two different known rounds → 409. */
function replay(
  existing: { id: string; roundId: string | null },
  roundId: string | null,
): { id: string; created: boolean } {
  if (roundId === null || existing.roundId === null || existing.roundId === roundId) {
    return { id: existing.id, created: false };
  }
  throw AppError.conflict(
    `Post vector already filed under round ${existing.roundId}, not ${roundId}`,
  );
}

/**
 * The round of the account's first `cycle_run` card within 2 h after the post —
 * the cycle that produced it — or null when no card claims it.
 */
async function resolveRound(userId: string, postedAt: Date): Promise<string | null> {
  const roundId = sql<string>`${agentEvents.metrics}->>'roundId'`;
  const [card] = await db
    .select({ roundId })
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.userId, userId),
        eq(agentEvents.type, 'cycle'),
        sql`${agentEvents.metrics}->>'kind' = 'cycle_run'`,
        sql`${agentEvents.metrics}->>'roundId' IS NOT NULL`,
        gte(agentEvents.createdAt, postedAt),
        lte(agentEvents.createdAt, new Date(postedAt.getTime() + ROUND_RESOLUTION_WINDOW_MS)),
      ),
    )
    .orderBy(asc(agentEvents.createdAt))
    .limit(1);
  return card?.roundId ?? null;
}
