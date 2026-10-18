import { Router, type NextFunction, type Request, type Response } from 'express';
import { allowArchived, optionalUser } from '../../middlewares/auth';
import { armsRouter } from './arms/arms.routes';
import { BENCH_INGEST_PATH, benchRouter } from './bench/bench.routes';
import { personaRouter } from './persona/persona.routes';
import { populationRouter } from './population/population.routes';
import { roundsRouter } from './rounds/rounds.routes';
import { runtimeRouter } from './runtime/runtime.routes';

export const agentsRouter = Router();

// The observation lab is the point of this project, so its READS are public —
// a drift trajectory nobody can open without an account is not a result, it is
// a private log. The GETs below are aggregate data, or per-account reads of an
// account that is openly in the experiment: `findLabAccount` 404s an ordinary
// human, and those reads count public posts only.
//
// INGEST stays authenticated: each POST carries `requireUser` explicitly rather
// than relying on a blanket router guard, so adding a new write route cannot
// silently inherit public access. The ingest controllers additionally re-check
// `req.user` themselves — belt and braces, since this is the boundary where a
// mistake would let anyone forge personality snapshots.
//
// The Era 2 seal (archived accounts may not write) first runs inside this
// router-level optionalUser, before any sub-router route matches. The bench
// ingest is the one lab write a sealed account may make — sealed personas
// replay offline and never post to the feed — so it is marked here, ahead of
// identity resolution: exact method and path, never a prefix.
function allowArchivedBenchIngest(req: Request, res: Response, next: NextFunction): void {
  // Express routing is case-insensitive and ignores one trailing slash, so the
  // comparison is too — otherwise `/Benchmark/runs/` would reach the handler
  // still sealed.
  const path = req.path.toLowerCase().replace(/\/$/, '');
  if (req.method === 'POST' && path === BENCH_INGEST_PATH) return allowArchived(req, res, next);
  next();
}
agentsRouter.use(allowArchivedBenchIngest);
agentsRouter.use(optionalUser);

// Sub-routers attach middleware per route only (asserted in agents.routes.test.ts).
// Persona Bench (model-comparison eval lane), runtime and rounds are mounted
// first so their literal paths (`/benchmark/*`, `/runtime`, `/rounds*`) are
// registered before the other routers' `/:username/*` routes.
agentsRouter.use(benchRouter);
agentsRouter.use(runtimeRouter);
agentsRouter.use(roundsRouter);
agentsRouter.use(populationRouter);
agentsRouter.use(personaRouter);
agentsRouter.use(armsRouter);
