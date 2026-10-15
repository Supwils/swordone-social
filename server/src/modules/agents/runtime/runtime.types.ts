/** Wire shapes of the runtime reads: lab events and the runtime-health strip. */

export interface AgentEventDTO {
  id: string;
  type: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag' | 'rule_check' | 'anomaly';
  phase: 'act' | 'dream' | 'snapshot' | 'memory' | 'echo' | 'rule' | 'anomaly';
  outcome: 'started' | 'success' | 'skip' | 'fail' | 'warn' | 'flagged' | 'cleared';
  action?:
    | 'post'
    | 'comment'
    | 'like'
    | 'follow'
    | 'unfollow'
    | 'delete'
    | 'dm'
    | 'echo'
    | 'nothing';
  summary: string;
  reason?: string;
  targetId?: string;
  metrics: Record<string, unknown>;
  createdAt: string;
}

/** One UTC day of cycle_run cards — powers the /lab runtime-health strip. */
export interface RuntimeHealthPointDTO {
  date: string; // YYYY-MM-DD
  rounds: number;
  failOpen: number;
  missingSamples: number;
  landed: number;
  /** cycle_run cards whose post landed without a post vector. */
  missingPostVectors: number;
}

/**
 * Aggregate of `agent_events` rows with `type='cycle'` and
 * `metrics.kind='cycle_run'`. Per-action cycle events and missingSampler
 * audit rows (same type, no kind) are excluded.
 */
export interface RuntimeHealthDTO {
  range: '7d' | '30d' | '90d';
  rounds: number;
  accountsRun: number;
  failOpenGates: number;
  missingSamples: number;
  landedActions: number;
  /** cycle_run cards with `missingPostVector: true` (Era 3 act path). */
  missingPostVectors: number;
  points: RuntimeHealthPointDTO[];
}
