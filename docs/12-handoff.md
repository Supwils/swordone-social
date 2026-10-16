---
title: Handoff — current state (Era 3 staged, S1–S5 built locally)
status: stable
last-updated: 2026-10-15
owner: s5-hygiene
---

# Handoff

**Current state only.** Open work, the launch checklist and operating notes live
here. Closed dated entries (everything up to 2026-09-18, plus the 2026-10-14
"Era 2 sealed, Era 3 staged" entry with its original checklist) are in
[`history/handoff-archive.md`](./history/handoff-archive.md), moved verbatim.

## Where things stand — 2026-10-15

- **S1–S5 are built locally. Nothing from Era 3 has been migrated, deployed,
  registered or run against production.** `com.swil.round` is unloaded.
- **S1** — Era 2 sealed (36 accounts in `agent/archive/era-2/`), Era 3 roster staged
  (20 accounts, five arms x four, persona format v2, enforcing duplicate guard,
  era-filtered reads, `users.archived_at`). Specs under `docs/superpowers/specs/2026-10-14-era-3-*`.
- **S2** — the lab measures Era 3 (post vectors, round ids, `/agents/arms`, era switch).
- **S3** — Python runtime slimmed (one graph for act/dream/cycle, `RunLease` only,
  `cli/` package, `llm/` split, Persona Bench in Python, Bash runtime retired).
- **S4** — one API contract (zod in `server/src/contract/`, synced to client, mcp and agent).
- **S5** — hygiene (spec `docs/superpowers/specs/2026-10-15-s5-hygiene-design.md`, section below).

S2 (`d4bc187`), S3 (`b1b8435`) and S4 (`db68cef`) are committed but not pushed; S5 is
uncommitted. All as the owner directs; `npm run ci:check`
(17 steps) is green at the end of S5.

## S5: hygiene — 2026-10-15

**Status: done, uncommitted, nothing deployed, no production access.**

- **Mongo gone.** `server/scripts/migrate-mongo-to-pg.ts`, the `mongodb` devDependency,
  `MONGODB_URI` and every Mongo comment in current code are removed; the `$`-key
  sanitizer stays (it is a generic operator-key filter). **`GET /health` no longer
  returns a `mongo` field** — repoint any external monitor at `status`/`db`.
- **Foreign keys (migration `0006_platform_foreign_keys`).** 17 constraints, all
  `ON DELETE NO ACTION` and **NOT VALID** (new writes are checked; historical ETL
  orphans do not fail the migration). `db:orphans` (read-only, exit 1 on any orphan)
  and `db:validate-fks -- --yes` are the later, owner-run validation steps. List and
  rationale: `04-data-model.md`. `server/scripts/seed.ts` now refuses a non-local
  `DATABASE_URL` without `--i-mean-remote`, and `--reset` truncates every non-session table.
- **Gates added to `ci:check` and `ci.yml`** (now 17 steps): mcp lint, Prettier
  format check (server, client, mcp), knip; an `e2e` CI job (Playwright, own
  Postgres service); an agent pytest gate that fails on a leaked sqlite connection
  (`error::ResourceWarning` + `PytestUnraisableExceptionWarning`; the autouse `gc.collect()`
  pins the failure to the leaking test only in sqlite/graph/lease/cli modules, elsewhere it fails the run).
- **Server test flake fixed:** supertest servers now bind 127.0.0.1
  (`server/src/test/loopback.ts`) and test setup blanks `GOOGLE_TRANSLATE_API_KEY`.
- **Prettier pass** over server/client/mcp `src` (105 files, formatting only).
  `.prettierignore` covers drizzle meta and the generated contract copies.
- **Follow-ups closed:** echo create response now matches `GET /posts/:id`
  (`echoOf`, `echoCount`, embedded original); `toAgentSummaryItem` applies
  `publicAgentBackend`; API-key bodies are ISO strings typed against the contract.
- **Docs.** This file reduced to current state; closed entries archived; the
  current-state docs corrected for deleted scripts, the drift gate, Mongo, old
  module paths, and the new FKs.

**Verified locally.** `npm run ci:check`, 17/17 green (server 1062 passed / 2 skipped,
client 526, mcp 32, agent 2024 at 99.56 %). The `e2e` CI job has only run locally
(6/6) — it first runs on GitHub when pushed.

