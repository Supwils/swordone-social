/**
 * Agent event stream: ingest + read.
 *
 * Split out of the former 2018-line agents.service.ts (nine unrelated concerns,
 * six times the 300-line service ceiling). Imported directly since the S2
 * module split; there is no barrel.
 */
import { type InferSelectModel, and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { agentEvents } from '../../../db/schema';
import { AppError } from '../../../lib/errors';
import type { UserRow } from '../../../lib/dto';
import type { AgentEventIngestInput } from './runtime.schemas';
import { findAgentByUsername } from '../lab/shared';
import type { AgentEventDTO } from './runtime.types';

type AgentEventRow = InferSelectModel<typeof agentEvents>;

/* ---------- event stream ---------- */

function toAgentEventDTO(event: AgentEventRow): AgentEventDTO {
  return {
    id: event.id,
    type: event.type,
    phase: event.phase,
    outcome: event.outcome,
    ...(event.action ? { action: event.action } : {}),
    summary: event.summary,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    metrics: event.metrics ?? {},
    createdAt: event.createdAt.toISOString(),
  };
}

export async function getAgentEvents(
  username: string,
  limit: number,
  type?: AgentEventDTO['type'],
): Promise<AgentEventDTO[]> {
  const agent = await findAgentByUsername(username);
  const conds = [eq(agentEvents.userId, agent.id)];
  if (type) conds.push(eq(agentEvents.type, type));
  const events = await db
    .select()
    .from(agentEvents)
    .where(and(...conds))
    .orderBy(desc(agentEvents.createdAt))
    .limit(limit);
  return events.map(toAgentEventDTO);
}

export async function ingestAgentEvent(
  agentUsername: string,
  actor: UserRow,
  input: AgentEventIngestInput,
): Promise<AgentEventDTO> {
  const agent = await findAgentByUsername(agentUsername);
  if (agent.id !== actor.id) {
    throw AppError.forbidden('Only the agent itself can post its own lab events');
  }

  const [event] = await db
    .insert(agentEvents)
    .values({
      userId: agent.id,
      type: input.type,
      phase: input.phase,
      outcome: input.outcome,
      action: input.action,
      summary: input.summary,
      reason: input.reason,
      targetId: input.targetId,
      metrics: input.metrics,
      // `createdAt` defaults to now(); an explicit `occurredAt` overrides it so
      // an event ABOUT a past moment sorts and filters with that moment. Every
      // /lab read of this table orders by `created_at`, so this is the only
      // field that can put a backfilled human intervention beside the stretch
      // of series it contaminates instead of at today's end of the timeline.
      // `updatedAt` is deliberately left at now(): it records when the ROW was
      // written, which for a backfill is genuinely today.
      ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
    })
    .returning();

  return toAgentEventDTO(event);
}
