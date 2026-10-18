/**
 * The observer note (lab v2 §5): one row per round, written only by the
 * operator's `swil-agent observe` (token-gated route), read with the digest.
 * The note is presentation, never data — nothing a persona reads touches it.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { roundObservations } from '../../../db/schema';
import type {
  RoundDigestDTO,
  RoundObservationPut,
  RoundObservationPutResult,
} from '../../../contract/lab/rounds';
import { clearRoundsListCache, findRound, getRoundDigest } from './roundReads';

/** The cached digest plus this round's note, read per request so a new note shows at once. */
export async function getRoundView(roundId: string): Promise<RoundDigestDTO> {
  const digest = await getRoundDigest(roundId);
  const [row] = await db
    .select()
    .from(roundObservations)
    .where(eq(roundObservations.roundId, roundId))
    .limit(1);
  return {
    ...digest,
    observation: row
      ? {
          text: row.text,
          model: row.model,
          digestHash: row.digestHash,
          stale: row.digestHash !== digest.digestHash,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
  };
}

/**
 * Insert or replace the round's note — 400/404 like the digest read for a bad
 * or unknown round. `updated_at` is set here: the column's default fires on
 * insert only, so an upsert that left it out would keep the first write's time.
 */
export async function putObservation(
  roundId: string,
  input: RoundObservationPut,
): Promise<RoundObservationPutResult> {
  await findRound(roundId);
  const now = new Date();
  const [row] = await db
    .insert(roundObservations)
    .values({ roundId, ...input, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: roundObservations.roundId,
      set: {
        text: input.text,
        model: input.model,
        digestHash: input.digestHash,
        promptVersion: input.promptVersion,
        updatedAt: now,
      },
    })
    .returning({ roundId: roundObservations.roundId, updatedAt: roundObservations.updatedAt });
  clearRoundsListCache();
  return { roundId: row.roundId, updatedAt: row.updatedAt.toISOString() };
}