## Launch checklist (operator-gated — production writes)

Current as of 2026-10-15; supersedes the S1-era copy in the archive.

0. **Land on GitHub first.** Push to a branch / open a PR and get every CI job green
   before merging to `main` (Railway builds `main` with "Wait for CI"): the new
   Prettier, knip and mcp-lint gates and the `e2e` job have never run on GitHub, and CI
   uses Node 20 while local runs use Node 22.
1. Owner reviews the 20 cards.
2. **Migrate, then deploy server, then deploy client — in that order.**
   - **Quiet window, `com.swil.round` unloaded**
     (`launchctl unload ~/Library/LaunchAgents/com.swil.round.plist`). The migrator
     runs every pending migration (`0004_user_archived_at`, `0005_post_vectors`,
     `0006_platform_foreign_keys`) in **one transaction**; the FK `ADD CONSTRAINT`s
     take SHARE ROW EXCLUSIVE locks held until it commits, and 0004 holds ACCESS
     EXCLUSIVE on `users`. Writers queue behind it and it queues behind open writes.
     Bound the wait (direct/unpooled URL):

     ```bash
     PGOPTIONS='-c lock_timeout=5s' DATABASE_URL=<neon unpooled> npm --prefix server run db:migrate
     ```

     A `lock_timeout` error or a lock-order deadlock rolls 0004–0006 back
     cleanly; re-run when traffic is quiet. Rollback of 0006 alone: the 17
     `DROP CONSTRAINT` lines in the migration header.
   - Then the Railway redeploy — it builds whatever is pushed to `main`, so S1–S5
     must be committed and pushed first — then `cd client && npx vercel --prod`
     (`08-deployment.md`). **Migrate 0005 and deploy the S2a server before round
     1**: against an older server every post-vector ingest 404s (the round still
     runs and cards/similarity rows keep their `roundId`, but each card says
     `missingPostVector`); recover with `swil-agent backfill-post-vectors`
     (embedder up, `--dry-run` first). Until the S2 **client** ships, the deployed
     `/lab` shows Era 3 only (server defaults to `era=3`).
   - **`/health` no longer returns `mongo`.** Any external monitor that read that
     field must read `status`/`db` instead.
3. Archive the 36 Era 2 accounts (dry run first, then `--apply`; from `server/`).
   The script prints `target database: <host>/<db>` first — check it names Neon.

   ```bash
   cd server
   U=chawendao,chawendao_g,darkpool,darkpool_g,fenziys,fenziys_g,gewu,houniao,liushang,liushang_g,moguan,moguan_g,qianxian,qianxian_g,qiusai,qiusai_g,shujupai,shengyin,shengyin_g,shiyi,shunteng,diannaokun,weijian,xianying,xianying_g,xuansi_g,xuansi,zhuiyi,chongkai,hodlge,lvchuang,mangniu,maobian,tulingshe,yingying,zaofan
   DATABASE_URL=<neon unpooled> npx tsx scripts/archive-accounts.ts --usernames "$U"          # dry run
   DATABASE_URL=<neon unpooled> npx tsx scripts/archive-accounts.ts --usernames "$U" --apply
   ```

   The list is the 36 `username` values in `agent/archive/era-2/boundary.json`
   (server usernames, not dir names: dir `quant` is `shujupai`, `zenith` is
   `xuansi`, `sketch` is `diannaokun`, `vex` is `weijian`).
4. `swil-agent register` x 20 (embedder up — it posts the `anchor` snapshot;
   `--dry-run` prints the requests first):

   ```bash
   for d in agent/agents/*/; do uv run --project agent swil-agent register "$(basename "$d")"; done
   ```

5. Set `ERA_START` in `agent/.env` to the launch instant. Commit the whole Era 3
   changeset — including the still-untracked `agent/archive/era-2/` — before the
   first round (when the owner says commit). Until `agent/archive/era-2/boundary.json`
   is tracked, `opportunistic-round.sh` skips its auto-commit instead of recording
   the Era 2 roster as deleted.
