/**
 * Arms report wire shapes — spec §7 (2026-10-14-s2-lab-era-3-design.md),
 * verbatim. Arm-keyed records use `armRecord` so every arm key is required.
 */
import { z } from 'zod';
import { armIdSchema, armRecord } from './era';

export const VerdictSchema = z
  .object({
    status: z.enum(['collecting', 'differs', 'no-difference', 'insufficient']),
    between: z.number().nullable(),
    within: z.number().nullable(),
    frozenAt: z.string().nullable(),
  })
  .strict();
export type Verdict = z.infer<typeof VerdictSchema>;

export const SeriesPointSchema = z
  .object({
    roundId: z.string(),
    ordinal: z.number(),
    value: z.number().nullable(),
    n: z.number(),
  })
  .strict();
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

export const MetricBlockSchema = z
  .object({
    key: z.enum(['fidelity', 'repetition', 'convergence']),
    series: z.array(z.object({ arm: armIdSchema, points: z.array(SeriesPointSchema) }).strict()), // window rounds
    population: z.array(SeriesPointSchema).optional(), // convergence only
    accounts: z.array(
      z
        .object({
          username: z.string(),
          arm: armIdSchema,
          value: z.number().nullable(),
          n: z.number(),
          level: z.number().nullable(),
        })
        .strict(),
    ),
    arms: z.array(
      z
        .object({
          arm: armIdSchema,
          mean: z.number().nullable(),
          sd: z.number().nullable(),
          accounts: z.number(),
          qualifies: z.boolean(),
        })
        .strict(),
    ),
    verdict: VerdictSchema,
    companions: z.array(
      z
        .object({
          label: z.string(),
          arms: z.array(z.object({ arm: armIdSchema, value: z.number().nullable() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();
export type MetricBlock = z.infer<typeof MetricBlockSchema>;

export const RoundDTOSchema = z
  .object({
    roundId: z.string(),
    kind: z.enum(['sweep', 'manual']),
    startedAt: z.string(),
    cards: z.number(),
    completed: z.boolean(),
    ordinal: z.number().nullable(),
    inWindow: z.boolean(),
  })
  .strict();
export type RoundDTO = z.infer<typeof RoundDTOSchema>;

export const HomophilySchema = z
  .object({
    matrix: armRecord(armRecord(z.number())), // all edges, counts
    arms: z.array(
      z
        .object({
          arm: armIdSchema,
          out: z.number(),
          crossBoardOut: z.number(),
          within: z.number(),
          share: z.number().nullable(),
          expected: z.number().nullable(),
          ratio: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type Homophily = z.infer<typeof HomophilySchema>;

export const ContagionSchema = z
  .object({
    status: z.enum(['collecting', 'ok']),
    arms: z.array(
      z
        .object({
          arm: armIdSchema,
          innovations: z.number(),
          adopted: z.number(),
          rate: z.number().nullable(),
        })
        .strict(),
    ),
    top: z.array(
      z
        .object({
          token: z.string(),
          origin: z.string(),
          originArm: armIdSchema,
          adopters: z.number(),
          adopterArms: z.array(armIdSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type Contagion = z.infer<typeof ContagionSchema>;

export const ReliabilityRowSchema = z
  .object({
    arm: armIdSchema,
    expected: z.number(),
    cards: z.number(),
    fails: z.number(),
    missing: z.number(),
    attempted: z.number(),
    landed: z.number(),
    dreamsAccepted: z.number(),
    dreamsFailed: z.number(),
    guardDrops: z.number(),
    missingPostVectors: z.number(),
    deviations: z.number(),
  })
  .strict();
export type ReliabilityRow = z.infer<typeof ReliabilityRowSchema>;

export const ArmsReportDTOSchema = z
  .object({
    generatedAt: z.string(),
    arms: z.array(
      z.object({ id: armIdSchema, model: z.string(), accounts: z.array(z.string()) }).strict(),
    ),
    rounds: z.array(RoundDTOSchema),
    completedRounds: z.number(),
    targetRounds: z.literal(12),
    minArmRounds: z.literal(9),
    armRounds: armRecord(z.number()),
    metrics: z
      .object({
        fidelity: MetricBlockSchema,
        repetition: MetricBlockSchema,
        convergence: MetricBlockSchema,
      })
      .strict(),
    exploratory: z
      .object({
        homophily: HomophilySchema,
        contagion: ContagionSchema,
        reliability: z.array(ReliabilityRowSchema),
      })
      .strict(),
  })
  .strict();
export type ArmsReportDTO = z.infer<typeof ArmsReportDTOSchema>;

/** One account's round in `GET /agents/:username/rounds` — spec §7. Newest first, ≤ 60. */
export const AccountRoundDTOSchema = z
  .object({
    roundId: z.string(),
    kind: z.enum(['sweep', 'manual']),
    startedAt: z.string(),
    outcome: z.string(),
    actOutcome: z.string().nullable(),
    attempted: z.number().nullable(),
    landed: z.number().nullable(),
    dreamAccepted: z.boolean().nullable(),
    candidate: z
      .object({
        maxSim: z.number().nullable(),
        cardSim: z.number().nullable(),
        dropped: z.boolean(),
      })
      .strict()
      .nullable(),
    post: z
      .object({
        postId: z.string(),
        cardSim: z.number().nullable(),
        convergence: z.number().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AccountRoundDTO = z.infer<typeof AccountRoundDTOSchema>;

export const AccountRoundsDTOSchema = z
  .object({
    username: z.string(),
    arm: armIdSchema.nullable(),
    rounds: z.array(AccountRoundDTOSchema),
  })
  .strict();
export type AccountRoundsDTO = z.infer<typeof AccountRoundsDTOSchema>;
