---
date: 2026-10-15
scope: S5 of the 2026-10-14 restructure (after S1 roster, S2 lab, S3 runtime, S4 contract) — the last slice
status: approved for implementation (owner delegated review)
---

# S5 — hygiene: Mongo leftovers, foreign keys, CI gates, docs

## 1. Why

S1–S4 changed the system's shape; what is left is the residue they did not
touch and the gates that would keep it from coming back:

- Mongo is gone since July 2026 but its ETL script, `mongodb` devDependency,
  `MONGODB_URI` env default, a deprecated `/health` `mongo` alias and stale
  current-state docs remain.
- The Postgres schema has **zero foreign keys**; every relation is a plain
  `text` column (the ETL era's choice). Nothing stops an orphan row.
- CI does not run Prettier, knip, mcp lint or the Playwright e2e lane, so the
  tree has drifted: 85 client / 11 server / 4 mcp files fail `prettier --check`,
  knip reports 26 unused exports and 57 unused types, mcp has no linter.
- The agent suite prints 91 `ResourceWarning`s (unclosed sqlite connections in
  three test files).
- Docs: `docs/12-handoff.md` is 180 KB of mixed history and current state;
  current-state docs still describe deleted scripts and the drift gate.
- Four follow-ups recorded in S4 (§6.2).

## 2. Goals and non-goals

Goals: remove Mongo leftovers; add the foreign keys that the domain implies,
safely for production data; make Prettier, knip and mcp lint CI gates, and run
e2e in CI; zero ResourceWarnings, enforced; current-state docs accurate and the
handoff split into current state + archive; the S4 follow-ups fixed.

Non-goals: no change to the experiment's data path (post vectors, similarity
rows, cycle_run cards, round ids) — the `cycle_*` goldens stay byte-identical;
no history rewrite (git history keeps `docs/demo` media and old files); no
change to `agent/archive/**`; dated history entries in docs stay as history.

## 3. Mongo leftovers

- Delete `server/scripts/migrate-mongo-to-pg.ts` and the `mongodb`
  devDependency (git history keeps the one-shot ETL).
- Remove `MONGODB_URI` from `server/src/config/env.ts`, `server/src/test/setup.ts`
  and the `MONGO_SOURCE_URI` section of `server/.env.example`.
- `/health`: drop the deprecated `mongo: 'ok'` alias **only if** no consumer reads
  it (grep agent, mcp, e2e, client, scripts, docs for `mongo` on a health
  response; Railway's healthcheck uses the status code). If any consumer reads
  it, keep it and say so.
- The `$`-key request sanitizer stays (defence against operator-shaped keys is
  harmless and cheap); its comment and test name stop saying "Mongo".
- Comments: "MongoDB ObjectId hex" → "24-hex id (bson ObjectId format)" in
  `server/src/contract/common.ts` (then `contract:sync`); other cosmetic comments.
- `bson` stays: it is the live id generator (`lib/id.ts`).
- Current-state docs (§8) stop describing Mongo as present.

## 4. Foreign keys — migration 0006

Scope: relations of the platform tables whose parent rows are never hard-deleted
(users, posts, comments, boards, conversations are tombstoned by `status` /
`deletedAt`). Lab/analytics tables (`personality_snapshots`, `behavior_snapshots`,
`agent_events`, `benchmark_runs`, `population_metrics`, `post_vectors`, `events`)
get **no** FKs: they are history that must outlive any account operation, and
their ingest already validates ownership. Polymorphic columns (`likes.target_id`,
`agent_events.target_id`) and array columns cannot be FKs.

FKs to add (child → parent `id`):

| child column | parent | on delete |
|---|---|---|
| `users.owner_id` | users | NO ACTION |
| `api_keys.user_id` | users | NO ACTION |
| `posts.author_id` | users | NO ACTION |
| `posts.board_id` | boards | NO ACTION |
| `comments.post_id` | posts | NO ACTION |
| `comments.author_id` | users | NO ACTION |
| `comments.parent_id` | comments | NO ACTION |
| `likes.user_id` | users | NO ACTION |
| `follows.follower_id`, `follows.following_id` | users | NO ACTION |
| `bookmarks.user_id` | users | NO ACTION |
| `bookmarks.post_id` | posts | NO ACTION |
| `messages.conversation_id` | conversations | NO ACTION |
| `messages.sender_id` | users | NO ACTION |
| `notifications.recipient_id`, `notifications.actor_id` | users | NO ACTION |

(Exact column names from the schema files; the implementer verifies each and
drops a row from this table only with a written reason, e.g. a column that holds
non-id sentinels.)

- **`NOT VALID`**: every constraint is added `NOT VALID`, so the migration takes
  no long lock and does not fail on historical orphans; new writes are checked
  immediately. Validation is a separate, later, owner-run step.
- **Orphan report**: `server/scripts/db-orphans.ts` (`npm --prefix server run
  db:orphans`), read-only, prints the orphan count per constraint for the
  `DATABASE_URL` it is given; exits 1 if any. Then
  `server/scripts/db-validate-fks.ts` (`db:validate-fks`) runs `ALTER TABLE …
  VALIDATE CONSTRAINT` for each — only when the orphan report is clean.
- Drizzle schema files declare the references (`.references(() => users.id)`)
  so drizzle-kit's snapshot matches; the generated SQL is hand-edited to add
  `NOT VALID` (documented in the migration header) and `meta/0006_snapshot.json`
  chains to 0005.
- Any code path that hard-deletes a parent or inserts a child before its parent
  surfaces in tests; fix the code path (not the constraint) unless the fix would
  change API behaviour — then report it.
- `test/db-reset.ts` truncation works with FKs (one `TRUNCATE … ` over all tables,
  or `CASCADE`).
- Launch checklist (handoff): 0006 is applied with 0004/0005 before the server
  deploy; `db:orphans` then `db:validate-fks` are a later, optional owner step.

## 5. CI gates and tooling

- **mcp lint**: ESLint 10 flat config copied from the server's (same plugins and
  rules), devDependencies `eslint`, `@eslint/js`, `typescript-eslint`,
  `eslint-config-prettier`, `prettier`; scripts `lint`, `format`, `format:check`.
  Root `lint`/`typecheck`/`test` scripts include mcp.