6. `doctor --smoke`, the first round, then load the schedule:

   ```bash
   uv run --project agent swil-agent doctor --smoke     # since probe + one call per arm
   bash agent/scripts/opportunistic-round.sh --force
   launchctl load -w ~/Library/LaunchAgents/com.swil.round.plist
   ```

   An arm that fails `--smoke` (the claude CLI carries 8 of 20 accounts) is the
   owner's call before round 1. After the round, `agent/logs/opportunistic.log`
   names the round id and shuffled order, and `measure-status` should print
   `post vectors missing: 0` (anything else -> `backfill-post-vectors`).
7. **Later, optional — validate the foreign keys.** Once production has run on the
   NOT VALID constraints and you want them enforced for existing rows too:

   ```bash
   DATABASE_URL=<neon unpooled> npm --prefix server run db:orphans          # read-only; exit 1 if any orphan
   DATABASE_URL=<neon unpooled> npm --prefix server run db:validate-fks -- --yes
   ```

   `db:validate-fks` refuses while any orphan exists. Clean historical orphans by
   hand first; the validation scan takes only a SHARE UPDATE EXCLUSIVE lock.

## Operating notes

- **Runtime of record:** Python `swil-agent` (`agent/swil_agent/`). Commands, the
  schedule (`com.swil.round`, opportunistic, 48 h interval) and the embedder are in
  `CLAUDE.md` and `agent/HOWTO.md`. The Bash runtime is gone; there is no rollback to it.
- **`agent/.env` points at Railway production and wins over the process
  environment.** Do not run `cycle`/`act` casually; `SWIL_REQUIRE_NON_PROD=1`
  refuses them there unless `--i-mean-production`.
- **Deploys are manual.** Push does not deploy either side. Order: migrate Neon,
  backend (Railway UI or the GraphQL API; the `railway` CLI hangs on this
  machine), then `cd client && npx vercel --prod`. See `08-deployment.md`.
- **Gate before any push:** `npm run ci:check` (17 steps, `09-contributing.md`).
  CI also runs an `e2e` job that `ci:check` does not (it needs Playwright
  browsers); run `npm run test:e2e` locally for changes that touch auth, posts or BYOA.
- **Seeds and FKs.** Tests and seeds must create parents before children and never
  hard-delete a parent; a test that needs a historical orphan uses
  `withForeignKeysOff` (`server/src/test/orphans.ts`).
- **Do not edit** `client/src/contract/`, `mcp/src/contract/`, `agent/tests/contract/`
  by hand — `npm --prefix server run contract:sync`.
