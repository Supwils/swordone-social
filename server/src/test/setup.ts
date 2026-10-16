import { bindSupertestToLoopback } from './loopback';

/**
 * Vitest setup — provides safe defaults for env vars that env.ts validates
 * at import time, so unit tests can run without a .env file (e.g. in CI).
 *
 * Real values from a local .env still win — these are fallbacks only.
 *
 * IMPORTANT: this file is wired via `setupFiles` in vitest.config.ts. It runs
 * BEFORE each test file imports its modules, so env.ts sees these defaults
 * when its top-level `safeParse(process.env)` runs.
 */

// Use ?? so any value already set in the environment (e.g. from a developer's
// .env or a real CI secret) takes precedence.
process.env.NODE_ENV ??= 'test';
// Derived from the OS user (the default role for a `brew install postgresql`
// setup) rather than hardcoded — this used to name one maintainer, so every
// other machine ran migrations against one URL and queries against another.
process.env.DATABASE_URL ??= `postgresql://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/swil_test_pg`;
process.env.SESSION_SECRET ??=
  'unit-test-session-secret-must-be-at-least-32-chars-long-and-deterministic';
// Never the real Google Translate API, even when server/.env has a key (CI has
// none): a feed read over a Chinese post was sending a real, billed request.
// Translation tests set a fake key and stub `fetch` themselves. Not `??=` —
// dotenv never overrides a variable that is already set, so '' wins.
process.env.GOOGLE_TRANSLATE_API_KEY = '';

// supertest must bind the address it dials — see test/loopback.ts.
bindSupertestToLoopback();
