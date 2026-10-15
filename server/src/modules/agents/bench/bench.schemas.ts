import { z } from 'zod';
import { LIMITS, USERNAME_RE } from '../../../contract/common';

/** The bench-run ingest body lives in the contract (the agent's JSON Schema is generated from it). */
export { benchmarkRunIngest, type BenchmarkRunIngestInput } from '../../../contract/ingest';

export const benchmarkCompareQuery = z.object({
  persona: z.string().min(2).max(LIMITS.usernameMax).regex(USERNAME_RE),
  task: z.string().trim().min(1).max(60),
});
