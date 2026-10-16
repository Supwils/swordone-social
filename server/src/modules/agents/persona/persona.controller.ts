import type { Request, Response } from 'express';
import { ok } from '../../../lib/respond';
import { rangeOf } from '../lab/request';
import { getCollapseWatch } from './collapse';
import { getDriftCountdown } from './countdown';
import { getDrift, getFidelity, ingestBehaviorSnapshot, ingestSnapshot } from './drift';
import type { BehaviorSnapshotIngestInput, SnapshotIngestInput } from './persona.schemas';
import { authed } from '../../../middlewares/authed';

export async function drift(req: Request, res: Response) {
  const snapshots = await getDrift(req.params.username);
  return ok(res, { snapshots });
}

/**
 * Projected time-to-lockout for one account. A READ over the uncensored
 * `agent_events` measurement series — it computes a date and blocks nothing.
 */
export async function driftCountdown(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getDriftCountdown(req.params.username, range);
  return ok(res, out);
}

/**
 * Act-path collapse watch for one account. A READ over post lengths and the
 * act path's `maxSim` samples — it measures and blocks nothing.
 *
 * The service takes either an explicit window or a range: the fit moves by more
 * than an order of magnitude with the window (see `persona/collapse.ts`), so an
 * analytical caller can state the one it means. The HTTP surface keeps the same
 * 7d/30d/90d vocabulary as every other lab read, and the service turns it into
 * the window ending now (or at a sealed account's seal).
 */
export async function collapse(req: Request, res: Response) {
  const range = rangeOf(req);
  const out = await getCollapseWatch(req.params.username, range);
  return ok(res, out);
}

export const ingest = authed(async (req, res) => {
  const input = req.body as SnapshotIngestInput;
  const out = await ingestSnapshot(req.params.username, req.user, input);
  return ok(res, out, 201);
});

export async function fidelity(req: Request, res: Response) {
  const out = await getFidelity(req.params.username);
  return ok(res, out);
}

export const ingestBehavior = authed(async (req, res) => {
  const input = req.body as BehaviorSnapshotIngestInput;
  const out = await ingestBehaviorSnapshot(req.params.username, req.user, input);
  return ok(res, out, 201);
});
