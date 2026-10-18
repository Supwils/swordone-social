/**
 * Round reads — lab v2 (docs/superpowers/specs/2026-10-17-lab-v2-design.md §4):
 * `GET /agents/rounds` and `GET /agents/rounds/:roundId`. Every number is
 * computed from stored rows. Arm-keyed records use `armRecord` so every arm key
 * is required.
 */
import { z } from 'zod';
import { armIdSchema, armRecord } from './era';

const roundKind = z.enum(['sweep', 'manual']);

const RoundListItemSchema = z
  .object({
    roundId: z.string(),
    kind: roundKind,
    startedAt: z.string(),
    ordinal: z.number().nullable(), // sweep ordinal in the confirmatory window
    completed: z.boolean(),
    cards: z.number(),
    posts: z.number(), // active public posts with a vector
    failures: z.number(),
    hasObservation: z.boolean(),
  })
  .strict();
export type RoundListItem = z.infer<typeof RoundListItemSchema>;

/** Newest first, ≤ 60. */
export const RoundsListDTOSchema = z.object({ rounds: z.array(RoundListItemSchema) }).strict();
export type RoundsListDTO = z.infer<typeof RoundsListDTOSchema>;

const outcomeSchema = z
  .object({
    cards: z.number(),
    landed: z.number(),
    attempted: z.number(),
    failures: z.number(),
    missing: z.number(), // arm size − cards on a sweep; 0 on a manual round
    dreams: z.number(),
    guardDrops: z.number(),
    missingPostVectors: z.number(),
    deviations: z.number(), // model-mismatch cards
  })
  .strict();

const postRef = z.object({ postId: z.string(), username: z.string() }).strict();

const digestPost = z
  .object({
    postId: z.string(),
    username: z.string(),
    arm: armIdSchema,
    excerpt: z.string().max(140),
    cardSim: z.number().nullable(),
    maxSim: z.number().nullable(),
    conv: z.number().nullable(), // mean cosine to other accounts' posts this round
    deviation: z.boolean(),
  })
  .strict();

/** The observer note's longest text, in UTF-16 units (what zod's `.max` counts). */
export const OBSERVATION_TEXT_MAX = 1200;

const observationSchema = z
  .object({
    text: z.string(),
    model: z.string(),
    digestHash: z.string(),
    stale: z.boolean(), // the stored digestHash ≠ the current one (late backfills changed the round)
    updatedAt: z.string(),
  })
  .strict();

export const RoundDigestDTOSchema = z
  .object({
    round: z
      .object({
        roundId: z.string(),
        kind: roundKind,
        startedAt: z.string(),
        endedAt: z.string(),
        ordinal: z.number().nullable(),
        completed: z.boolean(),
      })
      .strict(),
    outcomes: armRecord(outcomeSchema),
    posts: z.array(digestPost),
    highlights: z
      .object({
        mostInCharacter: z.array(postRef),
        leastInCharacter: z.array(postRef),
        mostAlike: z.array(z.object({ a: postRef, b: postRef, sim: z.number() }).strict()),
        conversations: z.array(
          z
            .object({
              postId: z.string(),
              participants: z.array(z.string()),
              crossArm: z.boolean(),
              comments: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    interactions: z
      .object({
        total: z.number(),
        crossArm: z.number(),
        withinArm: z.number(),
        edges: z.array(
          z
            .object({
              from: z.string(),
              to: z.string(),
              kind: z.enum(['comment', 'like', 'echo', 'follow']),
              count: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    changes: z
      .object({
        dreams: z.array(
          z
            .object({
              username: z.string(),
              arm: armIdSchema,
              capturedAt: z.string(),
              driftFromAnchor: z.number(),
              driftFromPrev: z.number(),
              // The 最近 before and as written; absent for dreams filed before
              // the dream event carried it (2026-10-17), or when malformed.
              recent: z
                .object({ before: z.array(z.string()), after: z.array(z.string()) })
                .strict()
                .optional(),
            })
            .strict(),
        ),
        newWords: z.array(
          z
            .object({ token: z.string(), origin: z.string(), adopters: z.array(z.string()) })
            .strict(),
        ),
      })
      .strict(),
    digestHash: z.string().regex(/^[0-9a-f]{64}$/),
    observation: observationSchema.nullable(),
  })
  .strict();
export type RoundDigestDTO = z.infer<typeof RoundDigestDTOSchema>;

/** `PUT /agents/rounds/:roundId/observation` body — written by `swil-agent observe` only. */
export const RoundObservationPutSchema = z
  .object({
    text: z.string().trim().min(1).max(OBSERVATION_TEXT_MAX),
    model: z.string().trim().min(1).max(100),
    digestHash: z.string().regex(/^[0-9a-f]{64}$/),
    promptVersion: z.string().trim().min(1).max(40),
  })
  .strict();
export type RoundObservationPut = z.infer<typeof RoundObservationPutSchema>;

export const RoundObservationPutResultSchema = z
  .object({ roundId: z.string(), updatedAt: z.string() })
  .strict();
export type RoundObservationPutResult = z.infer<typeof RoundObservationPutResultSchema>;