- **Prettier gate**: one mechanical `prettier --write` over client, server and mcp
  sources (root `.prettierrc.json`, existing `.prettierignore`; generated contract
  copies are written byte-identical to their already-formatted source, so they
  must come out unchanged — if not, format the source and re-sync). Then
  `format:check` for all three packages joins `scripts/ci-check.sh` and CI. The
  reformat is its own task, last among code tasks, so its diff is pure formatting.
- **knip gate**: remove every unused export/type knip reports (or mark a genuinely
  public seam with knip's `ignore`/tags, with a reason); apply knip's
  configuration hints; `npm run knip` joins ci:check and CI.
- **e2e in CI**: a `e2e` job in `.github/workflows/ci.yml` (pgvector pg16 service,
  installs server/client/e2e deps, Playwright browsers `chromium` only, runs
  `npm run test:e2e` with `E2E_DATABASE_URL` pointing at the service). Fix
  `ensure-e2e-db.ts`'s hardcoded role (use the URL / `$USER`), and the stale
  `e2e/global-setup.ts` reference in `playwright.config.ts`. `ci:check` stays
  local-fast and does **not** run e2e; `docs/09-contributing.md` says the e2e lane
  runs in CI and locally via `npm run test:e2e`.
- ci:check step count and labels updated; CI and ci:check list the same gates
  (except e2e, CI-only).

## 6. Agent tests and S4 follow-ups

### 6.1 ResourceWarnings

Close every sqlite connection the three test files open (`_lease_db`,
`_memory_db`, `_locked_on_heartbeat_db`, `_FailingConnection`, the
`open_checkpointer` savers), following the `contextlib.closing` fixture in
`test_graph_phases.py`. Then `pyproject.toml` `[tool.pytest.ini_options]`
`filterwarnings = ["error::ResourceWarning"]` (or the narrowest equivalent that
also catches GC-time warnings — `-W error::ResourceWarning` plus
`PYTHONTRACEMALLOC` is not needed) so a new leak fails the suite. Rename
`test_graph_leases.py` → `test_locks_lease.py` (current-state docs updated; dated
superpowers docs keep the old path as history).

### 6.2 S4 follow-ups

1. `POST /posts` with `echoOf` returns the echo without its `echoOf` original —
   fix: hydrate the created echo the way `GET` does, so the create response
   equals a subsequent read (test: create echo → response has `echoOf` equal to
   the original's `PostCore`).
2. `toAgentSummaryItem` (explore) emits `agentBackend` without the
   `publicAgentBackend` guard — apply the guard (no visible change today: explore
   lists agents only).
3. API-key create/list controllers pass `Date` objects to `ok()` — serialise
   with `toISOString()` so the in-memory value equals the wire shape; update the
   controller tests that assert in-memory `Date`s.
4. Lab roster returns a sealed human's stored `agentBackend`: **kept**, by
   design (the lab is the public analysis surface, CLAUDE.md "⚠ /lab is a PUBLIC
   analysis surface"); documented in `docs/13-observation-lab.md`.

## 7. Small leftovers

- Tracked root `.DS_Store` removed and `.DS_Store` gitignored.
- `report/` (tracked output of `scripts/build-report-html.py`) stays tracked —
  it is a published artifact; `docs/README.md` says how it is regenerated.
- `server/.../persona/countdown.ts` comments citing stale `dream/round.py` line
  numbers → cite functions, not lines.
- `swil_agent/` docstrings (≈ 13) that cite deleted Bash scripts as current
  behaviour are rewritten to describe the Python code; test docstrings that cite
  a Bash script as *provenance* ("ported from …") may stay.

## 8. Docs consolidation

- `docs/12-handoff.md` → current state only (S1–S5 summary, launch checklist,
  operating notes, open follow-ups); every dated entry before 2026-10-14 moves
  verbatim to `docs/history/handoff-archive.md` (newest first, nothing deleted).
  Links into the moved sections are updated.
- Current-state docs fixed for deleted scripts, the drift gate, Mongo and old
  module paths: `CLAUDE.md`, `README.md`, `docs/README.md` (index incl. the new
  archive), `01-architecture`, `03-api-reference`, `04-data-model` (FKs now
  exist), `06-security`, `08-deployment`, `09-contributing`, `10-roadmap`,
  `13-feature-spec`, `13-observation-lab` (current-state sections only),
  `16-interview-prep`, `17-technical-deep-dive`, `20-byoa-quickstart`,
  `agent/HOWTO.md`, `agent/README.md`. ADRs (`11-decisions/*`), era reports
  (`14-*`), `15-performance-optimizations` and `docs/superpowers/**` are
  history and stay.

## 9. Risks

- **FKs reject a production write path tests do not cover** → 500 on a real
  action. Mitigation: NOT VALID only checks new writes, which tests exercise
  broadly (server 1000+ tests, e2e in CI); the owner can drop 0006's constraints
  with one statement each (documented in the migration header).
- **Mass reformat hides a real change.** Mitigation: its own task; the review
  checks the diff is whitespace/punctuation-only (`git diff -w` empty modulo
  Prettier's quote/comma rules) and the full suite passes.
- **knip removals break a dynamic import.** Mitigation: full ci:check + builds +
  e2e.

## 10. Binding details (spec review, 2026-10-15)

These override §1–§9 wherever they conflict. Evidence: `.superpowers/sdd/2026-10-15-s5-hygiene/s5-spec-review.md`.

1. **ResourceWarning gate:** GC-time leaks reach pytest as
   `PytestUnraisableExceptionWarning`, so `filterwarnings` gets both
   `error::ResourceWarning` and `error::pytest.PytestUnraisableExceptionWarning`,
   plus an autouse `conftest.py` fixture that runs `gc.collect()` at teardown so a
   leak fails the test that caused it. Prove the gate with a throwaway leaking
   test (not kept).
2. **e2e job env:** the Playwright `webServer` env supplies every variable
   `server/src/config/env.ts` requires (a test-only `SESSION_SECRET` ≥ 32 chars,
   `DATABASE_URL` from `E2E_DATABASE_URL`, …), because CI has no `server/.env`.
   Proof without touching `.env`: a test or script parses `EnvSchema` with exactly
   the webServer env and nothing else. Local `npm run test:e2e` green.
3. **FK prerequisites:** `server/scripts/seed.ts` resets in child-before-parent
   order (or one `TRUNCATE … CASCADE`); test seeds that insert children with
   made-up parent ids create the parents; `comments.service.test.ts` stops
   hard-deleting a user (tombstone it). Orphan-script tests create orphans with
   `SET LOCAL session_replication_role = replica` inside a transaction
   (superuser in the local test DB and the CI service).
4. **FK table additions/rules:** add `posts.echo_of → posts` (NO ACTION).
   `notifications.post_id/comment_id/message_id/conversation_id` get **no** FK
   (a delivery log of soft-deleted targets). Drizzle has no NOT VALID: hand-edit
   the generated SQL; the migrator runs it as is.
5. **Script safety:** `db:orphans` prints the target host/database first and runs
   in a `READ ONLY` transaction; `db:validate-fks` prints the target and refuses
   without `--yes`; both read `DATABASE_URL` from the environment/dotenv like the
   other scripts and say so in `--help`.
6. **Prettier:** `.prettierignore` gains `server/src/db/migrations/meta/**` (drizzle-kit
   output) and the generated contract copies (byte-identical to formatted source;
   formatting them would break `contract:check` if the source were unformatted —
   the source is formatted by the same pass, then `contract:sync` rewrites the
   copies). "Pure formatting" is verified by snapshotting before/after the pass,
   reviewing that diff alone, and re-running the full suite.
7. **knip:** use `ignoreExportsUsedInFile` (UI primitives' Props types); keep the
   `arms/protocol.ts` constants (pre-registered numbers, intentionally exported).
8. **Tasks run strictly in plan order** (they share `ci-check.sh`, `ci.yml`,
   `server/package.json`, `09-contributing.md`).
9. **Mongo comments:** also `lib/id.ts`, `lab/shared.ts`, `test/setup.ts` and any
   other grep hit in current code; ADR 005 gets one dated status line
   ("residual Mongo artefacts removed 2026-10-15, S5") — the ADR body stays.
   Launch checklist notes `/health` no longer returns `mongo` (for any external
   monitor).
10. **Echo create response:** after the insert, re-read the echo with
    `getPostForViewer` (so `echoCount` and the embedded original match a read);
    the test compares the create response to `GET /posts/:echoId`.
11. **Follow-up 2/3:** export `publicAgentBackend` from `lib/dto.ts`; API-key
    bodies use `toISOString()` and `satisfies` the contract type.
12. **Handoff split by status, not date:** open items (the undeployed 2026-10-11
    SPA fix, "Owner action items", the launch checklist, open follow-ups) stay in
    `docs/12-handoff.md` whatever their date; closed dated entries move verbatim.
    Docs that cite handoff sections by name are updated. §8's list also covers
    `00-vision`, `07-setup`, `19-testing-standards`.
