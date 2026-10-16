---
title: Testing standards & reliability playbook
status: stable
last-updated: 2026-10-15
owner: s5-hygiene
---

# Testing standards & reliability playbook

Binding rules for anyone — human or agent — writing or changing tests in this
repo. `docs/09-contributing.md` covers workflow and hooks; this file covers
**how to write tests that stay trustworthy**. Every rule here was earned in
this codebase; the examples are real files you can open.

## 1. The gates

- `npm run ci:check` is the only definition of green. Run it before claiming
  any change is done, and always for changes touching build config,
  dependencies, lint config, or the CI workflow itself.
- `ci:check` is 17 steps (`09-contributing.md`): besides tests it gates the contract
  sync, lint (server, client, mcp, agent), Prettier format check (server, client,
  mcp), and knip. CI additionally runs the Playwright `e2e` job, which `ci:check`
  does not.
- Per-package: `npm --prefix server run test:coverage`,
  `npm --prefix client run test:coverage`, `npm --prefix mcp run test`,
  `cd agent && uv run pytest -q`.
- **Coverage floors are a ratchet.** They live in `server/vitest.config.ts`
  and `client/vite.config.ts` (each carries a dated ratchet log). Raise them
  to ~1–2 points under the measured value whenever coverage rises. Never
  lower them without a written reason in the commit body. A floor that has
  not moved while coverage climbed is a gate that can no longer fail — that
  is how the server sat at 50% floors with 80% coverage for four months.

## 2. Determinism — the non-negotiables

- **No sleeps as synchronization.** Wait on events, acks, or state:
  `expect.poll(...)`, `vi.waitFor(...)`, Testing Library `waitFor`, or a
  promise resolved by the event itself. A timeout may bound a wait; it must
  never *be* the wait.
- **Negative assertions need a sync point.** "X did not happen" is only
  meaningful after proof the system passed the moment X would have happened.
  Use an ordered flush: fire the suspect event, then a sentinel on the same
  ordered channel, wait for the sentinel, then assert X is absent. See the
  typing tests in `server/src/realtime/io.sockets.test.ts`.
- **Run every new or touched test file 3× locally** before calling it done.
  One green run proves nothing about flake.
- **Unique fixture identities per test** (seq counters, `newId()`), so
  buckets, caches, and unique indexes never couple tests.
- **The server test DB is shared and serial.** `fileParallelism: false` is
  load-bearing: every DB suite truncates in `beforeEach`. Never run two
  server vitest processes at once (including one in the background) — they
  will truncate each other's fixtures mid-test. Chain them in one command
  instead.
- Tests must not depend on wall-clock time, locale, env leakage, or listing
  order the code does not guarantee. Fixed ISO timestamps in fixtures;
  explicit sorts in assertions of ordered output.

## 3. What kind of test where

| Surface | Pattern | Example |
|---|---|---|
| Service touching the DB | Real Postgres + `resetDb()`, seed helpers, real side effects asserted. The platform tables have foreign keys: create parents first; a historical orphan needs `withForeignKeysOff` (`src/test/orphans.ts`) | `modules/comments/comments.service.test.ts` |
| Python agent code opening sqlite | Route every connection through `tests/unit/_sqlite.py` (`track()` / `open_saver()`); pytest turns `ResourceWarning` and unraisable-exception warnings into errors, so an unclosed connection fails the test that leaked it | `tests/unit/test_locks_lease.py` |
| Route stack (validation, status codes, limiter composition) | In-process router walk with mocked service + fake res | `modules/messages/messages.routes.test.ts` |
| Controller glue | Mock the service module, fake res, assert wiring + status | `modules/bookmarks/bookmarks.controller.test.ts` |
| Socket layer | Real socket.io server on an ephemeral port, real client, real DB membership | `realtime/io.sockets.test.ts` |
| Middleware with state (limiters) | Drive the real middleware; fresh keys per test | `middlewares/rateLimit.test.ts` |
| Client bridge/hook | Fake the transport at the module boundary, keep cache/store real | `components/RealtimeBridge.test.tsx`, `lib/useInfiniteScroll.test.tsx` |
| Route render | Testing Library + MemoryRouter + real QueryClient | `routes/conversation.test.tsx` |

