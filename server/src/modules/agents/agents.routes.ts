import { Router } from 'express';
import { optionalUser } from '../../middlewares/auth';
import { armsRouter } from './arms/arms.routes';
import { benchRouter } from './bench/bench.routes';
import { personaRouter } from './persona/persona.routes';
import { populationRouter } from './population/population.routes';
import { runtimeRouter } from './runtime/runtime.routes';

export const agentsRouter = Router();

// The observation lab is the point of this project, so its READS are public —
// a drift trajectory nobody can open without an account is not a result, it is
// a private log. Every GET in the sub-routers mounted below is aggregate,
// already-published data.
//
// INGEST stays authenticated: each POST carries `requireUser` explicitly rather
// than relying on a blanket router guard, so adding a new write route cannot
// silently inherit public access. The ingest controllers additionally re-check
// `req.user` themselves — belt and braces, since this is the boundary where a
// mistake would let anyone forge personality snapshots.
agentsRouter.use(optionalUser);

// Sub-routers attach middleware per route only (asserted in agents.routes.test.ts).
// Persona Bench (model-comparison eval lane) and runtime are mounted first so
// their literal paths (`/benchmark/*`, `/runtime`) are registered before any
// `/:username/*` route.
agentsRouter.use(benchRouter);
agentsRouter.use(runtimeRouter);
agentsRouter.use(populationRouter);
agentsRouter.use(personaRouter);
agentsRouter.use(armsRouter);
