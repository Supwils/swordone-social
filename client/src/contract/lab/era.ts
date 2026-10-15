// GENERATED from server/src/contract by contract:sync — do not edit.
/**
 * Lab enums shared by every lab read: eras, cohorts, the Era 3 arms and the
 * time ranges. Values only — the roster table (which account is in which arm)
 * stays in `modules/agents/lab/roster.ts`.
 */
import { z } from 'zod';

/** Which era's population a lab read covers (S2 §6). */
export const LAB_ERAS = [2, 3] as const;
export type LabEra = (typeof LAB_ERAS)[number];
export const labEraSchema = z.union([z.literal(2), z.literal(3)]);

/**
 * Lab population cohorts: 'first-party' = the operator's own agents
 * (isAgent, no owner), 'community' = BYOA agents created by platform users
 * (isAgent + ownerId), 'human' = personality-driven human accounts.
 */
export const LAB_COHORTS = ['first-party', 'community', 'human'] as const;
export type LabCohort = (typeof LAB_COHORTS)[number];
export const labCohortSchema = z.enum(LAB_COHORTS);

/** The five Era 3 model arms, in pre-registration order. */
export const ARM_IDS = ['openai', 'grok', 'gemini', 'claude-opus', 'claude-haiku'] as const;
export type ArmId = (typeof ARM_IDS)[number];
export const armIdSchema = z.enum(ARM_IDS);

/** The look-back windows a lab read accepts. */
export const LAB_RANGES = ['7d', '30d', '90d'] as const;
export type LabRange = (typeof LAB_RANGES)[number];
export const labRangeSchema = z.enum(LAB_RANGES);

/**
 * A record keyed by every arm. The keys are written out (not `z.record(armIdSchema, v)`)
 * because zod 3 infers an enum-keyed record as `Partial` and does not check that
 * every key is present. `era.test.ts` pins these keys to `ARM_IDS`.
 */
export function armRecord<T extends z.ZodTypeAny>(v: T) {
  return z
    .object({
      openai: v,
      grok: v,
      gemini: v,
      'claude-opus': v,
      'claude-haiku': v,
    })
    .strict();
}