Tests live next to the file they test. A second test file for a different
concern is fine (`io.test.ts` unit + `io.sockets.test.ts` integration).

## 4. Mock boundaries

- **Mock at the module boundary; keep the machinery under test real.** The
  RealtimeBridge tests fake only the socket; TanStack Query, Zustand and the
  dedupe logic run for real, so the tests pin effects, not wiring.
- **Mock infrastructure whose presence varies by machine.** A developer's
  `.env` may carry a live `REDIS_URL`; anything that changes test behavior
  based on local config must be pinned (see the adapter mock in
  `io.sockets.test.ts`).
- **A `vi.mock` factory must export every symbol the module under test
  imports** — a missing one becomes `undefined` at call time and fails far
  from the cause (the `getById` lesson in `messages.routes.test.ts`).
- **After `vi.resetModules()`, class identities split.** `instanceof` against
  a statically imported class fails for errors thrown by a re-imported
  module. Assert structurally (`toMatchObject({ name, status })`) instead.
- jsdom lacks browser APIs you may need (`IntersectionObserver`): stub them
  with a controllable class and fire callbacks by hand — but never assert
  behavior the stub itself provides (a mock `disconnect()` does not stop
  callbacks; the browser does).

## 5. Pin contracts, not implementations

- Test the behavior the system relies on, in the terms callers see. When the
  observed behavior is surprising but defensible, pin it **with a comment
  saying why** — e.g. `?limit=0` falls into `|| 20` before the clamp, so the
  contract is "default", not "1" (`bookmarks.controller.test.ts`).
- Where two constants must agree across layers, write the test through the
  real artifacts so drift fails loudly: the socket `conversationId` regex is
  tested against an id actually generated by the column default
  (`io.sockets.test.ts`), not against a handwritten hex string.
- Do not assert incidental shapes (exact SQL, private call order) — those
  tests break on refactors that change nothing observable.

## 6. Flaky policy

- A flaky test is a defect in the test, never weather. Fix it the day it is
  seen or delete it; no retries-in-CI, no skip-and-forget.
- The usual causes here: missing await, sleep-based sync, shared fixture
  identity, cross-process DB contention, mock state leaking between tests
  (`vi.clearAllMocks` in `afterEach`, reset module-level maps).
- If a failure reproduces only in the full suite, suspect shared state with
  an earlier file first (module-level singletons, env mutations).

## 7. Operator rules for agent sessions

- At most **5 parallel subagents**, ever. Test-writing fan-out included.
- Never `pkill -f <pattern>` (kills editors and MCP servers); kill by PID or
  PGID. Never edit a script while it runs (temp+mv instead).
- Serialize anything that touches the server test DB (see §2). Client,
  mcp and agent suites are process-local and may run concurrently with
  each other.
- New devDependency for tests: state why it is needed where the change is
  described, run `npm run knip`, then full `ci:check` (dependency changes
  are exactly the class of break only the build steps catch).

## 8. Checklist for a new or changed surface

1. Happy path through the public entry point (route/handler/hook), not just
   the inner function.
2. Every validation reject you added (bad id, bad limit, oversize body) —
   assert the service was **not** called.
3. Auth/permission failure (401/403/404-no-leak — private things 404, they
   never 403, so existence does not leak).
4. Boundary values at the exact documented edge (max length, limit clamp,
   cursor tie-break).
5. For bug fixes: the test must fail on the pre-fix code. If you cannot make
   it fail, you have not tested the fix.
6. Ran the file 3×, lint, typecheck; full `ci:check` at the milestone.