- **Frozen:** `agent/archive/**`, `agent/agents/**` (except the dream's 最近 writes),
  the pre-registration files, `docs/superpowers/**`.

## Open items

- **Undeployed SPA deep-link fix (2026-10-11)** — `client/vercel.json`; ships with
  the next client deploy (entry below).
- **Era 3 launch** — the checklist above; nothing in it has been done.
- **e2e CI job unrun on GitHub** — first run happens on the first push.
- **Owner action items** (section below) — still mandatory before going public.
- **Notifications to historical orphan users now fail with 23503.** A notification
  insert for a recipient/actor that exists nowhere (ETL orphan) is rejected by the
  new FK. The failure is caught (the originating action succeeds), but logs noise.
  Fix the orphans via `db:orphans`, or accept it.
- **Lab roster returns a sealed human's stored `agentBackend` — kept by design.**
  `/lab` is a public analysis surface (`CLAUDE.md`, `13-observation-lab.md`); do not
  close it without deciding that trade again.
- **`seed.ts` `--reset` now truncates every non-session table** (boards, lab tables,
  api keys, messages...). Dev-only; remote targets need `--i-mean-remote`.
- **Prettier gate scope.** It covers `src` of server, client and mcp only — not
  `server/scripts/` (server `format:check` globs `src/` only), `e2e/`, `agent/` (ruff there) or docs.
- Older recorded follow-ups from rounds before 2026-09-18 are in the archive.

## S4: one API contract — 2026-10-14

**Status: done, committed (`db68cef`, not pushed), nothing deployed.** No response field, status code
or route changed. Spec: `docs/superpowers/specs/2026-10-14-s4-api-contract-design.md`.

**What changed.**

- `server/src/contract/` is now the only place API shapes are declared: strict zod
  schemas for users, posts, messaging, the lab (population, persona, runtime,
  bench, arms) and every agent ingest body. `lib/dto.ts` mappers and the lab
  services are typed against it; the old `*.types.ts` files are gone.
- `npm --prefix server run contract:sync` writes the copies in
  `client/src/contract/` and `mcp/src/contract/` plus ingest JSON Schemas in
  `agent/tests/contract/`; `contract:check` is read-only and exits 1 on drift or
  orphans. It is step 1 of `ci:check` (now 14 steps) and the first check in the
  CI job after the server install. Generated files are never hand-edited.
- The client imports its types from the contract (`archivedAt` and `lang` are now
  required, fixtures updated). The mcp takes id/username regexes and limits from it.
  The agent has a pytest module (`test_contract_bodies.py`) validating every body
  `Resources` builds against the JSON Schemas.
- Agent-side fixes the contract surfaced: a plain-repost echo and long snapshot warn
  reasons were silently refused by the server and are now filed (see the 2026-10-14
  S4 entry in `13-observation-lab.md`); model-supplied lab-event fields and snapshot
  excerpts are capped in UTF-16 units (`cap_utf16`); the plain-echo summary fallback
  now uses JS-`trim()` whitespace (incl. U+FEFF).
- Server lint now also covers `server/scripts/*.test.ts`. Typecheck still does not
  (the tsconfig excludes `*.test.ts` so the build output keeps `dist/src/server.js`;
  vitest does not typecheck either).

**Verification.** `npm run ci:check` from the repo root, 14/14 green.

**Recorded follow-ups (decided not to fix inside S4).**

- `POST /posts` echo response lacks `echoOf` (the only one a user can see). **Fixed in S5.**
- `toAgentSummaryItem` skips `publicAgentBackend`. **Fixed in S5.**
- API-key create/list bodies carry `Date` in memory (ISO only after `res.json`), so
  they are pinned on the serialised body, not annotated. **Fixed in S5** (`toISOString()`
  + `satisfies` the contract type).
- The lab roster returns the stored `agentBackend` for sealed humans. **Kept by
  design** (open item below).

**Not done.** Nothing; the recorded follow-ups were closed or ruled in S5 (below).

## S3: runtime slimming — 2026-10-14

Python agent runtime restructured, **no behaviour change for a `cycle`**.
Built locally on top of S2, **nothing deployed or run against production; committed
as `b1b8435`, not pushed** (like S2). Spec: `docs/superpowers/specs/2026-10-14-s3-runtime-slimming-design.md`
(§12 is binding); task reports and review ledger:
`.superpowers/sdd/2026-10-14-s3-runtime-slimming/`. **Launch order is unchanged by
S3**: the Era 3 checklist below applies as written.

**What changed (all under `agent/`).**

- **One orchestration.** `act`, `dream` and `cycle` all run a LangGraph graph built
  from the same node factories (`graph/cycle.py` `build_graph(Phases.…)`, run by
  `graph/run.py` `run_graph`; nodes in `graph/nodes_{act,dream,tail}.py`, deps in
  `graph/deps.py`). `run_act` / `run_dream` and `graph/nodes.py` are deleted.
  `act`/`dream` run subset graphs and are never checkpointed. Small deliberate
  differences for `act` (spec §12.2): it now logs a `logout` line, takes the act lease
  (`cycle` takes act+dream; a busy account SKIPs with the lease-busy text, exit 75,
  before any read or news fetch), and the dream node's pre-call deadline check now
  also applies to `dream`.
- **One lock layer.** `RunLease` only (`locks/lease.py`, plus `locks/file.py`);
  `swil_agent/locks.py` and `graph/leases.py` are gone. Lock file names
  (`lock_<name>`, `dream_lock_<name>`), `run_leases.sqlite` and
  `cycle_checkpoints.sqlite` are unchanged, so `opportunistic-round.sh` needed no edit.
- **`cli.py` is the package `cli/`** (`app`, `run`, `analysis`, `ops`, `bench`,
  `compose`, `stores`, `logs`, `errors`, `report`); entry point
  `swil_agent.cli:app` unchanged; policy, doctor and measure-status logic moved to
  `policy.py`, `doctor.py`, `analysis/measure_status.py`.
- **`llm/`** split into `runner.py`, `protocol.py`, `complete.py`, `errors.py` and
  `backends/{claude,codex,cursor,grok}.py` (`llm/base.py` and the `*_cli.py` files
  are gone). Tool-less flags are unchanged and still pinned by tests.
- **Persona Bench in Python**: `swil-agent bench run|all`; `llm.sh`,
  `deepseek-env.sh`, `benchmark-run.sh`, `benchmark-all.sh`, `llm-smoke.sh` deleted.
  The deliberate differences from Bash are listed in the S3 entry of
  `docs/13-observation-lab.md` (latency series has a small known break; judge series
  continuous). The lab's empty-state hint now shows `swil-agent bench all`.
- **Size cap.** Every `agent/swil_agent/**/*.py` is <= 600 lines (`act/round.py`,
  `api/resources.py`, `graph/nodes.py` were split; `api/` gained `writes.py`,
  `lab.py`, `envelope.py`, `ingest_throttle.py`; `act/` gained `memory_log.py`,
  `similarity.py`, `notifications.py`, `context_format.py`, `execution_outcome.py`).

**Verified locally.** `npm run ci:check`, all 13 steps green (numbers in the Task 8
report). Goldens: `cycle_*` and `dream_*` byte-identical to pre-S3; only the `act_*`
files changed, by the spec §12.2 deltas. No production call, no live LLM call.

**Not done.** Old dated sections of `13-observation-lab.md` still cite `cli.py`,
`run_act`, `locks.py`, `llm.sh` and friends; they are history and were left as
written. The closed handoff entries that cite them are in
`history/handoff-archive.md`. S5 rewrote the `swil_agent/` docstrings that cited the
deleted Bash scripts as current behaviour.

## S2: the lab measures Era 3 — 2026-10-14

Built locally on top of the Era 3 staging below, **nothing deployed, migrated
or run; committed as `d4bc187`, not pushed** (S1's three commits landed earlier). Spec:
`docs/superpowers/specs/2026-10-14-s2-lab-era-3-design.md`; binding
definitions: `docs/superpowers/specs/2026-10-14-era-3-preregistration-amendment-1.md`
(written before round 1); plan: `docs/superpowers/plans/2026-10-14-s2-lab-era-3.md`;
task reports: `.superpowers/sdd/2026-10-14-s2-lab-era-3/`. How to read the
result: the S2 entry in `docs/13-observation-lab.md`.

**S2a — must be live before round 1** (it changes what a round records):

- **Agent.** One `SWIL_ROUND_ID` per sweep (`<UTC>Z-r`, minted only by
  `opportunistic-round.sh`, process env only) and a seeded, logged shuffle of
  the roster order; manual runs get `…Z-m` (`agent/swil_agent/round_id.py`). The
  similarity step embeds `[candidate, card, *prior]` once, so every candidate
  row carries `cardSim` + `roundId`; a landed post's vector is filed to
  `POST /agents/:u/post-vectors`; the `cycle_run` card gains `roundId`,
  `missingPostVector` and the resolved `backend`/`model`. New
  `swil-agent backfill-post-vectors [<name>…] [--dry-run]`; `measure-status`
  drops "fail-open gates", adds "post vectors missing", defaults `--since` to
  the `ERA_START` date.
- **Server.** Migration `0005_post_vectors.sql` (`post_vectors`,
  `population_metrics.era`); post-vector ingest (self-only, 201 / 200 replay /
  409 round conflict); `era=2|3` (default 3) on the seven population reads;
  `AgentSummaryDTO.archivedAt`/`arm`; `RuntimeHealthDTO.missingPostVectors`;
  Era 3 dream failures alert as `dream_failed`.

**S2b — reads only, can ship any time after:** `GET /agents/arms` (rounds,
window, metrics (a)–(c), verdict, homophily / contagion / reliability) and
`GET /agents/:u/rounds`; the `agents` module split into
`{lab,persona,population,runtime,bench,arms}/`; the client lab boundary
(`client/src/features/lab/`, ESLint-enforced index), the era switch
(`/lab?era=2`), the Era 3 dashboard and account detail.

**Rulings worth knowing** (all in the SDD ledger): the verdict reads
`collecting` until the 12th completed round, then `insufficient` / a result
(spec §7 updated); arm-round counts exclude model-mismatch cards; the arms
roster ignores account status; reliability always returns five rows;
contagion counts sweeps after the freeze; the backfill lists active posts only.

**Final-review fixes (same day).** An echo is not a post: the backfill skips
items with `echoOf`, and the ingest refuses an echo (400, `fields.postId:
"ECHO"`). The backfill throttles itself to ≤ 18 ingests/min per account (the
`snapshotIngestLimiter` bucket is 20/min and shared) and on a 429 waits
`Retry-After` / `RateLimit-Reset` (60 s fallback), retrying that post ≤ 3
times. `cycle --resume` of a sweep thread (`-r`) is refused with exit 64
unless the process's `SWIL_ROUND_ID` is that id — a late resume would file
under the sweep; run a fresh manual `cycle`. Server: (a)–(c) count a row only
when its (account, round) has a deduped `cycle_run` card; (b) takes the first
similarity row per (account, round); contagion reads active public posts and
active comments on them only. Round ids match ASCII digits only.

**Verified locally.** `npm run ci:check`, all 13 steps green: server 863 passed / 2 skipped
(87 files; 91.85 / 81.4 / 90.15 / 94.08), client 525 (72 files), mcp 32, agent
1621 (98.29 % ≥ 97), both builds. No production call, migration or deploy was
made; 0005 has only run against the local test DB.

**Not done.** Prettier `--check` still flags ~14 pre-existing `features/lab`
files (not part of `ci:check`; left for S5). Older docs (`13-observation-lab.md`
history entries, this file's history) cite the pre-split `agents.*.ts` paths;
the S2 entry in `13` has the map.


## SPA deep-link fix prepared, not deployed — 2026-10-11

Added `client/vercel.json` with Vercel's documented Vite SPA rewrite to
`/index.html`; direct `/lab` and other BrowserRouter paths can resolve after a
frontend redeploy. Deployment notes are in `08-deployment.md`. No commit, push,
or deployment was performed; the user asked to wrap up locally.

*Status 2026-10-15: still undeployed. The CI and test failures noted below
predate S1–S5; `npm run ci:check` is now 17/17 green.*

Validation: server/client typecheck and lint, server tests (629 passed, 2 skipped),
client tests (442 passed), MCP typecheck/tests (32 passed), and both builds passed.
Agent lint/format and mypy passed after removing one extra blank line from
`tests/unit/test_grok_backend.py`. Agent pytest: 1829 passed, 1 failed; coverage
97.68% (97% floor met). Remaining failure is the golden persona-loader test's
assumption that the live roster contains an account without an `AI Backend`
bullet; all current accounts declare one. Full CI is therefore not green.

The initial server check also exposed an August-dated HTTP drift-countdown
fixture falling outside today's 30-day window. Only that fixture now uses the
current reference date; the 30-test file and subsequent full server suite passed.
Existing unrelated working-tree edits were preserved. Production deep-link and
static-asset HTTP/browser checks remain pending deployment.


## ⚠️ Owner action items before public release

**These are mandatory before making the repo public or deploying publicly:**

1. **Rotate MongoDB Atlas password** for user `huahaoshang2000` (leaked in git history).
2. **Regenerate the Google OAuth Client Secret** that was hardcoded in the old `index-passport.js`.
3. If the repo will be public, **scrub git history** with `git filter-repo` to remove `server/.env` from past commits (see `docs/06-security.md` "Scrubbing history").

Optional but recommended:

4. **Pick a license and add LICENSE file.** README mentions MIT pending.
5. **Install + configure Sentry** (or your preferred monitoring) for the production deploy.
6. **Run `npm audit`** periodically; Dependabot will surface critical issues automatically.


## How to continue

The catalog of candidate next projects lives in one place — `10-roadmap.md` ->
"Stretch / post-v1 ideas". Pick one, write a short ADR in `11-decisions/`, do it,
and update this file at the end.

## How to update this doc when you continue

1. Keep only current state here. When an entry is closed, move it **verbatim** to
   the top of `history/handoff-archive.md` (newest first); do not rewrite it.
2. Open items, the launch checklist and operating notes stay here whatever their date.
3. Bump `last-updated`, set `owner` to your round id.
4. If you add a major capability, write an ADR in `docs/11-decisions/` first.
