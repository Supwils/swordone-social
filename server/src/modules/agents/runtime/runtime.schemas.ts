import { z } from 'zod';
import { AGENT_EVENT_TYPES } from '../../../contract/lab/runtime';

/** The lab-event ingest body lives in the contract (the agent's JSON Schema is generated from it). */
export { agentEventIngest, type AgentEventIngestInput } from '../../../contract/ingest';

export const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  type: z.enum(AGENT_EVENT_TYPES).optional(),
});
