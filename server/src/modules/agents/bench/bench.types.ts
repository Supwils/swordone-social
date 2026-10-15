/** Wire shapes of the Persona Bench (model-comparison eval lane). */

export interface BenchmarkLeaderboardRowDTO {
  model: string;
  runs: number;
  fidelity: number | null; // mean cosine(output, persona spec)
  judge: number | null; // mean LLM-judge score [0, 100]
  rule: number | null; // mean deterministic rule adherence [0, 1]
  consistency: number | null; // 1 − mean within-cell stddev of fidelity (higher = steadier)
  latencyMs: number | null;
}

export interface BenchmarkLeaderboardDTO {
  rows: BenchmarkLeaderboardRowDTO[];
  personas: Array<{ persona: string; display: string }>;
  tasks: Array<{ taskId: string; kind: string }>;
  totalRuns: number;
}

export interface BenchmarkMatrixCellDTO {
  persona: string;
  model: string;
  fidelity: number | null;
  judge: number | null;
  n: number;
}

export interface BenchmarkMatrixDTO {
  models: string[];
  personas: Array<{ persona: string; display: string }>;
  cells: BenchmarkMatrixCellDTO[];
}

export interface BenchmarkCompareItemDTO {
  model: string;
  runIndex: number;
  output: string;
  vectorFidelity: number | null;
  judgeScore: number | null;
  ruleScore: number | null;
  ruleDetail: string;
}

export interface BenchmarkCompareDTO {
  persona: string;
  task: string;
  items: BenchmarkCompareItemDTO[];
}
