/**
 * Arms report wire types — spec §7 (2026-10-14-s2-lab-era-3-design.md), verbatim.
 * `client/src/features/lab/types.ts` mirrors these by hand.
 */
import type { ArmId } from '../lab/roster';

export type { ArmId };

export type Verdict = {
  status: 'collecting' | 'differs' | 'no-difference' | 'insufficient';
  between: number | null;
  within: number | null;
  frozenAt: string | null;
};

export type SeriesPoint = { roundId: string; ordinal: number; value: number | null; n: number };

export type MetricBlock = {
  key: 'fidelity' | 'repetition' | 'convergence';
  series: { arm: ArmId; points: SeriesPoint[] }[]; // window rounds
  population?: SeriesPoint[]; // convergence only
  accounts: {
    username: string;
    arm: ArmId;
    value: number | null;
    n: number;
    level: number | null;
  }[];
  arms: {
    arm: ArmId;
    mean: number | null;
    sd: number | null;
    accounts: number;
    qualifies: boolean;
  }[];
  verdict: Verdict;
  companions: { label: string; arms: { arm: ArmId; value: number | null }[] }[];
};

export type RoundDTO = {
  roundId: string;
  kind: 'sweep' | 'manual';
  startedAt: string;
  cards: number;
  completed: boolean;
  ordinal: number | null;
  inWindow: boolean;
};

export type ArmsReportDTO = {
  generatedAt: string;
  arms: { id: ArmId; model: string; accounts: string[] }[];
  rounds: RoundDTO[];
  completedRounds: number;
  targetRounds: 12;
  minArmRounds: 9;
  armRounds: Record<ArmId, number>;
  metrics: { fidelity: MetricBlock; repetition: MetricBlock; convergence: MetricBlock };
  exploratory: { homophily: Homophily; contagion: Contagion; reliability: ReliabilityRow[] };
};

export type Homophily = {
  matrix: Record<ArmId, Record<ArmId, number>>; // all edges, counts
  arms: {
    arm: ArmId;
    out: number;
    crossBoardOut: number;
    within: number;
    share: number | null;
    expected: number | null;
    ratio: number | null;
  }[];
};

export type Contagion = {
  status: 'collecting' | 'ok';
  arms: { arm: ArmId; innovations: number; adopted: number; rate: number | null }[];
  top: {
    token: string;
    origin: string;
    originArm: ArmId;
    adopters: number;
    adopterArms: ArmId[];
  }[];
};

export type ReliabilityRow = {
  arm: ArmId;
  expected: number;
  cards: number;
  fails: number;
  missing: number;
  attempted: number;
  landed: number;
  dreamsAccepted: number;
  dreamsFailed: number;
  guardDrops: number;
  missingPostVectors: number;
  deviations: number;
};

/** `GET /agents/:username/rounds` — spec §7. Newest first, ≤ 60. */
export type AccountRoundDTO = {
  roundId: string;
  kind: 'sweep' | 'manual';
  startedAt: string;
  outcome: string;
  actOutcome: string | null;
  attempted: number | null;
  landed: number | null;
  dreamAccepted: boolean | null;
  candidate: { maxSim: number | null; cardSim: number | null; dropped: boolean } | null;
  post: { postId: string; cardSim: number | null; convergence: number | null } | null;
};

export type AccountRoundsDTO = {
  username: string;
  arm: ArmId | null;
  rounds: AccountRoundDTO[];
};
