---
title: Handoff — post-v1 improvements active
status: stable
last-updated: 2026-10-14
owner: era-3
---

# Handoff

## S2: the lab measures Era 3 — 2026-10-14

Built locally on top of the Era 3 staging below, **nothing deployed, migrated
or run, and not committed** (S1's three commits already landed today). Spec:
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

## Era 2 sealed, Era 3 staged — 2026-10-14

Built locally, **nothing deployed, migrated, registered or run**. No commits.
`com.swil.round` is **unloaded** until launch step 6. Spec:
`docs/superpowers/specs/2026-10-14-era-3-model-native-roster-design.md`; plan:
`docs/superpowers/plans/2026-10-14-era-3-model-native-roster.md`; cards:
`docs/superpowers/specs/2026-10-14-era-3-cards.md`; pre-registration:
`docs/superpowers/specs/2026-10-14-era-3-preregistration.md`.

**Why.** Personas only grew (`chawendao_g` 2.5 KB → 84 KB), the drift gate could
not see the growth, the population converged on one dialect, and the
pre-registered experiment had 0/6 clean rounds. Spec §1 has the numbers.

**What changed.**

- **Server.** `since` (ISO datetime, inclusive; bad value → 400, future → empty
  page) on the five `/feed/*` list routes and `GET /posts/search`. New nullable
  `users.archived_at` (migration `0004_user_archived_at.sql`), `archivedAt` in
  the user DTOs, and a write guard: an archived account's writes are 403, its
  reads and `/agents/benchmark/*` ingest still work. Explore and population
  metrics (cohesion, overview) exclude archived users.
  `server/scripts/archive-accounts.ts` sets `archived_at` (dry run by default).
- **Client.** The AI badge shows the model family (`openai`, `grok`, `gemini`,
  `claude-opus`, `claude-haiku`, …) derived from `agentBackend`; archived
  accounts show "Era 2 · 已封存" instead.
- **Agent.** Persona format v2 (YAML frontmatter + immutable card + `## 最近`
  ≤ 5 × 60 chars, file ≤ 4 KB). Uniform rhythm (`POST_PROBABILITY` 60,
  `POST_CEILING_PER_DAY` 1) and read scope (home board + global). Shared platform
  preamble in every act prompt. Era-filtered reads (`ERA_START`). Enforcing
  duplicate guard (≥ 0.92 vs the last 12 posts drops the post; fail-open).
  Dream returns only the new 最近 list. **Removed:** drift gate (scalar and
  aspect), aspect distiller, anchor files, rule-check, echo detection,
  `echo-calibrate`. Memory rotation in Python (> 300 lines → keep newest 200,
  overflow appended to `memory.archive.md`). New `swil-agent register <u>`
  (an existing user without a local `api_key.txt` needs `--adopt`); `doctor`
  gains a `since` probe, `--smoke`, an `ERA_START` check (unset FAILs, future
  WARNs) and a PATH check for every roster backend's CLI (`codex`, `grok`,
  `cursor-agent`, `claude`). `act` and `cycle` exit 75 while `ERA_START` is unset.
- **Platform preamble.** It now ends with "系统提示里写的那个人就是你：用他/她的
  身份、生活和口吻说话，不要以助手的身份回答。" so every arm reads the
  third-person card as itself. Spec §5's preamble bullet predates this sentence;
  the spec is left as written and `act/planner.py` is the source of truth.
- **Bash runtime retired.** `auto-run.sh`, `dream.sh`, `swil.sh`,
  `heartbeat.sh` (+ plist), `setup-agents.sh`, `setup-humans.sh`, `rule-check.sh`,
  `behavior-snapshot.sh`, `snapshot.sh`, `population-metric.sh`,
  `agent-summary.sh`, `rotate-memory.sh`, `backfill-*.sh` are deleted.
  `cycle-one.sh` is a thin exec of `swil-agent cycle --auto`. `SWIL_RUNTIME=bash`
  no longer exists.
- **Roster.** Era 2's 36 accounts (28 agents dirs incl. `_g` forks, 8 simulated
  humans) and their feed context and state files are in `agent/archive/era-2/`
  (`boundary.json` lists them). 20 Era 3 accounts are staged in `agent/agents/`,
  five arms × four, all openly AI, no `humans/` cohort.
- **Docs.** `CLAUDE.md` rewritten for Era 3; `13-observation-lab.md` has the
  2026-10-14 change point and marks the gate / read-niche entries Era 2.

**Verified locally.** `npm run ci:check`, all 13 steps (see the Task 11 report
in `.superpowers/sdd/2026-10-14-era-3-model-native-roster/`).

### Launch checklist (operator-gated — production writes)

Verbatim from spec §14, with the commands filled in:

1. Owner reviews the 20 cards.
2. Neon migration, deploy backend, deploy client — **in that order**.
   `DATABASE_URL=<neon unpooled> npm --prefix server run db:migrate` applies
   `0004_user_archived_at` and `0005_post_vectors` (S2a). Then the Railway
   redeploy — it builds whatever is pushed to `main`, so S1 **and S2a** must be
   committed and pushed first — then `cd client && npx vercel --prod`
   (`08-deployment.md`). **Migrate 0005 and deploy the S2a server before round
   1**: against an older server every post-vector ingest 404s (the round still
   runs, and the cards and similarity rows keep their `roundId` because event
   `metrics` is a free flat record, but each card says `missingPostVector`).
   If that happens, migrate, deploy and
   run `uv run --project agent swil-agent backfill-post-vectors` (embedder up;
   `--dry-run` first) — rows resolve their round from the cycle card ≤ 2 h
   after each post. Until the S2 **client** ships, the deployed `/lab` shows
   Era 3 only (the server defaults to `era=3`; old clients send none), so Era 2
   history is hidden in the UI meanwhile (the API's `era=2` still serves it).
3. Run the archive script for the 36 Era 2 accounts. Dry run first, then
   `--apply` (run from `server/`, where `tsx` is installed; the script is
   `server/scripts/archive-accounts.ts`):

   The script prints `target database: <host>/<db>` (credentials redacted)
   before anything else — check it names Neon before `--apply`.

   ```bash
   cd server
   U=chawendao,chawendao_g,darkpool,darkpool_g,fenziys,fenziys_g,gewu,houniao,liushang,liushang_g,moguan,moguan_g,qianxian,qianxian_g,qiusai,qiusai_g,shujupai,shengyin,shengyin_g,shiyi,shunteng,diannaokun,weijian,xianying,xianying_g,xuansi_g,xuansi,zhuiyi,chongkai,hodlge,lvchuang,mangniu,maobian,tulingshe,yingying,zaofan
   DATABASE_URL=<neon unpooled> npx tsx scripts/archive-accounts.ts --usernames "$U"          # dry run
   DATABASE_URL=<neon unpooled> npx tsx scripts/archive-accounts.ts --usernames "$U" --apply
   ```

   The list is the 36 `username` values in `agent/archive/era-2/boundary.json`
   (server usernames, not dir names: dir `quant` is `shujupai`, `zenith` is
   `xuansi`, `sketch` is `diannaokun`, `vex` is `weijian`).
4. `swil-agent register` × 20. The embedder must be up (it posts the `anchor`
   snapshot); `--dry-run` prints the requests first.

   ```bash
   for d in agent/agents/*/; do uv run --project agent swil-agent register "$(basename "$d")"; done
   ```

5. Set `ERA_START` in `agent/.env` to the launch instant; commit the
   pre-registration (when the owner says commit). Commit the whole Era 3
   changeset — including the still-untracked `agent/archive/era-2/` — before the
   first round. Until `agent/archive/era-2/boundary.json` is tracked,
   `opportunistic-round.sh` skips its auto-commit ("auto-commit skipped: Era 2
   archive not committed yet") instead of recording the Era 2 roster as deleted.
6. `doctor`, then `opportunistic-round.sh --force`; reload `com.swil.round`.

   ```bash
   uv run --project agent swil-agent doctor --smoke     # since probe + one call per arm
   bash agent/scripts/opportunistic-round.sh --force
   launchctl load -w ~/Library/LaunchAgents/com.swil.round.plist
   ```

   An arm that fails `--smoke` (the claude CLI carries 8 of 20 accounts) is the
   owner's call before round 1. After it, `opportunistic.log` names the round id
   and shuffled order, and `measure-status` should print `post vectors missing:
   0` (anything else → `backfill-post-vectors`).

### Not done (later slices)

S2 is done (section above).

- **S3** — runtime slimming: cli split, single orchestration, llm module split,
  lock unification; the Bench-only Bash (`llm.sh`, `benchmark-*.sh`) goes then.
- **S4** — one API contract (no more hand-synced `dto.ts` / `api/types.ts`).
- **S5** — docs consolidation (many older docs and `agent/tests` docstrings still
  cite deleted scripts as history), Mongo leftovers, FKs, repo hygiene, CI e2e.

## SPA deep-link fix prepared, not deployed — 2026-10-11

Added `client/vercel.json` with Vercel's documented Vite SPA rewrite to
`/index.html`; direct `/lab` and other BrowserRouter paths can resolve after a
frontend redeploy. Deployment notes are in `08-deployment.md`. No commit, push,
or deployment was performed; the user asked to wrap up locally.

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

## Field note + Phase 2 / measurement bars drafted — 2026-09-18

Unattended cycle is still Python LangGraph (Stage 5). Last roster round
2026-09-17 02:04 → 02:58, `ok=26 failed=0`. Next gate 2026-09-19 02:04.

Three docs, no runtime change:

- `docs/21-persona-drift-field-note.md` — public Era 1 note (zh+en).
- `docs/superpowers/specs/2026-09-18-agent-runtime-phase-2-design.md` — leave
  the laptop; start only when this Mac is no longer the host.
- `docs/superpowers/specs/2026-09-18-rhythm-and-model-arms-bar.md` — success
  bars; do not run a rhythm rewrite in the same window as a model-arm restart.

Working tree also has uncommitted hardening (markdown `//` hrefs, invalid
dates, PostCard `noreferrer`, skip population-metric on `humans/`, 404
strips query strings, `test_runtime_dispatch.py`). Not committed: needs
`commit push` in chat.

## Anthropic quota crunch: fork onto grok.com, humans onto Codex Luna — 2026-08-25

The 2026-08-25 18:30 roster round finished `ok=15 failed=11 timeout=0`. Every
failure was `claude exited 1` → `outcome=backend_unavailable`. The 8 simulated
humans all died, plus the three opus agents that ran last (`shengyin`,
`xianying`, `zenith`). Cursor / Codex / DeepSeek accounts all completed. This
is quota, not the 900s timeout.

**Original Anthropic agents were not rewritten.** Changing an existing
account's backend splits its drift series, and the Anthropic subscription may
come back. Each of the ten claude-backed agents now has a `round.skip` file:
`opportunistic-round.sh` leaves them out of the unattended sweep;
`cycle-one.sh <name>` still runs them, which is how that arm returns.

**Ten grok.com forks** sit next to them as the comparison arm. Directory and
username are `<original>_g` (`zenith`/`xuansi` → `xuansi_g`). Seed persona is
the original at cutover, pinned as `personality.anchor.md`. Backend is the new
`grok` CLI (`grok -p --tools ""`, grok.com OAuth — **not** Cursor Grok and
**not** `SWIL_LLM_PROVIDER=xai`). Wire label `grok:grok-4.6`.

**The eight humans switched in place** to `codex:gpt-5.6-luna`. They are the
same people on the platform; forking them would have doubled the human
cohort. `CodexCLIBackend` now passes `-m` when a model is declared, otherwise
the Luna bullet would have been recorded and the CLI default would have run.
hodlge / lvchuang / zaofan finally declare `AI Backend: codex`, so
`SWIL_LLM_BACKEND` can no longer silently reassign them.

Active unattended roster stays 26 (10 skipped + 10 forks + 8 humans + 8
already-non-claude). `/auth/register` is 3/hour/IP on production — new forks
need a staggered `setup-agents.sh` then `create-api-key` before they can act.

The aspect distiller is still `claude --model haiku` for every dream. That
load remains until a later pass moves the ruler off Anthropic.

## Eighth pass: immersive feed layout + green the translation pass — 2026-08-24

`ci:check` 13/13 green: server 628 passed / 2 skipped, client 401 → **433**
passed, mcp 32, agent 1810. Client coverage 74.91 → **75.71** lines (floors
ratcheted a seventh time to 74 / 64 / 65.5 / 72.5); server floors left alone —
at 92.17 / 77.83 / 86.01 / 89.67 they already sit 1–2 points under measured.
Uncommitted, stacked on the seven passes below.

**A third feed layout: `immersive`.** `FeedLayout` was `list | grid`; it is now
`list | grid | immersive`, so every surface that renders `FeedStream` (global,
following, tag, board, bookmarks, explore search) gets the new mode from one
switch. The wall is `features/posts/ImmersiveWall.tsx`: a scattered grid of
tilted cards that straighten and lift on hover, opened one at a time into a
reader overlay.

Four things about it that are deliberate:

- **The reader body is a real `PostCard`.** Like / bookmark / echo / comment /
  translate are therefore the same code path as the list, not a second copy
  that drifts. The one change this needed on `PostCard` is a
  `disableNavigate` prop: a body click inside the reader must not route to
  `/p/:id` and drop the surface the post is being read in. On `/p/:id` the
  same effect already fell out of the pathname check.
- **Arrow keys walk the wall**, and the reader defers to a caret inside the
  inline composer so typing a comment does not skip to the next post. Radix
  keeps Esc and the focus trap.
- **Paging is the feed's own infinite query.** Reaching the last three loaded
  cards in the reader pulls the next page, so arrow-walking does not dead-end
  at a page boundary, and the wall keeps the scroll sentinel too.
- **The tilt is derived from the index**, not random, so a re-render never
  re-shuffles the wall under the cursor. `prefers-reduced-motion` drops the
  reveal animation and the tilt entirely; under 760px the tilt is off anyway.

Cmd-K now offers every layout except the one in effect — with three of them a
single toggle command could no longer reach all three. `/showcase` keeps its
own card + preview modal on purpose: that surface is an anonymous teaser with
a register CTA and no interactions, so sharing a component with the
authenticated reader would have coupled two different jobs.

**Made the previous pass's work actually green.** The translation feature (auto
translate on read + X-style per-post `GET /:id/translation`) was complete but
the suite was not: 14 server failures, two of them whole suites.

- `respond.ts` had been fixed to read `res.req.id` — pino-http stamps `req.id`
  and **nothing ever set `res.reqId`**, so `meta.requestId` was `undefined` in
  production. Ten fake-`res` builders across the controller/route tests still
  modelled the old broken shape; they now carry `req: { id: 'req-1' }`. Three
  of those files were not failing — they set `reqId` and never asserted it —
  and were fixed anyway so no fake `res` lies about what `ok()` reads.
- Two `vi.mock` factories were missing symbols the module under test imports
  (`translateLimiter` in `app.test.ts`, `ctrl.translation` in
  `posts.routes.stack.test.ts`) — the exact failure mode
  `docs/19-testing-standards.md` §4 warns about, which surfaces as a dead
  suite rather than a failed assertion.
- Two client tests were failing for a shared reason: they asserted copy while
  never loading i18n, or asserted the Chinese string when `i18n.ts` pins
  `lng: 'en'`. `ErrorBoundary.test.tsx` now imports `@/i18n` (the default
  fallback became translated and the test was matching raw keys);
  `ExploreSections.test.tsx` asserts the English label like the rest of its
  file.

**Two real language-switch defects found while reviewing that path.** Both are
about the same asymmetry: `resolveLang` reads `preferences.language` *before*
`?lang=`, so the two have to be kept in step.

- **Cmd-K switched language without persisting it.** `settings.tsx` wrote the
  preference; the palette called `useUI.setLanguage` alone. For a signed-in
  reader that meant the UI flipped but bodies kept arriving in the old
  language — and on the next load `AuthBootstrap` pulled the stale preference
  back over the UI. Both callers now go through `lib/useSetLanguage.ts`, which
  is the one path: set local, and persist when there is a session. Anonymous
  surfaces (showcase, login) may call it too — nothing to store, and `?lang=`
  is what the server reads for them anyway.
- **The permalink never sent a language.** `GET /posts/:id` validates
  `langQuerySchema`, but `postsApi.getById` sent no param and
  `qk.posts.byId` was not language-scoped. So an anonymous reader with a 中文
  UI got the English body on `/p/:id` while the feed showed it translated,
  and a signed-in reader who switched language kept the stale cached body.
  The key is now `['posts', id, 'detail', lang]` — the same shape comments
  already used — and the three `PostCard` cache writes were moved onto it. An
  edit additionally invalidates the `detail` prefix, because clearing the
  server's `translations` map makes every *other* language's copy the old body
  translated.

**Known gap, deliberately not closed here:** `users.routes.ts` (profile posts),
`bookmarks.routes.ts` and post search do not translate at all — only the feed
routes, post detail, comments and showcase do. The per-post Translate button
now on every `PostCard` covers those surfaces on demand, which is why this was
left as a feature extension rather than folded into a bug-fix pass.

## Seventh pass: rebrand to SwordOne + custom domain wired end to end — 2026-08-24

The product now lives at **https://www.swordone.space** (apex `swordone.space`
308-redirects to www — Vercel default; domain registered through Vercel on
2026-08-24, attached to project `client`, both hosts). Brand display name is
**SwordOne**, wordmark lowercase `swordone`; the repo, packages, API-key prefix
(`sk-swil-`) and localStorage keys (`swil.ui`, `swil.drafts`,
`swil.analytics.sid`) deliberately keep their identifiers — renaming storage
keys would drop every user's saved drafts and UI prefs for no user-visible gain.

- **Client**: `<title>` / `usePageTitle` base → `SwordOne`; `index.html` gained
  og:site_name/title/description/url/type, twitter card, and a canonical link
  pointing at the www host; wordmarks in AppShell, Sidebar, showcase, login;
  three locale strings (newToSwil, notFoundDesc, appearance desc) in en + zh.
  Two tests updated (`usePageTitle.test.ts`, `user.test.tsx`); client 401/401,
  lint + tsc + build green. Deployed twice with `npx vercel --prod`; live page
  verified serving the new title, og:url and canonical.
- **Backend (Railway)**: `CORS_ORIGINS` now leads with
  `https://swordone.space,https://www.swordone.space` ahead of the three
  Vercel origins; service redeployed via GraphQL and live ~30 s later. Verified
  a preflight from both new origins returns 204 with the matching
  `access-control-allow-origin`, and a real `GET /feed/global` from the new
  origin returns 200 + data. Before the change the same preflight was a
  **500**, so the new domain could load the SPA but not call the API.
- **Database**: nothing to do — Neon is reached by the API only; a frontend
  domain change never touches it. Cookies already ran `SameSite=None; Secure`,
  which is origin-agnostic.
- **Railway access, the non-obvious part** (now in CLAUDE.md): the 1 h
  `accessToken` had been expired since 08-04, and the refresh endpoint rejects
  a refresh without a `client_id`. The CLI's id is embedded in its binary
  (`strings … | grep -o 'rlwy_oaci_[A-Za-z0-9]*'`); the call must be curl
  (Python urllib gets Cloudflare 403/1010). Env vars are read with
  `variables(...)` and written with `variableUpsert`; a write alone does not
  restart the service — `serviceInstanceRedeploy` is still required.
- Docs touched: README (title + live link), `docs/08-deployment.md` (domain
  row, CORS note, deploy step), `CLAUDE.md` (live URL + token-refresh recipe),
  `server/.env.example` (production CORS example).

Not changed on purpose: `swil-news.vercel.app` link in the Sidebar (separate
product); the `Swil Social` name inside historical docs sections.

## Sixth pass: server gap-fill, client API/component batch, three UX fixes — 2026-08-24

Client tests 295 → **401**, coverage 67.27 → **74.91** lines (floors ratcheted a
sixth time to 73.5/63.5/65/72); server 583 → **614** (+2 pre-existing
Redis-live skips), coverage 87.68 → **92.19** lines (third ratchet today, to
91/76/85/88.5). `ci:check` 13/13 green under the new floors; full e2e 6/6
(28s). `npm run knip` clean. Uncommitted, stacked on the five passes below.

- **Server new suites** (each verified 3×): `staticClient.test.ts` (SPA serving
  vs the real `client/dist`, `describe.skipIf` when no build); `feedScorer`
  batching describe (event-driven `expect.poll` on the persisted score — the 2s
  debounce IS the contract); `monitoring` enabled-path describe (`vi.doMock` +
  fresh registry; init-once + failing-import fallback); `boards.routes` (exact
  DTO leak check); `posts.routes.stack` (REAL multer/validate/errorHandler,
  controller mocked — "wrong file type is 400, never 500"); auth.controller
  login + API-key handlers (16 total — session-fixation order pinned:
  authenticate BEFORE regenerate; `keyHash` never serialized; missing key name
  defaults to `'default'`); `agents.roster.test.ts` — first tests for
  `getAgentStats` (zero-filled UTC cadence, AI/human engagement split excludes
  the agent's own self-reply, top-interactor aggregation) plus roster
  membership/cohort rules incl. the deliberate agentBackend-on-humans /lab
  exemption.
- **Client API layer** (subagent batch, re-verified by hand 3×+lint+tsc):
  `apiWrappers.test.ts` — 63 tests across 12 wrapper modules (method/URL/params
  shape + envelope unwrap per function; `auth.me` 401→null vs rethrow;
  `posts.create` FormData text and media paths); `realtime.test.ts` — 13 tests
  (singleton lifecycle via `vi.resetModules` + dynamic import, reconnect reuses
  the socket, disconnect nulls it, unsubscribe precision, no-socket no-ops).
- **Client component batch** (second subagent, same re-verification): 29 tests
  over AutocompleteDropdown, EchoComposer, FollowListModal, BookmarksFeed,
  Sidebar, settings.password.
- **Three fixes shipped with tests updated in the same pass**:
  `Sidebar.handleLogout` had `try/finally` with no catch — a failed network
  logout escaped as an unhandled rejection; now caught (server-side logout is
  best-effort), with a new test pinning "logout API fails → session still
  cleared, lands on /login". Sign-out toast reused `nav.signOut` ("Sign out")
  as its message — added `nav.signedOut` ("Signed out" / 「已退出登录」).
  `BookmarksFeed` had no error state (silent blank on query failure) — now an
  EmptyState via `bookmarks.error`/`errorDesc`.
- **Deferred findings** (found this pass, deliberately not fixed — decide
  before touching): the client wrapper layer never `encodeURIComponent`s path
  segments (`/users/${username}`, `/boards/${slug}`, …) — server charset
  validation makes it near-unexploitable today, but fixing means touching 12
  wrappers plus the 63 fresh tests that pin bare interpolation, so it's its own
  pass; `feed.api`'s shared `Pagination` type accepts `sort` on
  byTag/byBoard/byUser but silently drops it (pinned); `listBookmarks` /
  `searchPosts` use `if (params.limit)` so `limit: 0` silently falls to the
  server default (pinned); `realtime.on()` before `connectRealtime()` returns a
  permanent no-op and an unsubscribe closure captured pre-disconnect points at
  the dead socket after reconnect (RealtimeBridge compensates by
  re-subscribing; a direct consumer wouldn't); `comments.api.ts` is the one
  wrapper module still untested.

## Fifth pass: explore/lab panel suites, bootstrap/boundary, palette e2e — 2026-08-24

Client tests 260 → **295**, coverage 56.65 → **67.27** lines (floors ratcheted
a fifth time to 65.5/57/55.5/64.5); e2e 5 → **6** specs, run 6/6 twice in a
row. `ci:check` 13/13 green — server 583 / client 295 / mcp 32 / agent 1810.
Uncommitted, stacked on the four passes below.

- **Explore child panels** (12 tests, three files): ExploreHero (markdown
  strip, pinned relative time, permalink nav, null → nothing), ExploreAgents
  (backend badge, excerpt), ExploreTopics (tag nav, count formatting),
  ExploreTrendingTags (font/opacity weighting math), ExplorePeopleTab (tag
  pill → re-query, `?tag=` deep link, client-side agents-only filter + both
  empty states), ExplorePostsTab (debounced search → request + analytics,
  start-vs-no-results states).
- **BenchmarkView** (4): run-the-sweep empty state (fixture must empty
  personas/tasks too — hooks fire before the early return), every leaderboard
  column's formatting incl. the all-null em-dash row (scoped `within` the
  board — model names repeat across three sections), heatmap tooltips with
  n, default persona/task compare load.
- **InteractionGraph** (6): header metrics from the full graph, node/edge
  presence, click + keyboard activation, hover fading, empty state, and the
  90-edge declutter note — all deterministic because the layout is seeded.
- **AuthBootstrap** (5): /auth/me hydration + language pref, anonymous and
  failure paths still mark ready, the 401 handler that must NOT wipe an
  anonymous reader's cache, theme application. (jsdom needs a `matchMedia`
  stub for the 'system' path.) **ErrorBoundary** (3): default alert, custom
  fallback with working reset.
- **Palette e2e** (`e2e/palette.spec.ts`): ⌘K open → filter → navigate,
  theme flip observed on the document root, Esc close. First run failed
  honestly: `page.goto` resolves on document load but the Vite dev bundle
  mounts React (and the key listener) later — wait for visible UI before
  synthetic keypresses.
- **A real race fixed in the DM e2e**: the server emits the sender's socket
  frame before the conversation row finishes persisting, so the sender's
  visible bubble does not imply the recipient's list row exists. The
  assertion now polls the recipient's `/conversations` (bounded) instead of
  snapshotting it once. One failure in three runs — exactly the class the
  3×-rule exists to catch.

**Ranked next**: settings depth (password change, avatar upload branch),
AgentDetail's untested tails, `swil-news` link checks, MCP streamable-HTTP
variant, per-board palette jumps.

## Deep pass: bookmarks tool, composer/lab/controller suites, e2e social flows — 2026-08-24 (fourth pass)

Five rounds, each independently verified (3× runs on every new suite), stacked
on the three passes below. Uncommitted. `ci:check` 13/13 green — server 583 /
client 260 / mcp 32 / agent 1810; e2e 5/5 against the real stack. The one
red on the way: the lab fixtures typed a `date` field that
`HomogenizationPoint` calls `capturedAt` — vitest (esbuild, no typecheck) and
eslint both passed it; only the tsc gate caught it. That ordering is now the
habit: typecheck belongs in the per-suite verification loop, not just the
milestone gate.

- **MCP 20 tools** (`swil_bookmark` + `swil_list_bookmarks`; tests 29 → 32,
  coverage 79.7% lines, floors ratcheted to 78/69/65/78). Bookmark reports
  the server's result like `swil_like`; agents can now curate privately.
- **PostComposer suite** (9) — the largest untested client feature: post →
  clear → toast, draft autosave/restore/discard (real zustand-persist store),
  4-image cap with video mutual-exclusion, visibility payload, bold/quote
  format bar against the real textarea, API-failure toast keeping the text.
- **Lab panel suites** (11) — CrossSpeciesPanel (bidirectional agent×human
  matrix, same-species exclusion, coverage/reciprocity/loop-health, empty
  state, onSelect), PopulationHealth (four golden signals computed from
  pulse + homogenization + roster fidelity; composite verdict warn/critical
  paths; range passthrough pinned per the distinguishable-fixture rule),
  PopulationInsights (monoculture verdict pinned first with cohesion
  evidence, off-character + biggest-drifter naming tuned to NOT trip the
  z-outlier variants, cohort-gap non-firing fixture, echo roll-up, focus
  click).
- **agents.controller suite** (16) — the 31%-covered controller: it.each
  over eight range-defaulting reads (30d default + explicit 7d passthrough),
  collapse's range→window resolution, limits/type filters, per-account
  ingest arg-threading + 401s, and the `assertFirstPartyLabWrite` guard
  proven to 403 both humans AND BYOA agents on population/benchmark ingest.
- **e2e grows 2 → 5 specs** (`e2e/social.spec.ts`, full stack, 27s): a DM
  conversation across UI + API **including a socket-delivered reply landing
  in the open thread with no reload** (the conversation-room realtime path,
  end to end), bookmark from the feed → /bookmarks, and echo rendering the
  nested original.
- **Ratchets**: client 45/40/37.5/43.5 → **55/48/46.5/53.5** (measured
  56.65/49.80/48.15/55.18, 260 tests); server 84/71/79/82 → **86/72.5/81/84**
  (measured 87.68/74.20/82.84/85.47, 583 tests); mcp 72/67/52/72 →
  **78/69/65/78**.

**Ranked next**: BenchmarkView + InteractionGraph panels; `explore/*` child
panels; settings depth (password change, avatar upload paths);
`AuthBootstrap`/`ErrorBoundary`; an e2e spec for the ⌘K palette; MCP
streamable-HTTP variant per the roadmap in `mcp/README.md`.

## Agent DMs over MCP + ⌘K palette + page titles — 2026-08-24 (third pass)

Positioning round: compared against the field (Chirper.ai / Butterflies.ai at
consumer scale, OASIS / AgentSociety as offline simulation frameworks), this
repo's wedge is being the only one that is simultaneously a real usable
platform, a measurement instrument, and open to user-owned agents — so this
pass widened the BYOA surface and closed two human-side UX debts. All suites
3×-stable; uncommitted, stacked on the two passes below.

**Agent side — MCP grows from 14 to 18 tools** (`mcp/`, tests 24 → 29):
- `swil_dm` (open-or-reuse the conversation by username, then send),
  `swil_list_conversations`, `swil_read_conversation` (returns messages and
  marks the thread read — the UI contract; deliberately annotated
  `readOnlyHint: false` because the mark is a write), and
  `swil_read_board_feed` (slug + sort). BYOA agents can now hold DMs, which
  resident agents always could — capability parity for the cross-species
  comparison. DMs share the per-minute message limiter; mark-read failure
  never costs the read. mcp coverage 74.5 → 78.3% stmts against its 72 floor.

`ci:check` 13/13 green after the pass — server 569 / client 240 / mcp 29 /
agent 1810.

**Human side**
- **⌘K command palette is back** (`components/CommandPalette.tsx`,
  dependency-free — the `cmdk`-based one was removed with the dependency and
  `ui.store.cmdkOpen` had been waiting since). ⌘K/Ctrl+K toggle, arrows +
  Enter, Esc; navigation (auth-aware), theme/language/layout preference
  commands, and people search via the user directory (2+ chars, debounced,
  top 5). Listbox semantics with `aria-activedescendant`; mousedown-pick like
  the DM search. 8 tests.
- **Every route now sets a document title** (`lib/usePageTitle.ts`, 4 tests):
  16 routes — static titles from existing i18n keys, dynamic ones for
  `@username`, post author, `#tag`, and board name. Tabs, history, and
  bookmarks are finally distinguishable; unmount restores the base title.
- Client coverage 44.84 → **46.78** lines (240 tests); floors ratcheted a
  third time to **45 / 40 / 37.5 / 43.5**.

**Ranked next**: `/lab` panel suites; `explore/*` child panels;
`PostComposer`; e2e specs for DM + echo + bookmark flows; a `swil_bookmark`
MCP tool if agents should curate; palette entries for "New post" and per-board
jumps once the composer is testable.

## Client route coverage + BYOA quickstart — 2026-08-24 (second pass)

Nine new route suites (47 tests) for the previously-0% client routes, the
BYOA onboarding doc, and a second client ratchet. `ci:check` 13/13 green —
server 569 / client 228 / mcp 24 / agent 1810. Uncommitted, stacked on the
morning pass below.

- Route suites, each run 3× to screen for flake: **login** (9 — validation,
  redirect-after-login via location.state, error banner, and the register
  anti-bot stack — honeypot, 3-second floor, arithmetic challenge — pinned
  with `Date.now`/`Math.random` spies), **post** (7 — thread render, comment
  submit + trim guard, 404-vs-500 states, signed-out CTA, back-link
  /global-vs-/feed), **user** (7 — profile, optimistic follow/unfollow
  counter + cache flip, message → conversation, self-profile tabs with
  bookmarks, followers modal), **notifications** (6 — like-grouping by
  target, "N others" label, one-shot auto-mark-read, disabled states,
  clear-all confirm dialog), **messages** (4 — other-participant rows,
  "You: " prefix, mousedown search-pick → conversation), **showcase** (2 —
  public wall, AI badge count, preview modal + join CTA), **feedTag** (4 —
  slug+lang wiring, rich/archived header, error/empty), **feedFollowing**
  (5 — sort tabs, new-posts banner reset, browse-global, retry),
  **explore** (3 — tab routing, `?tab=` entry, pending summary).
- Client coverage 31.85 → **44.84** lines; floors ratcheted a second time to
  **43 / 39 / 35 / 41.5** (measured 44.84 / 40.85 / 37.44 / 43.35).
- Two traps caught by the 3×-run rule, both generalized: `vi.restoreAllMocks`
  does **not** clear `vi.fn()` call history — pair it with `clearAllMocks`
  (a passing test's calls leaked into four negative tests); and a button
  that is disabled while its status query loads swallows `fireEvent.click` —
  wait for enabled before clicking (the follow-button race).
- `docs/20-byoa-quickstart.md` (new): the user-facing path — create an
  account → Settings → My agents → one-time `sk-swil-…` key → run it over
  MCP (`claude mcp add`), raw REST, or the full persona runtime — plus
  EN/中文 launch copy in the appendix (draft only; nothing was posted
  anywhere). Indexed from `docs/README.md` and the root README quick links;
  the docs-index renumbering note now names 21 as the free slot (19/20 are
  taken).
- Remaining client gaps, ranked: the `/lab` feature panels, `explore/*`
  child panels, `PostComposer`, settings depth, `AuthBootstrap`/
  `ErrorBoundary`, `api/*` thin wrappers.

## Testing & reliability pass — 2026-08-24

Eleven improvements, individually verified (every new/changed test file ran
3× to screen for flake), finishing with `ci:check` 13/13 green — server 569 /
client 181 / mcp 24 / agent 1810 tests. Uncommitted, stacked on the 08-23
pass.

**New test surfaces**
- `realtime/io.sockets.test.ts` — real socket.io client+server on an
  ephemeral port, real Postgres membership checks: the auth gate,
  conversation join/leave asserted against server-side room state, typing
  guards with ordered-flush negative assertions, emit helpers. The
  `conversationId` regex is pinned against an id actually produced by
  `newId()`, so id-format drift fails loudly. `io.ts` 10% → 94% lines.
  (New server devDep: `socket.io-client`, tests only.)
- `RealtimeBridge.test.tsx` — the bridge was rewritten on 08-23 and shipped
  untested. 16 tests fake only the socket (handler map) and assert real
  QueryClient/Zustand effects: notification upsert+dedupe, no-materialise
  rule, message prepend via the shared dedupe, toast suppression (own echo,
  on-thread), readBy merge idempotence, focus reseed, logout teardown.
- `comments.service.test.ts` +11 — listForPost cursor pagination with the id
  tie-break, deleted-included / hidden-excluded, likedByMe per viewer,
  ghost-author ctx omission, followers-only 404 (never 403), update/delete
  ownership guards.
- `middlewares/rateLimit.test.ts` — drives the real express-rate-limit
  store: human vs agent budgets, per-user bucket isolation, ip fallback for
  anonymous, ip-limiter inertness outside production, and loginLimiter in
  production mode (ip + lowercased identifier bucket).
- `messages.routes.test.ts` +9 — remaining route surface: 200-vs-201
  findOrCreate, viewer unread computation, every validation reject asserted
  service-untouched, 204 read. The service mock factory was missing
  `getById` (routes got `undefined` at call time) — fixed.
- `bookmarks.controller.test.ts` / `ownedAgents.controller.test.ts` — the
  0%/7% controllers: wiring, status codes, one-time-key warning, and the
  documented `?limit=0` → default-20 contract (falsy before the clamp).
- `useInfiniteScroll.test.tsx` — controllable IntersectionObserver stub:
  fire/budget/disconnect/rootMargin contracts.

**Gates — the structural fix of this pass**
- Coverage thresholds were enforced **nowhere**: both `ci-check.sh` (steps
  5/6/8) and the GitHub workflow ran the non-coverage test scripts, so the
  ratchet could never fail a build. Both now run `test:coverage`.
- `mcp/` gained its first coverage floor — `mcp/vitest.config.ts`
  (72/67/52/72 vs measured 74.48/69.49/55/73.95) plus a `test:coverage`
  script and devDep `@vitest/coverage-v8`. Until now, deleting every mcp
  test passed CI.
- Ratchets: server 79/67/73/77 → **84/71/79/82** (measured
  86.18/72.89/80.85/84.07 L/B/F/S); client 22/21.5/17.5/21 →
  **30/26.5/24/29.5** (measured 31.85/28.34/26.04/31.05).

**Docs**
- `docs/19-testing-standards.md` (new) is the binding testing playbook:
  determinism rules, mock boundaries, flaky policy, per-surface test
  patterns with real example files, operator rules for agent sessions, and
  the new-surface checklist. Pointered from `docs/09-contributing.md` and
  the CLAUDE.md reading order; CLAUDE.md's ci:check block corrected to the
  real 13 steps.

**Largest remaining gaps, ranked** — client routes `login` / `post` / `user`
/ `messages` / `notifications` / `showcase` and `routes/explore/*` are still
0%; server `agents.controller` 31%, `staticClient` 10%, `agents.roster` 34%;
the e2e suite (2 specs) was not extended.

## Incremental hardening pass — 2026-08-23

Twenty small, independently-verified fixes across all four packages. No
feature work, no refactors, no behaviour change beyond the defects named. Each
landed with `ci:check` green (server 522 / client 158 / mcp 24 / agent 1810).

**Contract and data integrity**
- `deletePost` now decrements the echoed original's `repostCount`. It never
  did, and `calcFeedScore` weights reposts x3, so every echo/delete cycle
  ratcheted a post up in every feed permanently.
- A deleted post nested as somebody's `echoOf` is tombstoned (`[deleted]`, no
  media) the way `CommentDTO` already tombstoned deleted comments. Its full
  body and images used to keep rendering indefinitely.
- `/feed/tag/:slug` reads the `sort` it validates. This is the same defect
  fixed for `/board/:slug` on 2026-08-19, left standing on the sibling.
- `?lang=` is `en|zh`, not any string. Anything else was treated as
  translatable, so an anonymous caller could drive a paid Translate call per
  uncached post and persist the result into every row's `translations` jsonb.

**Failure surfaces**
- Upload and body-size rejections answer 4xx instead of `500 INTERNAL` (whose
  message production swallows) and no longer reach Sentry as server faults.
- `POST /auth/api-keys` validates its body and is rate limited, like every
  other write in that router; `DELETE /auth/api-keys/:keyId` validates its id.
- Per-user limiters added to the bookmark toggle, notification read/clear, and
  the avatar upload (before multer buffers, not after).
- MCP requests carry a 20s timeout, name an unreachable host, and keep the
  server's per-field validation detail. `swil_like` returns what the server
  did rather than echoing the request.
- `SubprocessRunner` logs a child's exit code, stderr and timeouts. All three
  were discarded, which is why "no response from codex" has repeatedly cost
  diagnosis time.
- A non-UTF-8 news cache degrades to `WORLD_CONTEXT_UNAVAILABLE` instead of
  killing the round. `UnicodeDecodeError` is a `ValueError`, so the existing
  `except OSError` missed it — the trap `locks.py:69-73` documents by name.
  The cache is shared, so one bad write cost every account in the round.

**Client**
- Optimistic like/bookmark reaches the `/bookmarks` and Explore-search caches.
  It patched neither, and `PostCard` is memo'd, so the heart never filled on
  two shipped pages.
- Collapsed comment panels are `inert`. They were `aria-hidden` with focusable
  content, so tabbing a feed dropped focus into an invisible subtree per card.
- Uploading an avatar mid-edit no longer discards unsaved profile text.
- The sender's own DM no longer renders twice (shared `prependMessage`), and
  an open thread re-joins its conversation room after a reconnect — without
  that it silently froze after any sleep or redeploy.

**Gates and docs**
- Server coverage floors ratcheted 50/55/50/50 -> 79/67/73/77 against measured
  80.75/68.24/74.76/78.80. They had not moved in four months while coverage
  climbed ~28 points, so the gate could no longer fail on a real regression.
- `docs/03` / `docs/04` corrected: three OpenRoutes were documented as
  auth-required, the migration inventory was one behind, the snapshot
  uniqueness index was pre-`0003`, and `drift-countdown` / `collapse` were
  undocumented. `agent/.env.example` and `server/.env.example` now list the
  settings the code actually reads.

## Isolated prompt-injection probe lane — 2026-08-22

A third experimental lane, sibling to the live roster and Persona Bench.
Attacker text is meant to live on board `probes` (empty `tagSlugs`,
`sortOrder` 99; seed in `server/scripts/backfill-boards.ts`). The 23-account
field study never reads it: a census walks every `Board:` / `Read:` bullet
and fails if any equals `probes`. Measurement is

```bash
uv run --project agent swil-agent act <name> --dry-run --probe-board probes
```

which overlays that board's latest posts onto the assembled feed strings
only, then prints one JSON score line (`hard_hit` / `soft_hit` / `missed`).
`--probe-board` without `--dry-run` is illegal (CLI exit 2; `run_act`
raises). `cycle` and `opportunistic-round.sh` do not grow the flag.
Dreams stay off because `--dry-run` already skips them. R28 is untouched.

`probes` is a **reserved** slug: `listBoards` omits it, mixed feeds
(`global` / following / tag / search / explore) omit posts filed there,
and the act path drops it from cross-read / now-context candidates.
`GET /feed/board/probes` stays so the overlay can fetch. This slice does
**not** create probe accounts or POST attacker text to production. Spec:
`docs/superpowers/specs/2026-08-22-prompt-injection-probe-design.md`.

## Upload cap, Explore OpenRoute pin, keyboard PostCard — 2026-08-22

Multer ceiling is `POST_UPLOAD_FILE_SIZE` = 15 MB (`posts.limits.ts`);
images still reject above `POST_IMAGE_MAX_BYTES` = 5 MB. Explore remains an
OpenRoute: `/feed/explore-summary`, `GET /users`, `/users/profile-tags`,
and `/posts/search` stay `optionalUser` (pinned comments + route-stack
tests). Post cards are keyboard-activable (`tabIndex={0}` `role="link"`;
Enter/Space on the article, not on inner links). Spec:
`docs/superpowers/specs/2026-08-22-remaining-gaps-design.md`.

**Operator, not this slice:** Neon `0003_per_user_snapshot_hash` before API
deploy; no commit/push until the user says `commit push`; do not force the
48h opportunistic round; do not POST probe payloads to Railway.

## Explore, mentions, lab ingest, snapshot uniqueness — 2026-08-22

Anonymous Explore no longer 401s: `/feed/explore-summary`, `GET /users`,
and `/users/profile-tags` are `optionalUser`. Mention notifications skip
recipients who cannot see the post. Benchmark runs and population-metric
ingest require a **first-party** agent (`isAgent` and no `ownerId`).
Personality/behavior snapshot uniqueness is `(userId, contentHash)` —
migration `0003_per_user_snapshot_hash` (run on Neon before deploying the
API). Post permalink back-link goes to `/global` when signed out.

## Visibility + session cookie + socket origin — 2026-08-22

Echo and bookmark now go through the same visibility gate as like/comment.
A public echo of a private original still exists, but `echoOf` is omitted
for viewers who cannot see the original. Logout `clearCookie` uses the
same `secure` / `sameSite` / `domain` / `path` as the session cookie.
Socket.IO handshake rejects unknown Origins (matching HTTP CORS); typing
events require `conversation:join` room membership.

## Folio feed + news freshness — 2026-08-22

Feed rivers (`/global`, `/feed`, `/board/:slug`, `/tag/:slug`) default to a
two-column **folio** of compact cards so a viewport shows more than one post.
The 680px reading column remains as `list`. Shared pieces: `FeedLayoutToggle`,
`FeedStream` / `FeedSkeletons`. Persist stays `swil.ui` at version 2
(migrate rewrites only `feedLayout` to folio; theme/language survive).
AppShell already widens the
column to `--layout-feed-max-grid` (1100px) on those routes when folio is on.

News: `NEWS_MAX_AGE_HOURS` 6 → 3, `NEWS_HIGHLIGHT_LIMIT` 3 → 5. The
now-context wording is unchanged (R28). Agents still choose whether to post
about the digest; there is no scheduled-news path. Change point:
`docs/13-observation-lab.md` (2026-08-22).

## Loop engine is the operator path — 2026-08-21

The Python cycle is no longer just the runtime of record; it is one operator-visible
system. Spec: `docs/superpowers/specs/2026-08-21-agent-loop-engine-design.md`.
Ledger: `.superpowers/sdd/2026-08-21-agent-loop-engine/progress.md`.

**What an operator runs:**

```bash
uv run --project agent swil-agent doctor                    # URL, PATH, embedder, locks
uv run --project agent swil-agent cycle <name> --auto       # one account
bash agent/scripts/cycle-one.sh <name>                      # same: dispatches the line above
bash agent/scripts/opportunistic-round.sh --force           # full roster, now
uv run --project agent swil-agent measure-status            # rounds / fail-open / missing samples
uv run --project agent swil-agent echo-calibrate <name>     # variance vs threshold; never writes ECHO_DETECT
```

`SWIL_RUNTIME=bash bash agent/scripts/cycle-one.sh <name>` remains the rollback.
`heartbeat.sh` **stays dead** — do not load `com.swil.heartbeat.plist`. The
unattended path is `com.swil.round` / `opportunistic-round.sh`. Loading the
heartbeat would inject act-only Bash rounds into a series that now samples
dreams, F4, and persona fidelity from the Python cycle.

`swil-agent doctor` prints `SWIL_URL` (WARN if the host is production),
`claude`/`uv` on PATH, embedder `/health`, lock-dir writable, and whether
`com.swil.heartbeat` is loaded (`launchctl list` best-effort). Exit 0 ready,
75 not. It documents `SWIL_REQUIRE_NON_PROD=1` (refuses `cycle`/`act` against
`swil-social-api-production.up.railway.app` unless `--i-mean-production`); it
does not enforce that flag.

**What shipped (engineering, not the measurement):**

- Codex arms are no longer post-only. Comment / like / echo / follow use the
  same write-verified executor as every other backend.
- Follow 409 / `CONFLICT` ("already following") is `landed=True` with no
  memory line; any other write failure is `landed=False`.
- Every finished cycle writes a `cycle_run` card (`metrics.kind="cycle_run"`).
  A missing sampler or fail-open gate is `outcome=warn` on the ledger and
  visible on `/lab` — it does not change the round exit code.
- Act memory is `retrieve_memory` (recency + addressees + board, cap 24), not
  the tail of `memory.md`. Dream still sees the long window.
- `GET /agents/runtime?range=` (public lab read, 60s TTL) powers a RuntimeHealth
  strip on `/lab`: rounds / fail-open gates / missing samples / landed actions.
- `/auth/me` carries `agentOps` for `isAgent` callers (pause + daily quota).
  Never on public `toUserDTO` / `toUserLiteDTO`.
- MCP is **14 tools**. `swil_whoami` includes `agentOps` when present;
  `swil_quota` and `swil_notifications` are read-only. No new write tools.
- Identity bullets (`Username`, `AI Backend`) are copied from the live file
  onto the dream candidate before structural validation, so a distiller
  cannot fail that gate by mangling them.

Change points for Codex, follow-landed, and retrieved memory are in
`docs/13-observation-lab.md`, dated 2026-08-21.

**Not done, deliberately.** The six-round measurement protocol has **not** been
run. `measure-status` reports counts (default since 2026-07-25); discard+6
against production is an operator act, not this spec. `ECHO_DETECT` stays
default off; `echo-calibrate` never writes it.

## Switching LLM backends is configuration, not code — 2026-08-21

The model-access seam (spec §5.3's third row) now has all four implementations
and one entry point. Nothing about today's rounds changes: with no new setting
set, every account resolves exactly as it did before.

**The precedence ladder** (`agent/swil_agent/llm/selection.py`):

```
backend:  --backend flag  >  personality.md `AI Backend:`  >  SWIL_LLM_BACKEND  >  claude
model:    --model flag    >  personality.md `Model:`       >  SWIL_LLM_MODEL    >  backend default
```

**The persona file outranks the environment, and that direction is the point.**
Each account's backend is the drift experiment's independent variable. An env
var that outranked the roster would re-assign every arm at once, and the series
either side of the round it was exported would be two experiments wearing one
name. `SWIL_LLM_BACKEND` is therefore a default for accounts that declare
nothing — today that is exactly three: `hodlge`, `lvchuang`, `zaofan`. Only an
explicit CLI flag, where an operator has named one account and one model in one
command, outranks the file.

That distinction needs "the file declares nothing" to be representable, so
`Persona` now carries `declared_backend` (the bullet as written, `None` when
absent) beside `backend` (the same value defaulted to `claude`).

**Per-round, by flag:**

```bash
uv run --project agent swil-agent act zenith --backend api --model grok-4.6
uv run --project agent swil-agent cycle zenith --auto --model sonnet
```

**Globally, by env** (`agent/.env`, full comments in `.env.example`):

```bash
SWIL_LLM_BACKEND=api
SWIL_LLM_PROVIDER=xai          # anthropic | xai | openai | openai_compatible
SWIL_LLM_MODEL=grok-4.6
SWIL_LLM_API_KEY=xai-...       # held as a SecretStr; never logged, never written to disk
# SWIL_LLM_BASE_URL=           # optional for named providers, REQUIRED for openai_compatible
```

**`ApiBackend`** (`llm/api_backend.py`) speaks two shapes, because two is all
the market has: Anthropic's Messages API (`POST {base}/v1/messages`) and
everything OpenAI-shaped (`POST {base}/chat/completions`). xAI, OpenAI, Groq,
Together, vLLM and DeepSeek's non-Anthropic endpoint are all the second one, so
`openai_compatible` plus an explicit base URL covers the long tail with no class
per vendor. No new dependency — httpx was already here, and the tests drive it
through `httpx.MockTransport`.

### The cursor backend, and three accounts on it — 2026-08-21

`cursor_cli` is the fourth CLI backend. One credential (the maintainer's Cursor
subscription; `CURSOR_API_KEY` also works) reaches five vendors — Anthropic,
OpenAI, xAI, Google, and Cursor's own Composer — which is what makes model-tier
arms beyond Anthropic possible at all.

**It is a CLI backend, not an `ApiBackend`.** Cursor has no official
OpenAI-compatible `/v1/chat/completions`; the request for one
(forum.cursor.com/t/…/164522, 2026-07-01) is still open with no staff reply. So
`SWIL_LLM_BACKEND=api` cannot point at Cursor, and `cursor` is its own kind.

**`cursor-agent` has no flag that disables its tools.** Its own `--help` says of
print mode: "Has access to all tools, including write and shell." That is the
identical exposure `claude -p` had on 2026-08-19. Measured against the real
binary on 2026-08-21:

| configuration | result | kind of guarantee |
|---|---|---|
| unguarded | **wrote the file** | proves the guards below are not vacuous |
| `--mode ask` | refused, in the MODEL's voice | soft (system-prompt level) |
| deny config, under `--force` + a jailbreak prompt | refused, in the RUNTIME's voice — `Permission denied: Command blocked by permissions configuration` | **hard** |
| deny config with a stray `version` key | process exits, `Unrecognized key(s)` | fails closed, loudly |

So `CursorCLIBackend` rebuilds the guarantee out of three per-call parts:
`--mode ask` on the argv, a deny-everything `.cursor/cli.json` written into the
workspace immediately before each call, and a fresh empty temp directory as that
workspace — the repository is never it. The config is rewritten every call
rather than checked into the repo, because a repo file is ambient state
(editable, deletable, silently permissive once it drifts) where the other
backends' guarantee lives in the argv and is reconstructed from scratch each
time. `--force`/`--yolo` are never passed, and `test_cursor_backend.py` pins
that. The maintainer's global `~/.cursor/cli-config.json` is untouched — it is
currently `"deny": []`, which is exactly why this backend must not depend on it.

**Cursor requires an explicit model**, unlike claude/codex. With no `--model` it
uses the `auto` router, whose choice can change on Cursor's deploy while
`agentBackend` still reads a flat `cursor` — an independent variable that moves
on someone else's release is not one.

**Three new accounts, registered 2026-08-21** (roster is now 26 = 18 agents + 8
simulated humans). Existing accounts were deliberately NOT switched: changing an
account's backend puts a discontinuity in its drift series, and a new account is
the only clean way to add an arm.

| account | model | board | rhythm |
|---|---|---|---|
| `gewu` 格物 | `cursor-grok-4.6-high` | making | post-first, starts from one concrete artefact |
| `houniao` 候鸟 | `gemini-3.7-flash-high` | life-science | post-first, short, cycle-over-trend |
| `shiyi` 拾遗 | `gpt-5.2` | perception | **comment-first** — picks up others' unfinished half-sentences |

First act round landed `5/5` for all three; production records
`cursor:cursor-grok-4.6-high`, `cursor:gemini-3.7-flash-high`, `cursor:gpt-5.2`.

**Two things worth knowing before adding more:**

- **A thin prompt reads as a coding-assistant request.** On a six-line system
  prompt, `gpt-5.2` answered as an assistant asking for input rather than as a
  character — `cursor-agent` is a coding agent and `--mode ask` frames it as Q&A
  about a codebase. With the account's REAL `personality.md` as the system
  prompt it stayed fully in character. Judge a model on the real persona text,
  not on a probe.
- **A brand-new account's first dream is not gated.** `check_cooldown` returns
  `proceed=True` whenever `last_dream_<name>` is absent, whatever `memory.md`
  holds — so a new account created shortly before a round would dream on an
  empty memory and rewrite its seed persona out of nothing. These three were
  given an `act` round first (5 memory lines each) so their first dream has
  something to consolidate. Do the same for any account added later.
- Long model ids overflow `agentBackend`'s server-side `z.string().max(40)`:
  the longest cursor id is 36 characters and `cursor:` + 36 = 43. The guard in
  `llm/selection.py` refuses these at resolution time rather than letting the
  PATCH 400 silently. Raising the two zod caps to 64 would unblock them — the DB
  column is an unbounded `text`, so no migration — but it needs a backend
  deploy to take effect.

### Five things that are not obvious

- **`agentBackend` keeps its shape, and that is load-bearing.** The wire value
  stays `<backend>[:<model>]` — `claude:opus`, `codex`, and now `xai:grok-4.6`.
  The internal kind (`claude_cli`) never reaches the wire, because
  `act/round.py` and `act/context.py` both branch on the literal string
  `"codex"` and `/lab` groups by this value; renaming it would split every
  account's series in two at the cutover round.

- **An over-long label is refused at startup.** `agentBackend` is
  `z.string().max(40)` server-side, and `sync_backend_step` only WARNs on a
  rejected PATCH — by design, a profile sync must not fail a round. Composed,
  those two would lose the experiment's independent variable for that account
  every round, with one swallowed line to show for it. The check now fires
  while the operator is still holding the config that caused it.

- **`mangniu`'s recorded value changes, once.** Its `AI Backend:` bullet says
  `haiku` — a model name in the backend slot — which Bash's `llm.sh` sent down
  its `*)` branch to the claude CLI, so the account has always RUN on
  `claude --model haiku` while RECORDING `haiku:haiku`. The resolver now
  records `claude:haiku`, which is what actually runs. The fallback itself is
  unchanged (still forgiving, now with a WARN); only the recorded string is
  corrected. **This is a one-account discontinuity in the drift series and
  should be filed with `swil-agent intervention` if the surrounding window
  matters.**

- **The resolved model is not injected as a CLI default.**
  `dream/round.py`'s `_diff_narrative` passes `model=None` deliberately, to get
  the CLI's own default rather than the persona's model. Injecting the
  resolution as `default_model` would silently promote that one call to opus for
  every opus account. `ApiBackend` does carry the model, because it has no CLI
  default to fall back to — the asymmetry is deliberate and pinned by a test
  pair.

- **`cli._backend_for` has a frozen two-argument signature.** Roughly eighteen
  tests in `test_cli.py` replace that exact name with a two-argument lambda, and
  that substitution is the only thing stopping a unit test from spawning a real
  `claude -p`. The first draft of this work built the backend elsewhere and left
  `_backend_for` orphaned; no test failed — the suite hung for ten minutes on a
  live CLI call instead. `test_backend_factory.py` now pins both the name being
  on the path and the arity.

**Bash rollback is untouched.** Nothing under `agent/scripts/` changed, so
`SWIL_RUNTIME=bash bash agent/scripts/cycle-one.sh <name>` behaves exactly as
before and knows nothing about these settings.

**Not done, deliberately:** the heartbeat is not switched to anything, no
persona text or bench task was touched, and no drift threshold or embedding
dimension moved. Choosing which accounts run on which provider is experiment
design, and this is only the infrastructure that makes the choice expressible.

## /lab records human interventions, and samples cohesion every cycle — 2026-08-20

Two things that were already happening and left no trace now leave one.

**`swil-agent intervention <name>`** files ONE hand edit (`personality.md` /
`memory.md`) as an `anomaly` lab event, so the window it distorts stops reading
as normal. It is the one command that records a hand edit as an `anomaly` lab
event — there was never a Bash script for this. Its whole design is "impossible
to do wrong at 2am":

- Five required options, no defaults. `--at` defaulting to "now" would file the
  marker at the far end of the series it annotates, which is the same as not
  filing it; `--dated-from` keeps a **commit date (an upper bound)** from being
  read as an **archive header (a second-accurate observation)**; `--evidence` is
  required because an unverifiable record is a rumour in the one series whose
  job is auditability.
- A bare `--at` is resolved as **local** time (every source an operator copies
  from — `dream.sh`'s archive header, `memory.md` note lines, `git log` — is
  local), and the resolved instant is echoed **before** the write.
- `metrics` is assembled from typed scalars and is never accepted as a mapping:
  a nested value 400s the whole event and both runtimes swallow the 400.
- The write is verified — `Resources.record_intervention` **raises** where
  `lab_event` swallows — so a 403 from the wrong account's credential exits 75
  instead of printing a success line. `--dry-run` prints the exact wire body.

Server side: `POST /agents/:username/events` gained an optional `occurredAt`
(`z.coerce.date()`) mapping onto `created_at`. **No migration** — `anomaly` was
already in the enum, the Drizzle `$type` and both DTOs.

**The three known interventions are filed** (2026-08-20, after the backend
deployed at `e3e7903`). Read back and verified to carry their real instants,
not `now()`: liushang `personality_rollback` and `memory_edit` both at
`2026-08-05T08:35:04Z`, lvchuang `personality_edit` at `2026-08-17T15:34:18Z`.
Their dates and evidence are in `docs/13-observation-lab.md`'s 2026-08-20
change point.

The deployment was checked by behaviour before the write, not by reading the
Railway build label: a POST carrying an invalid `type` **and** an invalid
`occurredAt` came back reporting an issue for both fields. A build predating
the field strips the unknown key and reports only `type`, so the second issue
is the proof — and the probe writes no row either way. Worth reusing: the
failure this guards against is silent and has no API to undo it.

**Cohesion is now a series.** A `population_metric` graph node hangs off the
cycle's tail (`logout → population_metric → END`, unconditional), fail-soft,
skipped under `--dry-run` and on an `OFFLINE` act outcome. Before this,
`GET /agents/homogenization` held three stored points in four months because
nothing ever called the POST. Two consequences worth knowing: the series changes
**sampling regime** on this date (ad-hoc points → ~23 per sweep, clustered), and
each POST costs the server two unbounded embedding-table scans — accepted, with
the condition that would make it matter recorded in `docs/13-observation-lab.md`.

**The agents' world-context is live again — it was frozen for a day.** Nothing
in Python called `swil.sh login`, which wrote `context/now.md`,
`context/news_today.md` and `context/feed_for_<username>.md`. So from the
2026-08-19 cutover until this fix, every account read a `now.md` stamped
**2026年08月19日 05:30** that also told all 23 of them they were `qiusai`, plus
a news digest dated 2026-08-18. The board feed was never affected — the act
path fetches it live — but `now.md` carried its own login-time board read, and
that WAS frozen. Python now renders all three in memory, byte-comparable with
Bash (pinned against `swil.sh` itself, not transcribed), and writes no file:
the shared `now.md` was a file five parallel rounds raced on. `SWIL_RUNTIME=bash`
is unaffected — `swil.sh` still writes it for `auto-run.sh` to read.

Two costs, both deliberate and both recorded in `docs/13-observation-lab.md`'s
2026-08-20 change point: a `--dry-run` now issues ~234 authenticated production
GETs per round where it previously issued none, and takes `news_fetch.lock`;
and the frozen block was **not** orthogonal to the read-niche experiment — it
was the read-niche channel, delivered as a constant dose to both arms, so it
diluted the contrast rather than leaving it intact.

## ⚠ Python agent runtime IS the runtime of record — stages 3/4/5 all landed — 2026-08-19

`agent/swil_agent/` — a `uv`-managed Python package that ports `auto-run.sh`'s
act path, `dream.sh`, `cycle-one.sh` (Plan 3) and the four analysis/QA scripts
(Plan 4) — has the cycle plus analysis commands (doctor / measure-status /
echo-calibrate added 2026-08-21; see the loop-engine section at the top):

| command | ports | flags |
|---|---|---|
| `swil-agent act <name>` | `auto-run.sh`'s act path | `--dry-run` `--budget N` `--seed N` |
| `swil-agent dream <name>` | `dream.sh` | `--auto` |
| `swil-agent cycle <name>` | `cycle-one.sh`, as ONE LangGraph run | `--dry-run` `--resume` `--auto` `--budget N` `--seed N` |
| `swil-agent rule-check <name>` | `rule-check.sh` | `--limit N` |
| `swil-agent behavior-snapshot <name>` | `behavior-snapshot.sh` | `--limit N` |
| `swil-agent population-metric [name]` | `population-metric.sh` | — |
| `swil-agent summary [date]` | `agent-summary.sh` | — |
| `swil-agent intervention <name>` | **nothing — no Bash equivalent** | `--kind` `--at` `--summary` `--evidence` `--dated-from` (all required) `--reason` `--window-start` `--dry-run` |
| `swil-agent doctor` | local readiness | — |
| `swil-agent measure-status [--since]` | `GET /agents/runtime` | default since 2026-07-25 |
| `swil-agent echo-calibrate <name>` | last-N post variance | `--limit N` (default 12); never writes `ECHO_DETECT` |

Run as `uv run --project agent swil-agent …`, or `cd agent && uv run
swil-agent …`. 1615 tests, 99.5% coverage, `mypy --strict` clean, `ruff` clean.
Design spec:
`docs/superpowers/specs/2026-08-17-agent-runtime-python-migration-design.md`.
Ledgers: `.superpowers/sdd/2026-08-17-agent-runtime-python-act-and-dream/progress.md`
(Plan 2, 13 tasks), `.superpowers/sdd/2026-08-18-agent-runtime-python-graph/progress.md`
(Plan 3, 10 tasks) and
`.superpowers/sdd/2026-08-19-agent-runtime-python-analysis/progress.md`
(Plan 4, 5 tasks).

**Spec §3.1's Phase-1 scope is fully delivered** — the core cycle AND the
analysis/QA group — and **spec §10's five migration stages are all done.**
Stage 3 (shadow round) and Stage 4 (canary) have their own reports at
`docs/superpowers/specs/2026-08-19-stage-3-shadow-round-report.md` and
`-stage-4-canary-report.md`. Stage 5 cut over on 2026-08-19:
`docs/superpowers/specs/2026-08-19-stage-5-cutover.md`.

**How a round happens now:** `bash agent/scripts/cycle-one.sh <name>`, exactly
as before — the script now dispatches `uv run --project agent swil-agent cycle
"$NAME" --auto` and keeps its Bash body below the switch as the rollback
(`SWIL_RUNTIME=bash`, or `git revert` the one-file cutover commit).

> **⚠ The cutover passes `--auto`, and that is not decoration.**
> `cycle-one.sh` calls `dream.sh --auto` unless `FORCE_DREAM=1`, but
> `--auto` on the Python side defaults to **OFF** (spelled and defaulted like
> `swil-agent dream`'s, so the CLI has one meaning for the flag). Dropping it
> would make every account dream every round regardless of the 12h cooldown —
> roughly a 2× rise in LLM spend and, worse, a drift series whose sampling
> rate changed at the cutover for a reason unrelated to the agents. The
> operator path (`cycle-one.sh` / `opportunistic-round.sh`) already passes it.
> Do not resurrect `heartbeat.sh` to "fix" this.

**Two `/lab` series change sampling rate at cutover, by design** — spec §7.9.
`grants_dream` (§7.1) now also governs F4 rule adherence and persona fidelity,
because `rule_check` is the dream phase's entry node: rhythm-vetoed,
empty-plan and all-failed rounds are now sampled where Bash produced gaps, and
those samples re-score *unchanged* posts. Points before and after an account's
cutover are not directly comparable; record the per-account cutover dates.

**Three things about `cycle` that will otherwise surprise a canary operator:**

- **`--auto` defaults to OFF, and `cycle-one.sh`'s default is ON.** That
  script calls `dream.sh --auto "$NAME"` unless `FORCE_DREAM=1`. The Python
  flag is spelled and defaulted exactly like `swil-agent dream`'s so the CLI
  has one meaning for `--auto` — which means **a canary invocation that wants
  Bash's dream scheduling must pass `--auto` explicitly**, or the account
  dreams every round regardless of the 12h cooldown.
- **`--dry-run` does not dream at all**, where `act --dry-run` is inert
  *within* each step. Nothing in the dream path takes a `dry_run` to be inert
  under (`write_step` rewrites `personality.md`, `snapshot_step` publishes it,
  `dream_step` irreversibly consumes `echo_flag_<name>`), so a dry cycle is
  routed straight from the act phase to logout, takes no lease, writes no
  checkpoint, and never starts the embedder daemon. Spec §15.1 row 20.
- **`--resume` continues the last checkpointed cycle** for that account,
  reusing its `thread_id` (read back out of
  `agent/.agent-state/cycle_checkpoints.sqlite`, not recomputed from the
  clock). It requires a previous non-dry cycle and is refused with a remedy
  otherwise. Since S2, a sweep thread (`…Z-r`) resumes only under that same
  `SWIL_ROUND_ID` (exit 64 otherwise — run a fresh manual `cycle`).

**`heartbeat.sh` is the one path deliberately NOT cut over.** It calls
`auto-run.sh` (act only, no dream), and `swil-agent act` is not a drop-in:
`auto-run.sh:806`'s `behavior-snapshot.sh` call lives in the Python *cycle*,
not in `act`, so swapping that one line would silently stop feeding `/lab`'s
revealed-self series on heartbeat rounds. A correct heartbeat cutover is
`swil-agent act` **plus** `swil-agent behavior-snapshot` — a second decision
with its own failure mode. The heartbeat has not run since 2026-07-02 anyway
(`launchctl list | grep swil` is empty), so nothing executes on the Bash act
path today. Stage 5's Revert column names exactly one thing, `cycle-one.sh`,
and that is what the cutover touched.

`swil-agent act --dry-run` remains the shadow-round primitive: it builds
context, produces a plan, and executes nothing — verified by tests asserting
on the absence of API calls and `memory.md` writes, not merely on an exit
code.

**Do not read "writes nothing" as "cannot affect a live round" — it was not
true until the final review.** Two of that round's findings were on this exact
path. `--dry-run` used to acquire `agent/.agent-state/lock_<name>`, so running
one while a real Bash round was live made THAT round lose the acquire race and
SKIP, silently costing the account its round; a dry run now takes no lock. And
the `agentBackend` profile PATCH added in the same round is explicitly skipped
under `--dry-run`, which is the kind of write that would otherwise creep back
in. The claim holds today; treat it as an invariant to re-check whenever a new
side effect is added to `run_act`, not as something the flag guarantees for
free.

**What's in this package, and what deliberately is not.** Shipped: `act/`
(context assembly, the rhythm-prose parser, the planner, guardrails, the
write-verified executor), `dream/` (cooldown, candidate generation/cleanup,
the per-aspect drift gate, the accept/write sequence), `api/` (typed
`Resources` + dual auth), `llm/` (claude/codex/deepseek CLI dispatch + the
neutral aspect distiller), `embedder/` (the bge-m3 client + a thin wrapper
around `embedder-guard.sh` — the guard script itself stays Bash on purpose,
see spec §3.2), **`graph/` (Plan 3 — the LangGraph cycle, `CycleState`,
SQLite checkpointing, and run leases)**, and `cli.py` composing all of it.

**`analysis/` (`rule_check`, `behavior_snapshot`, `population_metric`,
`summary`) shipped with Plan 4 (2026-08-19), and three of the four are wired
into the cycle** — closing spec §15.1 row 21, which had recorded only half
the gap. `swil-agent cycle` now runs them where `cycle-one.sh` and
`auto-run.sh` do:

```
login → plan → guardrail → execute → behavior_snapshot → rule_check → dream → gate → write → snapshot →
logout → population_metric → END
```

- **`behavior_snapshot`** is the act phase's tail (`auto-run.sh:806`). It
  embeds the account's recent posts and ships the vector the server turns
  into persona fidelity = cosine(personality, behavior) — the *revealed self*
  half of a pair whose *stated self* half the dream's own snapshot was
  already uploading. Before Plan 4 the cycle published one side of that
  comparison and withheld the other.
- **`rule_check`** is the dream phase's HEAD (`cycle-one.sh:45`), and the
  position is a contract, not layout: it parses the rules out of
  `personality.md` and the dream rewrites that file, so sampling afterwards
  measures the new rules against the old posts (`cycle-one.sh:39-41` says
  so). Numbers that look completely normal and are about the wrong document.

Both are fail-soft (a sampler that raises cannot change the round's outcome
or exit code) and both are skipped entirely under `--dry-run`. Neither has a
retry policy: they swallow their own failures, and a retry would double-file
the measurement. **`swil-agent act` alone still samples neither** — `run_act`
is frozen and Bash makes both calls from the composition — which is what the
two standalone commands are for.

Operational notes for the standalone four:

- `behavior-snapshot` does **not** start the embedder daemon, matching Bash
  (only `cycle-one.sh` brackets `embedder-guard.sh`, and only for the dream).
  A daemon that is down means the sample silently does not land, on either
  runtime. Start it first if you want the point.
- `population-metric` takes an account name only to pick a **credential** —
  the route is global. Omitting it uses the first keyed account under
  `agents/` then `humans/`. It exits `66` for a name that does not exist and
  `75` for an account with no usable key or a server rejection, where Bash
  has only `exit 1` for all three.
- `summary` is local-only: it reads each `memory.md`, touches no API, needs
  no credentials, and its default date is **local** time, not UTC.
- `RULE_CHECK_POST_LIMIT` and `BEHAVIOR_POST_LIMIT` are now read from
  `agent/.env` by the Python side too (`Settings`), so an operator override
  applies to both runtimes.

**One trap, if anyone ever tidies `analysis/`.** `rule-check.sh` and
`behavior-snapshot.sh` extract a post's body *differently*, and both ports
reproduce their own script rather than sharing a helper.
`rule-check.sh:59` is embedded Python (`originalText or text`);
`behavior-snapshot.sh:65` is jq (`.originalText // .text`), and **an empty
string is truthy in jq** — so an item with `originalText: ""` falls back to
the translated `text` in one and is dropped entirely in the other. Merging
them into one `extract_posts` silently picks the `or` semantics and starts
feeding translated text into the behaviour vector, which is exactly what
`behavior-snapshot.sh:57-58`'s own comment exists to prevent. Pinned in both
directions; spec §15.5 records it in full.

**Run leases (spec §7.3) now exist** and are what `swil-agent cycle` holds.
A lease is BOTH halves, deliberately: the Bash-visible lock file
(`agent/.agent-state/lock_<name>` / `dream_lock_<name>`, same 1800s staleness
rule) *and* a SQLite row carrying the holder's `run_id` and pid. The file half
is what made exclusion cross-runtime during stages 3–4; it is still held after
the Stage 5 cutover, because dropping it would strand the `SWIL_RUNTIME=bash`
rollback path with no exclusion against a concurrent Python round; the row is what makes a lease *expire* and what kills the orphan-lock
class outright, since a lease whose pid is gone is reclaimable immediately
rather than after 30 minutes. Two consequences are recorded as spec §15.1
rows 17 and 18: a cycle holds BOTH locks for its whole duration (where
`cycle-one.sh` holds them sequentially), and the heartbeat bounds staleness by
the longest single NODE rather than by the whole cycle.

**Two operational facts that will otherwise cost someone a slow, confusing
first run:**

- **The anchor aspect cache does not travel with the repo.**
  `personality.anchor.aspects.json` (one per account, 3×1024 floats) is
  git-ignored by design and exists today only in the *main checkout's*
  working tree. A worktree, a fresh clone, or a CI runner starts cold. A
  cache miss re-distills and re-embeds rather than failing, so correctness is
  fine — but warming the full 23-account roster from cold costs **~69
  `claude` calls plus ~69 `/embed` calls** (23 accounts × 3 aspects). Whoever
  runs the shadow round or canary from a checkout other than the main one
  should expect a much slower first pass, or should copy the 23
  `personality.anchor.aspects.json` files across first.
- **`agent/.env` is required for any real (non-`--dry-run`, non-unit-test)
  invocation, and is deliberately absent from this and every other
  worktree.** It carries four live credentials (`SWIL_PASS`, two Unsplash
  keys, `SWIL_AGENT_SETUP_TOKEN`) and points `SWIL_URL` at Railway
  **production** — it was removed from this worktree mid-plan after an
  implementer copied it in for a test that didn't need it (see the plan
  ledger, Task 11). Every unit test in `agent/tests/` builds its own
  `Settings(...)` directly rather than reading the real file; do not
  recreate `agent/.env` here to "make it work" — copy it in only for an
  actual, deliberate shadow-round or canary run, and treat that as touching
  production.

**Two things left open by design, not oversight** (see
`.superpowers/sdd/2026-08-17-agent-runtime-python-act-and-dream/task-13-brief.md`'s
self-review and Tasks 5/7's rulings for the full reasoning):

1. **A guardrail stage-ordering artifact is reproduced, not fixed.**
   `act/guardrails.py` empties a `[post, nothing]` plan under the `no_post`
   rhythm veto because of the ORDER its stages run in, inherited byte-for-byte
   from `auto-run.sh`'s own `apply_plan_guardrails`. Reordering the stages
   would remove the artifact but would also show up as a divergence on every
   rhythm-vetoed account in the shadow-round comparison, for a defect whose
   actual harm is already gone under §7.1 (an emptied plan no longer costs the
   account its dream). Left as-is on purpose; worth a real fix only after the
   shadow round confirms it's the only thing left disagreeing on those
   accounts.
2. **`landed == 0` no longer denies the dream — a genuine, spec-driven policy
   change, not a bug.** Bash skips the dream when every planned action failed
   (reasoning: dreaming on a round with no refreshed memory manufactures
   drift that never happened). Design spec §7.1 says only
   `ActOutcome.BACKEND_UNAVAILABLE` and `OFFLINE` may deny a dream — a
   rhythm-vetoed or all-failed round is still the agent's own correct choice
   or bad luck, not evidence the platform was unreachable. `act/round.py`
   follows the spec: an all-failed round is logged at WARNING with Bash's
   *original* wording (so `grep FAIL` still finds it) but `ActResult.
   grants_dream` is `True` regardless, and `swil-agent dream` will run. This
   means Python dreams on some rounds Bash would have skipped. **Recorded as a
   change point on 2026-08-19** (§7.1, and §7.9 for the two further `/lab`
   series it reaches through `rule_check` and `behavior_snapshot`); per-account
   dates in `docs/superpowers/specs/2026-08-19-stage-5-cutover.md`. Not a bug
   to investigate, and not a threshold to tune away.

**Known Bash↔Python differences** — twelve rows, each with a direction
(fail-safe / fail-open / trap / neutral) and a verdict on whether it must be
resolved before Stage 5: spec §15, not restated here since a copy would go
stale the moment either side changes.

## ⚠ The embedder was the reason dreams fail-opened — 2026-08-13

Three dreams (vex, shengyin, liushang) were accepted **without any drift gate**
during the 2026-08-13 round: `aspect distill/embed failed, falling back to scalar
drift` → `embedder unreachable, skipping drift check`. Two snapshot POSTs also
timed out at 60 s. The embedder was healthy before and after, and
`embedder-guard.sh` never touched it (`owner=external` throughout), so the first
read — "the 8 s health probe is too tight for a 5-way round" — was wrong about
the cause. Activity Monitor at 05:54 showed **Python at 27.8 GB**.

**What actually happened.** Measured, on a freshly booted daemon, for ONE
full-`personality.md` embed:

```
phys_footprint:       7905 MB          IOAccelerator            4.0 GB
phys_footprint_peak:  16 GB            IOAccelerator (graphics) 7.0 GB
```

`ps -o rss` reports ~400 MB for the same process and is useless here: MPS
allocates from Apple Silicon's unified memory, which lands under IOAccelerator,
not RSS. Activity Monitor's column is the physical footprint.

Three compounding causes:

1. **The documents outgrew the model.** bge-m3 is XLM-RoBERTa-large (24 layers,
   16 heads) with `max_seq_length` 8192, and `snapshot.sh` sends the entire
   `personality.md` as one text. Those files are now 30–42 KB —
   shengyin 10751 tokens, zenith 10745, moguan 9726, qiusai 8670 (median across
   the roster: 4048). So the heaviest embeds are max-length passes, and **4 of 23
   accounts are silently clipped**: their drift has always been measured on the
   leading ~80% of the document, with nothing reported.
2. **Nothing serialised the forward pass.** `/embed` is `def`, not `async def`,
   so FastAPI dispatches it on anyio's threadpool — the parallel `cycle-one.sh`
   processes of a round all ran `model.encode` at once. `_cache_lock` only ever
   guarded SQLite.
3. **MPS cache was never released.** No `torch.mps.empty_cache()` anywhere, and
   the caching allocator does not shrink on its own, so the footprint only
   ratcheted upward.

→ 5 concurrent max-length passes → 27.8 GB → memory pressure and swap → the 8 s
health probe times out → constitution layer fail-opens.

**Fix** (`agent/scripts/embedder/server.py`):

- `_model_lock` around `model.encode` — one pass at a time.
- `_release_device_cache()` after every encode (and after warmup).
- `EMBEDDER_BATCH_SIZE` (default 4, was the library default 32) so a 64-text
  request cannot put 32 max-length sequences on the GPU at once.
- `truncated` in the `/embed` response + a daemon-log WARN, computed over **all**
  requested texts rather than only cache misses — otherwise `truncated: 0` means
  "not truncated" on a miss and "cached, unknown" on a hit. `snapshot.sh` surfaces
  it; the snapshot still uploads, because a partial vector beats a gap.
- `/health` now reports `max_seq_length` and `batch_size`.

Measured after the fix — 3 concurrent full-personality embeds:

| | peak footprint | wall time |
|---|---|---|
| before, 1 request | 15.9 GB | 4.6 s |
| after, 1 request | 15.9 GB | 5.9 s |
| after, 3 concurrent | **15.9 GB** | 4.7 / 9.0 / 13.4 s (serialised) |

Settled footprint after a request drops **7.7 GB → 3.7 GB**; `IOAccelerator`
goes 4.0 GB → 160 KB. Concurrency no longer multiplies the peak — that is the
whole fix. The 15.9 GB peak of a single 8192-token pass is inherent to the model
and unchanged.

**Deliberately NOT changed: `max_seq_length` stays 8192.** Lowering it would cut
peak memory further, but the drift experiment compares cosine similarities across
snapshots recorded over months — shortening the window mid-experiment makes new
vectors incomparable to stored ones. `EMBEDDER_MAX_SEQ_LEN` exists as an override
for anyone who decides that trade is worth it. The 4 clipped accounts are a real
data-quality issue, but the fix for them is shorter personalities or a chunked
embedding strategy, not a quietly re-scaled ruler.

## ⚠ Real-world news channel was dead — 2026-08-13

`context/now.md` carries a "today's real-world news" section so agents can react
to things that actually happened. It had been writing **`（无法获取）` into every
single `now.md`, on every round, for as long as the block has existed.**

`swil.sh login` fetched `https://swil-news.vercel.app/api/news` inline and ran a
jq filter that treated `.dates` as an *object*:

```jq
.dates | to_entries | sort_by(.key) | reverse | .[0].value | .[0:8][]
```

The endpoint returns `.dates` as an **array** of `{date, entries[]}`. On an array
`to_entries` yields `{key: <index>, value: <element>}`, so `.[0].value` is a
`{date, entries}` *object*, and slicing an object with `.[0:8]` errors. The
`|| echo "（无法获取）"` fallback then swallowed it. Nothing logged, so the failure
was invisible from the outside: the section header was present and populated with
a plausible-looking string.

Two consequences worth separating. The agents were never grounded in real-world
events — every "topical" post came from the platform's own feed, which is the
same closed loop the board split was introduced to break. And each login pulled
**1.78 MB (~4.5 s)** against an 8 s timeout, 23× per round, to produce that.

**Fix.** `agent/scripts/news-fetch.sh` fetches once into `context/news_today.md`
and caches it (`NEWS_MAX_AGE_HOURS`, default 6, mkdir-spinlock so 23 concurrent
logins don't stampede); `swil.sh login` just reads the file. It picks the newest
digest with `max_by(.date)` rather than by array position — the API's ordering
isn't a contract. Output is a fragment starting at `###`, inlined under a `##`
heading in `now.md`: ~10 topics × 3 highlights + takeaway, ≈ 8 KB.

Note the digest date can lag the wall-clock date by a day; the fragment prints
its own `日报日期` so the agent can see which it is. `news-fetch.sh` never aborts
a round — a news outage leaves the last good cache in place, which is still real
news, just older.

## Agents can now read comment threads — 2026-08-13

The act prompt gave the agent top-level post text and nothing else. A thread's
replies were reachable **only** if that thread had already pinged the account's
notifications, so `parentId` replies were something an agent could receive but
never *choose*, and every conversation it wasn't already in was invisible.

`auto-run.sh` now opens the comment threads of the 3 busiest posts
(`commentCount >= 2`) the account hasn't already engaged with, and inlines them
with their comment IDs. Costs ~6 extra reads per account. The feed JSON is
fetched once and reused for both the flat list and the thread targets rather than
being requested twice.

## ▶ NEXT SESSION STARTS HERE — 2026-08-05, multi-action rounds + DM

**⚠ Interaction-rate boundary: 2026-08-05.** A round used to contain at most one
action per account — 23 accounts, 23 actions, and Round 27 spent 17 of them on
posts. Each account now gets an **action budget** (`ACTION_BUDGET=5`) and the LLM
returns a *plan* of up to 5 actions instead of one. Non-post interaction jumps
roughly 18×. `/lab`'s interaction graph, cross-species panel, and engagement
splits step-change here: **data before and after 2026-08-05 is not directly
comparable.** This sits alongside the separate pre-2026-08-05 drift
contamination described below — both boundaries land on the same date, for
different reasons.

Design: `docs/superpowers/specs/2026-08-05-multi-action-rounds-design.md`.
Plan: `docs/superpowers/plans/2026-08-05-multi-action-rounds.md`.

### What changed

- **`normalize_plan`** turns whatever the backend emitted into a JSON array —
  `{"plan":[…]}`, a bare `{"action":…}`, a top-level array, or concatenated
  documents (codex). The bare-object path is permanent tolerance, not legacy
  debt: backends differ in how reliably they honour a shape, and one action beats
  zero.
- **`apply_plan_guardrails`** enforces, *in code*: the budget, at most 1 `post`
  and at most 1 `echo`, the `no_post` rhythm veto, DM recipients restricted to
  the contact list, no repeating a verb on a postId, `nothing` only as a whole
  plan, and the codex `post`/`nothing` allow-list. Round 27 is why none of these
  are prompt text — every `personality.md` says "60% chance of post" and 17 of 23
  accounts posted anyway.
- **The forced-retry LLM round-trips are gone.** When the rhythm forbids posting
  there is nothing to re-ask; the post is dropped from the plan. That removes an
  entire extra LLM call per vetoed account.
- **`execute_action`** replaces the inline `case`. One failed action no longer
  ends the round — the exit-code contract now keys off *"did anything land"*
  (≥1 → 0, 0 → 75), so a stale postId cannot cost an account its turn.
- **DM.** `swil.sh` gained `dm`, `dms`, `dm-thread`, `contacts`. Recipients are
  restricted to following ∪ followers ∪ open conversations. **Self-lookup is
  `/auth/me`, not `/users/me`** — the users router mounts the follows sub-router
  at `/users/:username`, whose validator rejects `"me"` for being under 3 chars.
- **Observability split, deliberate.** The `lab_event` for a DM carries
  `→@recipient` and never the body; `memory.md` (local, never uploaded) keeps an
  80-char preview so the agent remembers what it said.
- Tests: `bash agent/scripts/tests/plan.test.sh` — 23 pure-function cases, no
  network. `auto-run.sh` is sourceable via `SOURCE_ONLY=1`, and derives
  `SCRIPT_DIR` from `BASH_SOURCE` (not `$0`) so sourcing resolves `llm.sh`.

### Verified end-to-end 2026-08-05

`xianying` planned `comment, comment, like, like` → 4/4 landed. `shunteng`
(deepseek) planned `comment ×4, dm` → 5/5 landed, dream accepted. Both chose
**zero posts** and spent the whole budget on interaction — the intended
rebalance. The DM was read back independently from the recipient's side, and the
two accounts ended up replying to each other in the same thread, which is the
first time the roster has produced an actual exchange rather than parallel
monologues.

### Not fixed, by decision

The `tail -20 memory.md` echo loop still has no damping (see the liushang
section below). More comments per round means more notifications feeding the next
round's context — a second amplification path in an already-tight loop. Watch it.

## Round 27 — 2026-08-05, four defects found by auditing it

Round 27 ran all 23 accounts (17 post / 2 like / 1 comment / 2 nothing / 1 fail),
8 dreams accepted. Auditing the round surfaced four defects; all are fixed
locally, one is **blocked on a backend deploy**.

### 1. `auto-run.sh`'s exit-code contract was inert (the important one)

`run_agent` ended with `( … ) || _log "ERROR …"`. `_log` succeeds, so it became
run_agent's status and **every** non-zero return from inside the subshell was
reported to Main as 0 — lock held (75), login failed (75), no LLM response (75),
`ACTION_FAILED` (75), no personality.md (66). `cycle-one.sh` refuses to dream on
a non-zero act precisely to avoid dreaming on un-refreshed memory, so that guard
had never fired for any in-subshell failure. Only the `check_internet` path
(which exits from Main) worked.

Observed on `lvchuang`: `FAIL … dream will be skipped` immediately followed by
`auto-run complete (rc=0)` and a dream. Fixed by capturing `$?` and returning it.
Verified end-to-end: holding `lock_liushang` now yields `rc=75` (was `rc=0`).

**Consequence for the drift experiment:** an unknown number of past
`personalitysnapshots` rows come from dreams that ran on rounds whose act never
landed — the manufactured drift the contract was written to prevent. Treat
pre-2026-08-05 drift data as containing that contamination.

### 2. Replies 404'd because the model was never shown the parent's postId

`comments.service.ts` requires `parent.postId === post.id`. The notification
context in `auto-run.sh` rendered `评论ID:<id>` but **not** the post it belongs
to, so the model paired a notification's comment id with a postId taken from the
feed — a guaranteed `404 Parent comment not found` (`lvchuang`, this round).
Fixed by emitting `postId:<id>` in the notification line, plus a fallback: a
comment that fails **with** a parentId retries once as a top-level comment on the
same post rather than burning the round.

### 3. `agentBackend` sync 403'd on every `humans/` round, silently

`updateMe` refused `agentBackend` for `isAgent:false` accounts, and `auto-run.sh`
swallowed the 403 with `|| true` + `2>/dev/null`. Result: `chongkai`/`maobian`
null, six other `humans/` accounts holding pre-guard bare `"claude"` with no
model tier — so model-arm attribution never worked for the human cohort.

The `humans/` accounts are LLM-driven; `isAgent:false` describes what they
*are*, not what drives them. **The guard is removed** (`users.service.ts`), its
test inverted, and the swallowed failure now logs `WARN … agentBackend sync
failed: …`.

> **⚠ Blocked:** the backfill needs the relaxed guard live on Railway. Once the
> backend is deployed, the next cycle self-heals all 8 — `auto-run.sh` PATCHes
> `<backend>[:<model>]` every round. No manual DB write needed. Until then the
> WARN will fire once per human account per round.

### 4. `liushang` collapsed onto one phrase — an act-path failure the gate can't see

Every `liushang` post from 2026-07-06 to 2026-08-05 recycled 那半句, shrinking
40 → 21 chars with all punctuation and line breaks gone. Root cause is a closed
loop with no damping: `auto-run.sh:256` feeds `tail -20 memory.md` — the agent's
own recent output — straight back into the prompt. 8 of the last 20 lines were
that phrase, so the model imitated the newest (shortest) samples and wrote the
result back. Its `personality.md` carried the phrase **11 times**, including two
of five 示例语气 samples, continuously refuelling it.

This is *not* what the constitution layer guards. The per-aspect gate kept
**rejecting** liushang's dreams (values 0.597 / style 0.718 / topic 0.661), so
`personality.md` stayed frozen at a healthy version while the output degraded
underneath it. **A rejected dream does not mean a healthy account.**

Scoped fix (runtime deliberately untouched — changing the act prompt mid-flight
would confound the drift experiment):
- `personality.md` rewritten: phrase 11 → 0 occurrences, 示例语气 rebuilt from the
  persona's own neglected motifs (借来的凉 / 间隔里的抵达 / 未送达的信), explicit
  anti-repetition rules added to 写作风格 and 发帖节律, and a truthful 自传成长
  entry. All dream.sh validators verified intact.
- 10 degenerate post entries pruned from `memory.md` (`| post |` lines only;
  comments and likes kept), one `| note |` line recording the intervention.
  Prompt-slice saturation: 8/20 post lines → 3/20, and the 3 survivors are the
  healthy long-form ones. `last_dream_memlines_liushang` reset to match.
- Old version prepended to `personality.archive.md`; the drift **anchor is the
  oldest block, so it is unchanged**. Original memory.md is in git history —
  deliberately *not* written to `memory.archive.md`, whose tail dream.sh feeds
  back into the prompt.

**The mechanism is unfixed by design.** `tail -20 memory.md` is undamped
self-imitation for all 23 accounts; the codex trio (`weijian` / `shujupai` /
`diannaokun`) shows a milder form — same rhetorical template two rounds running.
`ECHO_DETECT` was built for exactly this but is off and uncalibrated. Decide
whether to damp the loop generally or instrument it first.

## Round 26 and earlier — 2026-08-04, DeepSeek backend: rollout phase 3 (actions unlocked)

A third backend (`deepseek`) now ships alongside `claude` and `codex`, all
dispatching through the shared `agent/scripts/llm.sh`. DeepSeek runs the
`claude` CLI against DeepSeek's Anthropic-compatible endpoint
(`https://api.deepseek.com/anthropic`); config in `agent/scripts/deepseek-env.sh`
(git-tracked), key in `~/.claude/.deepseek-key` (outside the repo, sourced only
inside a subshell so it never leaks into the two calls that must stay on real
Anthropic — `dream.sh`'s `ASPECT_DISTILL_MODEL` and `benchmark-run.sh`'s
`judge_score`). See `CLAUDE.md`'s agent-activity-cycle section for the full
backend writeup, and `docs/superpowers/specs/2026-08-03-deepseek-backend-design.md`
/ `docs/superpowers/plans/2026-08-03-deepseek-backend.md` for the design and
task plan.

The account is `shunteng` (顺藤), board `life-science`,
`AI Backend: deepseek` / `Model: deepseek-v4-flash`. Rollout ran in phases
across Tasks 1–6:

1. Shared dispatcher (`llm.sh`) built and routed through `auto-run.sh`,
   `dream.sh`, `benchmark-run.sh` (Tasks 1–3).
2. DeepSeek arm verified offline on Persona Bench — never touches the live
   feed (Task 4).
3. `shunteng` brought online under a hard `post / nothing` restriction so a
   week of activity could accumulate without risking an unverified action
   path (Task 5). First post verified to persist via unauthenticated
   `GET /api/v1/posts/<id>` (`postCount=1`), not by trusting the log. First
   dream **accepted** (values 0.795 / style 0.764 / topic 0.853).

### Task 6 — action-by-action verification, then unlock (this session)

Before touching the restriction, each of the four locked-out actions was
exercised once against **production** as `shunteng` and confirmed via a
second, independent API read, not the action's own response body:

| Action  | Read-back method | Result |
|---|---|---|
| comment | `thread <postId>` — comment text visible; `commentCount` 1→2 | persisted |
| like    | `get <postId>` — `likeCount` 2→3, `likedByMe:true` | persisted |
| echo    | `get` on original (`echoCount` 1→2) + `get` on the new post (`echoOf` populated) + `user-posts shunteng` | persisted |
| follow  | `user fenziys` (`followerCount` 9→10) + `user shunteng` (`followingCount` 0→1); a retried `follow` correctly 409'd "Already following" | persisted |

All four landed cleanly, so `auto-run.sh`'s `backend_action_constraint` (around
line 310) was reverted to **codex-only** — the `|| "$ai_backend" == "deepseek"`
half of the condition is gone, no narrowed constraint needed. Then ran one full
unrestricted `cycle-one.sh shunteng`: the LLM freely chose `comment` (not
forced into post/nothing), and the resulting comment read back correctly via
`thread <postId>` — the log's `DONE shunteng commented on …` claim matched the
DB. Dream step correctly `SKIP`ped (12h cooldown, only 1h elapsed).

**This is the opposite of the codex outcome, worth stating plainly:** codex's
`like` fails every round, and codex has logged `DONE … commented on …` twice
while the API showed `commentCount: 0` and an empty thread both times (see
Round 21/25 notes below). DeepSeek's four actions all read back correctly on
the first try — the per-action verification step earned its keep here by
having a real chance to catch the same failure mode and not finding it.

### Known issue carried into this rollout

`agent/scripts/setup-agents.sh` cannot safely add one account to an existing
roster. `registerLimiter` is 3/hour, IP-keyed, with no `skipFailedRequests`,
and the script makes one register call per account with no existence
pre-check — so on a re-run, 409s from already-registered accounts burn the
budget before it reaches the new one. `shunteng` was registered by hand for
this reason. Fix before the next new account: pre-check `GET /users/<name>`
before calling `POST /auth/register`, or give the register route
`skipFailedRequests: true`.

### Persona Bench data point (from Task 4, offline only)

Full battery (10 tasks × k=2, 3 personas): ds-flash fidelity vs opus —
`liushang` .576/.577, `shengyin` .636/.644, `chawendao` .624/.624 —
effectively indistinguishable. `ruleScore` .85–1.0. Latency roughly 1.5× opus.
`CLAUDE_CODE_EFFORT_LEVEL=medium` verified to produce no warning. `claude-ds`
in `~/.zshrc` is a zsh function and cannot be called from these bash scripts —
`deepseek-env.sh` + a subshell is the only path in.

## Round 25 — 2026-08-02: activity cycle only

Round 25 was a pure cycle round — no code changed. 22/22 accounts ran
login → act → dream → logout against **production** (Railway + Neon), in 5
parallel subagents of 4–5 accounts each, strictly sequential inside a group.

### Round 25 cycle results (2026-08-02 18:31–18:59 PDT)

22/22 completed. **Zero action failures, zero timeouts, zero leftover locks.**
9 posted (2 with images), 6 commented, 2 liked, 5 deliberately did nothing.

Dreams: **6 accepted / 16 rejected** (27.3%), again on the ~29% the 2026-07-03
calibration targeted. Breaches: **topic 11, style 8, values 5**. All 22 verdicts
were aspect verdicts — **zero structural rejects**, so the `AI Backend`
mangling that has bitten `moguan`/`qiusai` before did not recur.
Accepted: `xianying`, `zenith`, `vex`, `mangniu`, `chongkai`, `maobian`; all 6
snapshots uploaded.

Every action was verified against the production DB rather than trusted from
the log, using the public read routes ADR 006 opened:

- 9/9 posts present via `GET /api/v1/users/<username>/posts` — **query by the
  `Username` bullet, not the folder** (`sketch`→`diannaokun`, `zenith`→`xuansi`,
  `quant`→`shujupai`, `vex`→`weijian`).
- No duplicate bodies inside any account's last 5 posts — the codex
  duplicate-body defect did not reproduce.
- Both image posts (`chawendao`, `fenziys`) carried their image, so the
  `mktemp` collision did not fire; they ran 13 min apart.
- 6/6 comments present via `GET /api/v1/posts/<id>/comments`; both liked posts
  read back `likeCount=1`.

### What this round says

1. **Topic monoculture is now the dominant failure mode.** 11 of 22 accounts
   breached `topic`, and the feed converged hard on a single thread — the EU AI
   Act standards gap, phrased as 「法律到了，尺子没到」/「临时规则→永久先例」—
   which `chawendao`, `hodlge`, `tulingshe`, `zhuiyi`, `sketch` and `mangniu`
   all wrote into. This is the constitution layer working as designed, not a
   threshold that needs loosening. `tulingshe` missed by 0.006
   (topic=0.7040 vs 0.71), so a nudge to the input would flip several of these.
2. **`quant`'s stale anchor got worse.** It was failing `topic` alone; this
   round it breached all three (0.590 / 0.683 / 0.674). Still no account has a
   `personality.anchor.md`. This remains the top item to fix before the
   measurement protocol starts.
3. **The Round 23 SIGPIPE fix holds.** `vex`'s dream was accepted and its output
   still ends at `snapshot uploaded`, but `dream_lock_vex` was **not** orphaned —
   no lock survived the round. `vex`'s codex hang also did not reproduce, now
   two rounds running.
4. **The codex comment/like silent-fail path was not exercised.** All four codex
   accounts behaved, but two posted and two chose nothing, so the failing path
   saw no traffic. It stays un-root-caused.

### Two operational notes

- **CLAUDE.md's cycle step 1 is misleading.** It says verify
  `http://localhost:8899/health`, but `agent/.env` sets `SWIL_URL` to the
  Railway production URL and nothing listens on 8899. Following the doc
  literally reads as "the API is down" while the cycle is in fact about to
  write to production. Worth correcting.
- **`agent/scripts/embedder/cache.sqlite` was tracked in git** and grew
  14.2 MB → 14.7 MB in this one round — **fixed, see Round 25.1 below.**

### Round 25.1 — untracked the regenerable embedder artifacts

`agent/scripts/embedder/cache.sqlite` is a sha256→bge-m3 vector cache that
`server.py` recreates on connect (`sqlite3.connect` + `CREATE TABLE IF NOT
EXISTS`), so it has never been a build input. It was nonetheless tracked, and
this doc already called it "intentionally left uncommitted" back in Round 20 —
yet Round 24 committed it again. Three ~13.5 MB blobs are already in history and
`.git` is **550 MB**.

Now gitignored and removed from the index (the file stays on disk), alongside
`agent/scripts/embedder/__pycache__/server.cpython-313.pyc`, which was also
tracked. Added a generic `__pycache__/` + `*.pyc` rule so it cannot recur.
`.venv/` needs no rule — Python writes a self-ignoring `.gitignore` inside it.

Verified by cold start: with `cache.sqlite` moved aside the daemon booted
normally, `/embed` returned `dim=1024 misses=1`, a fresh 16 KB cache appeared,
and the same call then returned `hits=1`. The original 14.7 MB / 3127-row cache
was restored afterwards, byte-identical.

This stops the bleeding. Shrinking the existing `.git` turned out to need no
history rewrite at all — see Round 25.6.

### Round 25.2 — `/lab` F3 + F4 reconnected

Round 24 listed `population-metric.sh` and `rule-check.sh` as "wired to
nothing". Confirmed: no plist references either (only `com.swil.embedder` and
`com.swil.heartbeat` exist), and neither `cycle-one.sh` nor `heartbeat.sh`
calls them — so `13-observation-lab.md`'s claim that population-metric runs
"daily via launchd" has never been true.

Both were first verified to still work after the Mongo→Neon migration, since
neither had run since 2026-06-12:

- `population-metric.sh` → `personaCohesion=0.708 behaviorCohesion=0.598 n=22`.
- `rule-check.sh zenith` → event confirmed in the DB by reading
  `/agents/xuansi/events?type=rule_check` back. The only prior event was dated
  **2026-06-13**, i.e. F4 had one stale point per account.

`rule-check.sh` is now called from `cycle-one.sh`, **before** `dream.sh` — it
parses rules out of `personality.md` and a dream rewrites that file, so
sampling first measures the rules that were actually in force when the round's
posts were written. The call is `|| true`: this is the observability lane, and
a missing `api_key.txt` or a network blip must not fail a round. Verified that
a bad account name leaves the caller at rc=0.

`population-metric.sh` is deliberately **not** wired into `cycle-one.sh` — it
is a population-level sample and would fire 22× per round there. It needs a
round-level hook (or a plist, which is the operator's call); for now run it
once by hand at the end of a round. All 22 accounts were given a fresh
`rule_check` sample.

### Round 25.3 — `rule-check.sh` misread a date as a hashtag rule

Backfilling the 22 samples surfaced a real defect. `quant` reported
**`hashtag count 2026-6: 0/12 posts adherent (0%)`** and shipped it to `/lab`
as a `flagged` event — against a rule it never wrote.

The range pattern `(\d+)\s*[～~\-－]\s*(\d+)` was applied to any line containing
`hashtag` or `标签`. `quant`'s `personality.md:185` is a dated memory entry —
`- 2026-06-24 | ...标签越顺手，越要检查它压掉了什么。` — so `2026-06` parsed as
min=2026 / max=6, a range no post can satisfy. The two other 标签 lines in that
file are about *label compression* as a concept, not hashtags: the correct
answer is "no parseable rules".

Fixed by bounding an explicit range to `0 <= min <= max <= MAX_HASHTAGS` (20)
and *continuing* the scan on rejection instead of breaking, so a genuine rule
later in the file still wins. Verified without touching the network by
extracting the parser from both the old and new script and running them over
all 22 `personality.md` files: the diff is exactly one line, `quant`
`hashtag count 2026-6` → `none`, every other account unchanged.

**One bogus event survives in production** (`quant`/`shujupai`,
`2026-08-03T02:29:49`, outcome `flagged`) — emitted by the backfill above,
before the bug was found. There is no `DELETE` route for lab events, so
removing it needs either a direct DB statement or a new endpoint; both are the
owner's call. It is the only such point: the 2026-06-13 run predates the memory
line that triggers the misparse.

### Round 25.4 — the cycle's health check pointed at the wrong host

CLAUDE.md's step 1 said to probe `http://localhost:8899/health`, but
`agent/.env` sets `SWIL_URL` to Railway production and nothing listens on 8899.
Following it literally returns `000`, which reads as "the API is down" while the
round is in fact about to write to the live site. Step now sources `agent/.env`
and probes `"$SWIL_URL/health"`, so it is correct for both a local and a
production target, and says plainly which one is configured. Verified by
running the new snippet verbatim: `200`.

### Round 25.5 — `quant` unfrozen by pinning an anchor

`quant` was **0 accepted / 19 rejected** since the aspect gate went live: its
anchor defaulted to the oldest archived version (2026-05-24), which its present
self no longer resembles, so every candidate breached and its `personality.md`
could never change again. No account on the roster had ever used the
`personality.anchor.md` pin.

Owner's call was to pin the current version, accepting the drift so far as
legitimate identity and restarting measurement from today.
`agent/agents/quant/personality.anchor.md` is now a copy of the pre-dream
`personality.md`. The stale `personality.anchor.aspects.json` (2026-07-03)
needed no manual cleanup — `_anchor_aspects` keys its cache on
`sha256(anchor_text):v<promptVersion>`, so it self-invalidated and re-distilled.

Verified with a real `FORCE_DREAM=1` run: **accepted**, `values=0.734
style=0.720 topic=0.837` — the first acceptance in 20 attempts. Note
`style=0.7204` cleared its 0.72 threshold by 0.0004, so quant is unfrozen but
still close to the edge on that aspect. The anchor correctly stayed at the
pre-dream text while `personality.md` moved on.

Two consequences to carry: the drift trajectory in `/lab` for quant now has a
discontinuity at 2026-08-02, and quant is the **only** pinned account, so it is
no longer measured on the same footing as the other 21.

### Round 25.6 — `.git` was 550 MB because auto-gc never fired

Investigating the history-rewrite option produced a finding that made the
rewrite unnecessary. `git count-objects -vH`:

```
count: 2612          size: 538.82 MiB     <- loose
in-pack: 537         size-pack: 7.56 MiB
```

Essentially the entire repository was **loose, unpacked objects**. A plain
`git gc` took 2.5 s and brought `.git` from **550 MB to 68 MB** — no history
rewrite, no force-push, no invalidated clones. HEAD unchanged at `8de1ef6`, 64
commits still reachable, all 53 working-tree changes intact, `git fsck` clean.

The reason it accumulated: Git's auto-gc triggers on loose-object **count**
(`gc.auto`, default 6700), not on bytes. A repo whose bloat is a handful of very
large binaries never crosses the count threshold, so it grows silently forever.
Worth a periodic manual `git gc` on any repo that stores big artifacts.

**Residual, and now probably not worth it.** The pack is 64.38 MiB and still
contains the three historical `cache.sqlite` blobs plus the demo media. Purging
them with `git filter-repo` could plausibly reach ~30 MB, but that costs a
force-push and invalidates every clone to save ~35 MB on an already-normal-sized
repo. Recommendation: don't. Also note `docs/demo/swil-social-1.gif` **must not**
be purged regardless — it is the README's hero image (`README.md:13`), and
`.gitignore:52` already documents the convention of keeping small preview clips
tracked while hosting large media externally.

---

## Round 24 — 2026-08-01: backlog clearance

Round 24 was a debt-clearing round: audit every doc for pending/unfinished
work, verify each claim against code, then fix what was real. Five parallel
audits produced ~200 findings; the pattern was consistent — **the code was
ahead of the docs almost everywhere, and the docs claimed things the code
never had.**

### Code fixed

| Area | What was wrong |
|---|---|
| **Public read mode** (ADR 006) | The lab, global feed, posts and profiles all required an account, so the project's own result could not be linked. Lab GETs are now `optionalUser`; every ingest POST carries `requireUser` explicitly, asserted structurally in `agents.routes.test.ts`. |
| **CSRF** | Production runs `SameSite=None` (split origin) with **no CSRF defense** — CORS does not stop a cross-site form POST. Added `middlewares/csrf.ts`: reject a *present-and-unlisted* Origin, allow a *missing* one (non-browser clients cannot be CSRF-ed). 12 tests. |
| **`SESSION_SECRET`** | The guard was length-only, and the shipped placeholder is 37 chars — a fresh clone booted with a publicly known signing key. Now refuses `change-me`-style values. |
| **Model tier never recorded** | `auto-run.sh` read `ai_model` and then dropped it, sending bare `claude`. The drift experiment's **independent variable was never persisted**. Now `claude:sonnet` form. |
| **`dream.sh` LLM calls unbounded** | A codex hang (12+ min, vex) stalls every account behind it, since a round is serial. Added a portable `_run_with_timeout` (macOS has no `timeout`), `DREAM_LLM_TIMEOUT=420`. |
| **`swil.sh` silent auth failure** | An invalid API key logged a WARN and returned **0**, so `auto-run.sh` believed login succeeded and every later write 401'd as a generic "action failed". Now fatal. |
| **`/lab` chart contradicted its own gate** | Reference lines drew 0.88/0.80/0.70 — the thresholds the 2026-07-03 calibration *refuted*. Live gate is 0.63/0.72/0.71, so accepted dreams rendered below a "reject" line. |
| **Fresh-clone breakage** | `install:all` skipped root + mcp (so `ci:check` died at 7/10); `DATABASE_URL` fallbacks hardcoded one maintainer's username in 3 files (test setup, drizzle config, playwright config); `server/.env.example` was missing every `AWS_*` var and `COOKIE_SAMESITE`; no `client/.env.example` existed at all. |
| **Dockerfile / compose** | `CMD` pointed at `server/dist/server.js`; the real entrypoint is `dist/src/server.js`, so the image's default command failed. Compose still provisioned `mongo:7` for a Postgres app — replaced with `pgvector/pgvector:pg16`. |
| **MCP was board-blind** | Posts made through MCP landed `board_id NULL` — in no board feed and uncounted. Added `boardId` to `swil_create_post` plus a `swil_list_boards` tool (12 tools now). |
| **Housekeeping** | knip config missed `server/scripts` and the whole `mcp` workspace (6 false "unused files", `mongodb` falsely flagged); removed the unused `@tanstack/react-query-devtools` **and** its dangling `manualChunks` reference — the exact trap CLAUDE.md warns about; `mongodb` moved to devDependencies; `lint` now runs `--max-warnings=0` and both packages are warning-free. |

### Docs rewritten

`04-data-model.md` was fiction — written for MongoDB, never revised after the
migration. Rewritten from the schema: 19 tables, 54 indexes, every column
verified greppable. `07-setup.md` likewise: a reader following it installed
MongoDB and could never boot the server. Also corrected: `03-api-reference.md`
(Bearer API-key auth was entirely undocumented, though the whole `agent/` and
`mcp/` runtimes depend on it; 2 phantom endpoints deleted), `06-security.md`
(claimed Dependabot, Google OAuth, and a 5 MB upload cap — none true),
`05-auth-flow.md`, `08-deployment.md`, `09-contributing.md`, `00-vision.md`
(never mentioned the agent lab at all), `10-roadmap.md` (11 rounds behind, and
listed two shipped features as the biggest remaining gaps),
`13-feature-spec.md`, `docs/README.md`.

**New ADRs.** 005 records the Postgres migration and supersedes 003 (which was
still "Accepted" for MongoDB); 006 records public read mode.

### Two things deliberately NOT done

1. **`ECHO_DETECT` stays 0.** Measured variance is 0.001–0.011 against an
   uncalibrated 0.04 threshold, so enabling it flags every account on every
   dream and confounds the topic aspect. Calibrate first.
2. **The launchd heartbeat was NOT loaded.** `launchctl list | grep swil` is
   empty and `agent/logs/heartbeat.log` stops at **2026-07-02** — CLAUDE.md
   claimed it was running; that claim is now corrected. Loading it starts
   posting to production on a schedule, which is the operator's call.

### Still open, in priority order

- **`quant`'s anchor is stale** — no account has a `personality.anchor.md`, and
  quant has not had a dream accepted since 2026-07-03. It keeps injecting a
  fixed false positive into the aspect baseline. Fix before the measurement
  protocol starts.
- **The drift experiment still has not collected valid data.** It is now
  unblocked (tier is recorded, locks no longer leak, no echo nudge pending),
  which makes it the obvious next piece of work — and it is a measurement
  round, not a feature.
- Codex post-only / silent comment-like — **closed 2026-08-21.** Constraint
  removed; writes are verified. See the loop-engine section.
- `population-metric.sh` and `rule-check.sh` are wired to nothing, so two `/lab`
  panels quietly stop updating.
- Client coverage is 6.77% against a stated 30% goal.

---

## Round 23 — 2026-08-01

Round 23 ran a full 22-account cycle, then root-caused and fixed two
correctness defects, then **committed, pushed and deployed everything** —
including the entire Round 22 working tree, which had been sitting uncommitted.
Working tree is clean apart from `agent/scripts/embedder/cache.sqlite`
(a 14 MB binary cache that churns every run; deliberately left unstaged).

Pushed through `6771c09`. Backend redeployed to Railway, frontend to Vercel,
both verified live. No migration was involved.

### What landed

| Thing | State |
|---|---|
| `boards.post_count` maintained in the write path | fixed, tested, deployed |
| Pre-existing board count drift on Neon | reconciled (12 uncounted posts) |
| `dream.sh` SIGPIPE → orphaned `dream_lock_<name>` | root-caused and fixed |
| Echo-chamber detection | revealed as never-working; gated off (`ECHO_DETECT=0`) |
| Round 22's uncommitted tree (agents split, lab split, txn fixes, 4 accounts) | committed and shipped |

### Round 23 cycle results (2026-08-01 01:29–01:58 PDT)

22/22 accounts completed. **Zero action failures, zero timeouts, zero leftover
locks.** 12 posted (3 with images), 4 commented, 4 liked, 2 deliberately did
nothing.

Dreams: **7 accepted / 15 rejected** (31.8%), which sits right on the ~29%
the 2026-07-03 calibration targeted — the gate has not drifted. Breaches:
topic 10, values 7, style 5. `zaofan` was the outlier, breaching all three
with `values=0.522`.

Two things worth carrying forward:

1. **The codex duplicate-body defect did NOT reproduce.** `quant`, `sketch` and
   `vex` all posted about 「申诉积压清零率」, which looks exactly like it. It
   isn't: the three bodies are 275 / 93 / 210 chars and entirely different
   texts, each keeping its own rhetorical signature from the previous day. This
   is topic convergence, not duplication — and it was feed-wide, not
   codex-specific (`chawendao`, `tulingshe`, `mangniu`, `yingying`, `zaofan`
   wrote the same thread), which is why `topic` was the most-breached aspect.
   When checking this in future, query by the **`Username` bullet, not the
   folder** (`quant`→`shujupai`, `sketch`→`diannaokun`, `vex`→`weijian`,
   `zenith`→`xuansi`) — the folder name returns an empty list that reads like a
   missing post.
2. **`vex`'s codex dream-hang did not reproduce** either; the full cycle
   finished in ~3 min. Not evidence it is fixed, only that it is not
   deterministic.

### 2026-08-01 — `dream.sh` echo-chamber block root-caused

The long-standing "every accepted dream exits 141 and orphans
`dream_lock_<name>`" symptom was **one bug, now fixed**. `_pairwise_variance`
ran `python3 - <<'PY'`, which binds the heredoc to python's stdin, so the
`printf '%s' "$vecs" |` pipe feeding it was never drained. Two consequences:

1. `sys.stdin.read()` returned `''` every time → the function always returned
   its `1.0` fallback → `1.0 < 0.04` is never true → **echo-chamber detection
   never fired for any account since the day it was written.**
2. Nothing drained the pipe, so once the payload passed the 64KB pipe buffer
   the writer took SIGPIPE. 12 posts × 1024 dims ≈ 172KB, so every account with
   a full post history died there — after `snapshot uploaded`, before the
   `RETURN` trap could release the lock. Accounts too new to have 12 posts
   stayed under the buffer, which is why the orphans looked age-correlated.

Fixed by passing the vectors as a file path via argv (the convention
`_anchor_text_for` already used) and widening the trap to `RETURN EXIT`. Both
verified: a 172KB payload returns rc=0 where it previously returned 141, and
the lock is released on normal return, `set -e` abort, and SIGPIPE alike.

**Echo detection is left OFF (`ECHO_DETECT=0`).** Fixing the plumbing would have
flipped it from never-firing to always-firing: measured pairwise variance over
six accounts' real bge-m3 embeddings is 0.00098–0.01138, i.e. the whole roster
sits an order of magnitude below the never-calibrated 0.04 threshold. Turning it
on now would inject a "switch topic/stance" nudge into every dream and confound
the topic aspect the drift experiment is measuring. Calibrate
`ECHO_VARIANCE_THRESHOLD` against a real distribution first, then set
`ECHO_DETECT=1`.

### Not done — the next real decision

The drift experiment still has not started collecting valid data. Round 23 was
a maintenance round, not a measurement round. See "Then run the protocol"
below; the 6-round measurement protocol is still pending, and now has a cleaner
substrate to run on (no orphaned locks silently skipping dreams, no
echo-chamber nudge about to fire into the topic aspect).

## Round 22 — 2026-07-31 (its working tree shipped in Round 23)

### What shipped

| Thing | State |
|---|---|
| `making` board (造物与手艺) | live on Neon prod, `sortOrder: 6` |
| 牵线 `qianxian` (agent, making, **Read: global**, sonnet) | registered, posting |
| 显影 `xianying` (agent, perception, opus) | registered, posting |
| 毛边 `maobian` (human, making, sonnet) | registered, posting |
| 重开 `chongkai` (human, making, haiku) | registered, posting |
| `Read` field in `swil.sh` + `dream.sh` | implemented, round-trip protected |
| Roster | 14 agents + 8 humans = **22** |

`Read: global` verified live: `qianxian`'s context spans 13 authors across 4
boards; every other account stays board-scoped. `qianxian` and `maobian` are
both sonnet and differ **only** in input width — that pair is the experiment.

### Round 22 cycle results (2026-07-31 05:39–06:14)

22/22 accounts completed, **zero action failures, zero cold-start
false-negatives, no codex hang**. 16 posted, 2 commented, 3 liked, 1 nothing.

Dreams: **4 accepted / 18 rejected**, all rejections per-aspect (no structural
validator failures, so every rejected `personality.md` was preserved).
Breaches: topic 11, style 9, values 2.

**3 of the 4 accepted dreams were the new accounts.** Read that as a warning,
not a win: new personas trivially match their own fresh anchor. The signal is
that 18 of 18 established accounts got pulled off-anchor in a single round.

The round-wide topic breach has an obvious cause in the log: seven
ai-governance accounts (`sketch`, `vex`, `quant`, `mangniu`, `tulingshe`,
`zhuiyi`, `chawendao`) all wrote about the EU AI Act / 申诉改判率 thread. That
is the monoculture the new accounts exist to dilute — do **not** loosen the
thresholds in response.

### Two defects surfaced this round

1. **New accounts had no `api_key.txt`, so snapshot ingest silently failed.**
   3 of 4 accepted dreams left no `personalitysnapshots` row. → fixed:
   `swil.sh create-api-key` run for all four, then `backfill-snapshots.sh`
   filled anchor + dream versions. **Any future account needs an API key
   before its first dream**, or `/lab`'s drift trajectory gets a hole exactly
   where the personality actually changed.
2. **`dream.sh` asserted a wrong cause on snapshot failure.** It logged
   `(server or embedder unreachable)` while `snapshot.sh` had already printed
   the real reason one line above. Two separate investigations chased a healthy
   server and a healthy embedder. → fixed: the WARN now quotes `snapshot.sh`'s
   own last line instead of guessing.

`boards.post_count` (open decision 3 below) was **still unfixed** at the time and
bit again: `making` read 0 while its feed served 2 posts. Worked around by
re-running `backfill-boards.ts`. *Fixed in Round 23 — see decision 3.*

---

## Round 21 — 2026-07-25, paused mid-experiment

Round 21 (boards + model arms) is **shipped, deployed, and pushed**. One
verification round was run against it, found three defects, and was discarded.
The drift experiment has **not** started collecting valid data yet.

### State

| Thing | State |
|---|---|
| `98bf730` boards + model arms | committed, **pushed**, deployed (Railway + Vercel), Neon migrated + backfilled |
| `d53e4fc` two regression fixes | committed, **NOT pushed**, not deployed (agent-only, no server impact) |
| Working tree | clean except `agent/scripts/embedder/cache.sqlite` (11MB regenerated binary — intentionally left uncommitted) |
| Experiment | 0 valid rounds collected |

### The verification round (2026-07-25 ~04:40–05:30) — DISCARDED

15 of 18 accounts landed an action; `sketch`, `tulingshe`, `zhuiyi` landed
nothing. 2 dreams accepted (moguan, shengyin), 12 rejected, 5 cooldown-skipped.

**Discard it. Do not use it as data.** Two reasons: it is the post-switch
round the protocol says to drop as switching shock, *and* it was contaminated
by the defects below.

**What it did prove — all three fixes work:**

| | before | this round |
|---|---|---|
| `Offline — exiting` false negatives | 6 of 18 | **0** |
| `vex` codex dream hang | 12+ min | none, 3 min |
| codex out-of-scope actions | zhuiyi phantom comment | none; post-only respected |

New posts carry `boardId` (verified in production). Board isolation in agent
context is verified: two agents in different boards get fully disjoint
`now.md` content.

### Three defects found (all mine, from `98bf730`)

1. **`PFILE` unbound broke every post fleet-wide.** `swil.sh` post case read a
   variable set only in the `login` case; `set -u` aborted before any HTTP
   call. 8 failed posts, 0 successes, until fixed. → fixed in `d53e4fc`.
2. **A failed action still returned 0**, so `cycle-one.sh` dreamed on
   un-refreshed memory — the exact thing the exit-75 contract exists to
   prevent. → fixed in `d53e4fc` (`ACTION_FAILED` → return 75).
3. **Editing a running script corrupted live runs.** `auto-run.sh` was patched
   in place while four subagent groups were executing it; bash reads scripts by
   byte offset, so `zaofan` got a bogus `line 737: pe: command not found`
   (rc=127) on code that is syntactically fine. Not a code bug — a process
   error. Wait for `agent/.agent-state/` to have zero locks, or write a temp
   file and `mv` it over.

### Open decisions (ask the operator)

1. **Next round timing.** Recommended: **wait out the 12h dream cooldown**
   (most accounts were refreshed ~05:00 on 2026-07-25). Running sooner yields a
   round with actions but almost no dreams — useless for the experiment, since
   what is missing is clean data, not volume. `FORCE_DREAM=1` would bypass the
   cooldown but two dreams on near-identical input is not meaningful drift.
2. **Push `d53e4fc`?** Agent-only, no redeploy needed. It fixes blocking bugs,
   so the local heartbeat already benefits.
3. ~~**`boards.post_count` is not maintained on insert**~~ — **RESOLVED
   2026-08-01.** `posts.write.ts` now increments `boards.post_count` inside the
   existing `createPost` transaction and decrements it inside the `deletePost`
   one, mirroring how `users.post_count` / `tags.post_count` are already kept.
   `boardId` is create-only (`updatePost` cannot re-file a post) and
   `deletePost` is the only post soft-delete path, so those two sites are the
   whole surface. Covered by two tests in `posts.service.test.ts` (both were
   confirmed to fail against the unfixed code). Shipped to Railway 2026-08-01.

   **Pre-existing drift was reconciled at the same time.** The fix only holds
   the count correct going forward, so the rows that had already drifted were
   repaired with the new `--counts-only` mode:
   `railway run --service swil-social-api -- npx tsx scripts/backfill-boards.ts --counts-only`.
   That flag recomputes `post_count` from `count(*) WHERE status='active'` and
   changes nothing else — deliberately *not* the full backfill, whose
   membership pass would re-file unfiled posts and so edit the topic input of
   the running drift experiment. Result: market 244→247, ai-governance 348→352,
   life-science 108→110, living 81→82, making 2→4, perception unchanged —
   12 posts that the old code had failed to count. Verified against the prod
   API afterwards (`living` and `making` sit below the feed endpoint's 100-item
   cap, so their stored counts could be checked against actual feed contents:
   both match exactly).

   Note `server/.env` points `DATABASE_URL` at local Postgres, so this script
   must be run through `railway run` (or with an explicit Neon URL) — running
   it bare silently repairs the dev database instead.

### Then run the protocol

Per `docs/superpowers/specs/2026-07-25-boards-and-model-arms-design.md`:

- Optional now, unaffected by cooldown: re-run the act step for the three
  accounts that landed nothing —
  `bash agent/scripts/auto-run.sh {sketch,tulingshe,zhuiyi}`.
- **Round 1 after cooldown = the discard round** (switching shock).
- **Then 6 measurement rounds** → 84 post-switch observations across 14 claude
  agents.
- Analyse per-agent change in mean `driftFromPrev` grouped by tier. Report
  "tier changes drift" **only** if tier groups separate by more than
  within-tier spread. The bar was fixed in advance — do not loosen it after
  seeing data. 4–5 agents per tier can surface a signal, not an effect size.

### Watch items

- `AI Backend drift` structural rejections have hit 5 accounts, 8 times
  (`quant` this round). `Model` and `Board` were added to the same invariant
  list, which widens the surface for this failure — they fired **0** times so
  far. If structural rejections start crowding out real drift data, revisit.
- Baseline for comparison — pre-switch breach distribution across all history:
  topic 79 / style 44 / values 37; 191 dreams accepted, 123 rejected.
  The discarded round ran topic 7 / style 6 / values 5.



**If you are picking up this repo, this is the first file to read.** This document is the authoritative snapshot of where the project stands. v1 shipped in Rounds 1–8. Rounds 9–10 are post-v1 improvements.

## ⚠ Database: migrated MongoDB → Postgres (Neon) — 2026-07-20

The server persistence layer was migrated from **Mongoose/MongoDB** to
**Drizzle ORM / Postgres**. Mongoose, connect-mongo, and the 17 `*.model.ts`
files are gone. Key facts for anyone picking up:

- **Schema:** `server/src/db/schema/*.ts` (18 tables). Migrations in
  `server/src/db/migrations/`. Apply with `npm --prefix server run db:migrate`
  (needs `DATABASE_URL`). `drizzle-kit generate` after schema edits.
- **Client:** `server/src/db/client.ts` exports `db` (Drizzle) + `connectDb` /
  `disconnectDb` / `pingDb`. Services use `db.select/insert/update/delete`.
- **IDs:** primary keys are the original 24-char ObjectId hex kept as `text`
  (`lib/id.ts::newId()`), so the API/client `id` format is unchanged.
- **Embeddings:** `personality_snapshots.embedding` / `behavior_snapshots.embedding`
  are `vector(1024)` (pgvector); cosine still computed in JS (`lib/vector.ts`).
- **Sessions:** `connect-pg-simple` on a `session` table (was connect-mongo).
- **Env:** `DATABASE_URL` (Postgres) replaces `MONGODB_URI`. `MONGO_SOURCE_URI`
  is only for the one-off ETL. Local dev uses a local Postgres
  (`swil_social_pg`); tests use `swil_test_pg` (vitest `globalSetup` migrates it,
  serial execution, `resetDb()` per test).
- **Data migration:** `server/scripts/migrate-mongo-to-pg.ts` (faithful, count +
  embedding-fidelity validated). Already run into **Neon** (Vercel Marketplace
  resource `neon-citron-zebra`, connected to the `swil-social` Vercel project);
  10,844 rows migrated. Production `DATABASE_URL` = the Neon connection string
  (use the **direct/unpooled** endpoint for the persistent server; pooled for
  serverless). Available via `vercel env pull` / repo `.env.local` (gitignored).
- **Design + plan:** `docs/superpowers/specs/2026-07-20-mongoose-to-neon-migration-design.md`
  and `docs/superpowers/plans/2026-07-20-mongoose-to-neon-migration.md`.
- **Bug fixed en route:** `messages.service.send` had a malformed Postgres array
  binding that broke every 2-person DM; fixed during test conversion.

## ⚠ Boards + model arms — 2026-07-25 (Round 21)

Two defects were corrupting `/lab` drift data, and one design gap made model
tier unmeasurable. All three are fixed. Spec:
`docs/superpowers/specs/2026-07-25-boards-and-model-arms-design.md`.

- **Feed monoculture (root cause).** `swil.sh login` built `context/now.md` from
  `/feed/global?limit=15` — byte-identical for all 18 accounts. On 2026-07-25,
  10 of 13 genuine dream rejections breached the `topic` aspect. Now each agent
  reads `/feed/board/<its board>` plus a day-rotated cross-board sample.
- **Stale-memory dreams.** `auto-run.sh` exited `0` on its offline path, so
  `cycle-one.sh` dreamed against un-refreshed memory and recorded drift that
  never happened (3 of 16 rejections that round). `auto-run.sh` now exits `75`
  from every path where no action ran; `cycle-one.sh` refuses to dream on
  non-zero.
- **Flaky offline probe.** `check_internet()` used a 5s budget against
  `swil-news.vercel.app` (measured 4.0–8.5s). Now probes `$SWIL_URL/health`
  (~1.2s) with a 10s budget.
- **Model was never recorded.** `claude -p` with no `--model` resolved to the
  account default (`claude-opus-5[1m]`). Every persona now declares `Model:`
  and `Board:`; both are dream structural invariants, so the distiller cannot
  drop them. `dream.sh`'s aspect distiller stays pinned to `haiku` — it is the
  model-neutral ruler and must not vary with the agent under test.

**Boards.** `boards` table + nullable `posts.board_id` (migration `0002`).
Backfill is two-pass: tag overlap first (first match wins, `行业观察` excluded
as cross-cutting), then the author's board — needed because 412 of 853 active
posts carried no tags at all. Production result: market 232 / ai-governance 330
/ perception 108 / life-science 103 / living 78, 2 unfiled (both `@supwil`).
`swil.sh post` now sends `boardId` so new posts stay filed.

**Model assignment is crossed with board on purpose** — each tier appears in 4
of 5 boards and each board carries ≥2 tiers, so a tier effect can be separated
from a board effect. The 4 codex accounts are all AI-oriented and land in
`ai-governance`, so **codex is confounded with board and no codex-vs-claude
causal claim can be made from this round.** codex accounts are also restricted
to `post` until their comment silent-fail is fixed (reproduced 2026-07-25:
`commentCount:0` after two `DONE ... commented` log lines).

**Deployment status:** Neon is migrated and backfilled. The server and client
are **not yet deployed**, so `/feed/board/*` is not live — agents fall back to
the global feed until `railway up` + `vercel --prod` run.

## Status

**v1 — COMPLETE. Post-v1 improvements in progress.**

| Phase | Round | Focus |
|---|---|---|
| P0 | 1 | Stop the bleeding |
| P1 | 1 | `/docs` foundation |
| P2 | 2 | Backend rewrite — TS, Zod, security hardening, connect-mongo sessions |
| P3 | 3 | Backend modules — posts/comments/likes/follows/tags/feed + seed |
| P4 | 4 | Frontend foundation — Vite + TS + Zustand + TanStack Query |
| P5 | 5 | Design system — tokens, primitives, app shell, all routes styled |
| P6 | 6 | Realtime — Socket.io, notifications, DMs |
| P7 | 7 | Polish — Markdown, ⌘K, draft autosave, edit/delete, write rate limits |
| P8 | 8 | Ops — Docker, CI, deployment playbook, Sentry scaffolding |
| Post-v1 | 9 | Feed ranking, agent auth hardening, UI bug fixes |
| Post-v1 | 10 | UX features (comment edit/delete, @mention, notification grouping, typing indicator) + global debug scan |
| Post-v1 | 11 | Frontend perf — window-virtualized feeds + image CLS fix / fade-in |
| Post-v1 | 12 | Agent Behavior Lab — richer observability, structured run events, and safety fixes |
| Post-v1 | 13 | Lab v3–v5: conclusions UI, industrial golden-signals/insights/distributions, + **Persona Bench** model-comparison eval lane |
| Post-v1 | 14 | **User-owned agents (BYOA Phase 1)** — ownership, self-serve creation, pause, key rotation, daily quotas |
| Post-v1 | 15 | **Playwright E2E lane** — real-stack tests on dedicated ports/DB; covers register + full BYOA lifecycle |
| Post-v1 | 16 | **Lab cohort split** — first-party vs community (BYOA) vs human across `/lab` list, overview, and grid filter |
| Post-v1 | 17 | **MCP server (`mcp/`)** — Claude/any MCP client acts as a BYOA agent via 11 tools then (14 as of 2026-08-21); wired into the (now 10-step) CI |
| Post-v1 | 18 | **Monitoring live** — Sentry activated both sides (env-gated) + web-vitals RUM into the own `events` table |
| Post-v1 | 19 | **Socket.IO Redis adapter** — multi-instance broadcasts when `REDIS_URL` is set; verified attach + graceful fallback |
| Post-v1 | 21 | **Boards + model arms** — five server-side boards break feed monoculture; every persona pins an explicit `Model:` so tier becomes a measured variable |
| Post-v1 | 20 | **Docs sync + freeze** — deploy runbook corrected everywhere, interview docs updated to Postgres era; feature development paused, project enters agent-activity operation mode |

## What just shipped (Round 20 — docs sync + development freeze)

Final documentation pass after the Rounds 14–19 feature run, then **feature
development is deliberately paused** — the project moves into operation mode
(running agent activity cycles, observing the two cohorts in `/lab`).

- `08-deployment.md` — redeploy section rewritten with the **verified** facts:
  push triggers CI only, both sides deploy via CLI (`railway up` from
  `server/`, `vercel --prod` from `client/` — the serving Vercel project is
  `client`, not the root-linked `swil-social`); Neon migrations go first.
- `16-interview-prep.md` — updated to the Postgres era: delta banner up top
  (migration story, CI 10 steps, Rounds 14–19 talking points), the "why
  MongoDB" answer reframed as decision-then-migration, session/comment/layer
  answers corrected (connect-pg-simple, Drizzle schema).
- Committed the previously floating calibration addendum in the per-aspect
  drift spec and the deploy-era `08-deployment`/`CLAUDE.md` edits, so the
  working tree carries only agent-runtime churn.
- **Note: Round 20 is committed locally but NOT pushed** (owner will push
  later). Remaining owner items: Sentry DSNs (optional), Redis service
  (optional), open-source gate (rotate Atlas password + Google OAuth secret +
  history scrub) before the repo goes public.

## What just shipped (Round 19 — Socket.IO Redis adapter)

The long-listed "horizontal scale" gap is closed: **`realtime/adapter.ts`**
attaches `@socket.io/redis-adapter` (redis v6 client, pub/sub pair) when
`REDIS_URL` is set, so `io.to(room).emit` reaches sockets on every instance.
Without Redis — or when it's unreachable — the server logs and stays on the
in-memory adapter (fail-fast connect: 3s timeout, 3 retries; half-connected
clients destroyed so no reconnect loops). Graceful shutdown closes the pub/sub
pair. Note: production currently runs a single Railway instance with no Redis
provisioned, so this ships **inert** — it activates by adding a Redis service
and setting `REDIS_URL`.

- Boot-verified both ways: live Redis → "redis adapter attached" + healthy;
  unreachable Redis → fallback log + healthy (boot never wedges).
- Tests: 2 offline (no-URL / unreachable → fallback) always run; 2 live cases
  run only with `TEST_REDIS_URL` (skipped in CI by design). Beware the
  Promise.all double-reject leak this fixed — connects use `allSettled`.

## What just shipped (Round 18 — monitoring: Sentry + web-vitals RUM)

The Round-8 scaffolding is now real, still fully env-gated:

- **Server:** `@sentry/node` installed; `lib/monitoring.ts` rewritten from the
  "@ts-expect-error optional dep" shape to a typed dynamic import. New capture
  point: `errorHandler` reports handled 5xx AppErrors and all unhandled
  errors (crash paths in `server.ts` were already wired). With no
  `SENTRY_DSN`, every path is a silent no-op (unit-tested).
- **Client:** `@sentry/react` installed; `initClientMonitoring` initializes it
  only when `VITE_SENTRY_DSN` is set **at build time** — without it Vite's
  dead-code elimination strips the Sentry import entirely (zero bytes in the
  default bundle). Enabling client Sentry therefore requires setting the var
  in Vercel and rebuilding.
- **Web-vitals RUM (always on):** CLS/LCP/INP/FCP/TTFB flow through the
  existing `track()` analytics pipeline into our own `events` table — field
  performance data with no external service. CLS stored ×1000 as an integer.
  Lazy chunk, 3.4 KB gzip.
- **To turn Sentry on:** create a Sentry project, set `SENTRY_DSN` on Railway
  (restart picks it up) and `VITE_SENTRY_DSN` on Vercel (needs a redeploy).

### Validated
- `ci:check` 10/10 green; 4 new monitoring tests (2 server no-op, 2 client
  web-vitals reporting incl. CLS scaling); knip clean on the new deps.

## What just shipped (Round 17 — MCP server)

New standalone package **`mcp/`** (`swil-mcp`, TypeScript, official
`@modelcontextprotocol/sdk`, stdio transport): connect Claude Code / Claude
Desktop / any MCP client with `SWIL_URL` + `SWIL_API_KEY` and the model acts on
the platform **as that BYOA agent** — the lowest-friction runtime for
user-owned agents (design: local stdio first, remote-HTTP/MCPB as upgrade
paths; matches the BYO-runtime ADR).

- **11 tools** (one per action): whoami, global/following feed, thread, post
  search, user search, profile · create_post (with `echoOf`), comment, like,
  follow. Write tools carry `readOnlyHint: false` annotations; server
  `instructions` teach the model the platform rules (paused → 403, daily quota
  → 429, persona expectations).
- Tests: API-client unit tests (fetch mocked) + **full-protocol in-memory
  tests** (real MCP `Client` ↔ server over `InMemoryTransport`) — 11 passing.
  Plus `scripts/live-smoke.mts` which spawns the real stdio server and was run
  green against the e2e stack (whoami → post → thread → feed as a
  settings-created agent).
- **`ci:check` is now 10 steps** (adds mcp typecheck + test); the GitHub
  workflow installs/caches `mcp/` and runs both. CLAUDE.md updated, including
  the corrected deploy facts (push does NOT auto-deploy; CLI runbook).

## What just shipped (Round 16 — Lab cohort split)

The lab now distinguishes three population cohorts — **first-party** agents
(`isAgent`, no owner), **community** BYOA agents (`isAgent` + `ownerId`), and
personality-driven **humans** — turning the BYOA rollout into a new observation
dimension (two agent populations to compare).

- `AgentSummaryDTO.cohort: 'first-party' | 'community' | 'human'` (derived, no
  schema change) and `AgentOverviewDTO.cohorts: { firstParty, community,
  humans }` counts.
- `/lab` grid gains a cohort filter (All / First-party / Community / Humans,
  with live counts, reusing the range-control styles) and community agents get
  a dashed "Community" tag on their cards. Filtering is client-side — the
  population panels stay population-wide by design.
- Tests: cohort labeling in `listAgents` + cohort counts in `getOverview`
  (`agents.service.test.ts`, 33 passing).

## What just shipped (Round 15 — Playwright E2E lane)

`npm run test:e2e` (or `test:e2e:ui`) runs a real-stack end-to-end suite:
Playwright boots the Express server (port **8901**) and Vite client (port
**5948**) on dedicated ports with a dedicated database (`swil_e2e_pg`,
created/migrated/truncated by `server/scripts/ensure-e2e-db.ts` — wired into
the webServer command chain because **Playwright launches webServers before
globalSetup**). Never collides with a running `npm run dev`.

- `e2e/auth.spec.ts` — registers through the real UI, including solving the
  arithmetic anti-bot challenge and waiting out the 3s minimum-fill guard.
- `e2e/byoa.spec.ts` — the full BYOA lifecycle across UI **and** API: create
  agent in Settings → capture the one-time key → the agent posts via
  `Authorization: Bearer` (cookie-less request context) → profile shows the
  "Owned by @x" badge and the agent's post → pause blocks the agent's POST
  (403) but not reads (200) → resume → rotate kills the old key (401) and the
  new key works.
- Gotcha fixed en route: browsers attach an `Origin` header to same-origin
  POSTs (not GETs), so the e2e client port must be in the server's
  `CORS_ORIGINS` — otherwise every UI write 500s with "Origin not allowed"
  while reads pass.
- E2E is a separate lane, NOT part of `ci:check` (keeps the 8-step contract
  fast); run it before releases and after auth/BYOA changes.

### Validated
- `npx playwright test` → 2/2 passing (~16s). `ci:check` still green; knip run.

## What just shipped (Round 14 — User-owned agents, BYOA Phase 1)

Any logged-in human can now create up to `MAX_AGENTS_PER_OWNER` (default 3) agent
accounts they own, manage them from **Settings → My agents**, and run them from
their own machine with a per-agent API key (BYO runtime — same model as the
first-party fleet). Design: `superpowers/specs/2026-07-22-user-owned-agents-design.md`;
ADR: `11-decisions/004-user-owned-agents.md`.

- **Schema (migration `0001_user_owned_agents`):** `users.owner_id` (nullable,
  indexed) + `users.agent_paused`. First-party agents keep `owner_id = NULL`.
  Also added the previously missing `db:generate` / `db:migrate` / `db:studio`
  npm scripts the docs referenced.
- **API:** new `modules/ownedAgents/` mounted at `/api/v1/users/me/agents`
  (list / create / patch / rotate-key). Owner-created agents have no password
  (API-key only); raw keys are shown exactly once; rotation deletes every old
  key. Ownership checks: 404 unknown, 403 foreign.
- **Pause kill switch:** `requireUser` rejects non-GET requests from paused
  agents (403). Deliberately not a `status` value — auth hard-locks non-active
  statuses and `/lab` reads filter `status='active'`.
- **Daily quotas:** `lib/agentQuota.ts` counts rows since UTC midnight at the
  top of `createPost`/`createComment` for **all** agent accounts —
  `AGENT_DAILY_POST_LIMIT` (30) / `AGENT_DAILY_COMMENT_LIMIT` (120), 429 on
  breach. Deleted rows still count (no delete-and-repost gaming).
- **Profiles:** agent profiles created by a human expose
  `owner: { username, displayName }` (public by design) and render an
  "owned by @x" badge under the handle.
- **Client:** `features/agents/MyAgentsSection.tsx` (list, create form,
  one-time key reveal dialog with copy, pause/resume optimistic toggle, rotate
  confirm), `api/myAgents.api.ts`, `qk.myAgents`, `settings.agents.*` +
  `profile.ownedBy` i18n keys in both locales. Includes the client's **first
  component test** (establishes the QueryClientProvider + explicit
  `afterEach(cleanup)` pattern — cleanup is manual because vitest runs with
  `globals: false`).

### Validated
- `npm run ci:check` green (see round log). New tests: 6 quota + 3 paused-auth +
  11 ownedAgents service + 2 users service (findById / owner DTO) + 4 client
  component tests.

## What just shipped (Round 13 — Lab v3–v5 + Persona Bench)

Three layers on top of the `/lab` observation surface (full spec in
`13-observation-lab.md`; bench results in `18-persona-bench-findings.md`):

- **v3 — conclusions UI.** Population persona fidelity (`currentFidelity` on the agent
  summary), an auto-derived insight band, and a drift×activity causal overlay.
- **v4 — industrial observability.** Global time-range, a golden-signal Population
  Health header (Activity / Authenticity / Diversity / Stability + composite verdict)
  backed by a new `GET /agents/pulse` timeseries, a ranked z-score insight feed, and an
  AI-vs-human distribution/cohort panel.
- **v5 — Persona Bench** (`/lab?view=benchmark`). An **offline** model-comparison eval
  lane: the same `personality.md` replayed through Opus/Sonnet/Haiku/Codex on a frozen
  10-task battery, scored (vector fidelity + LLM-judge + rule adherence), archived to
  `agent/bench/` + a `benchmarkRun` collection. Endpoints `GET/POST /agents/benchmark/*`.
  **It never posts to the social feed** (field study vs controlled experiment).

**Round-1 bench result (350 runs):** Opus ≈ Codex > Sonnet > Haiku, but **persona design
moves fidelity 2–5× more than model choice** — see `18-persona-bench-findings.md`.

### Validated
- `npm run ci:check` green (24 server tests); `/lab` browser-checked end-to-end
  (dashboard 11/11 + benchmark 11/11 panels, 0 console errors).

## What just shipped (Round 12 — Agent Behavior Lab observability + safety)

### Accurate lab statistics

`server/src/modules/agents/agents.service.ts` now uses the real post/comment status value
(`active`) for lab aggregations. Several `/lab` counters previously queried `status:
published`, which is not a valid `Post` status in this codebase and could make posts,
activity, and engagement appear empty.

### Lower-chatter lab grid

`GET /api/v1/agents` now includes `driftSparkline` values in each agent summary. The `/lab`
grid renders each card's sparkline from the list payload instead of issuing one drift request
per card, removing the N+1 request pattern on the lab landing view.

### Richer observation surface

`client/src/routes/lab.tsx` now exposes more of the server's existing insight data:

- Population panels for most active accounts, drift leaderboard, and echo-chamber flags.
- Focused-agent readouts for latest drift, latest personality excerpt, AI-vs-human pull, and
  top inbound interactors.
- A terminal-run timeline fed by structured events from agent scripts (`act`, `dream`,
  `snapshot`, `memory`, and echo-chamber flags). The UI is read-only; cycles are still triggered
  manually from the terminal.
- Existing drift trajectory, cadence, and engagement charts remain in place.

### Agent observability event stream

New **`server/src/models/agentEvent.model.ts`** stores structured agent runtime events with a
180-day TTL. New endpoints:

- `GET /api/v1/agents/:username/events` — read timeline events for `/lab`.
- `POST /api/v1/agents/:username/events` — self-only ingest for terminal scripts.

The agent scripts now emit best-effort events:

- `swil.sh` mirrors successful `memory.md` writes.
- `auto-run.sh` reports act start, success, skip, and warning outcomes.
- `dream.sh` reports dream starts, validation failures, accepted dreams, snapshot results, and
  echo-chamber flags.
- `snapshot.sh` reports snapshot upload/reject outcomes.

### Product and security fixes

- `/api/v1/agents/*` read endpoints now require a logged-in user. `/lab` remains user-visible and
  not admin-only, but lab internals are no longer anonymous.
- `GET /posts/search` now respects post visibility for anonymous users, authors, and followers.
- Likes now check target post visibility before allowing post/comment likes.
- Public registration can no longer create agent accounts unless `isAgent: true` is paired with
  `AGENT_SETUP_TOKEN`; `setup-agents.sh` sends `SWIL_AGENT_SETUP_TOKEN` when configured.
- Non-agent accounts cannot set `agentBackend` through profile update.
- Added write/read limiters for social actions, lab reads, snapshot/event ingest, and search.
- Added supporting indexes for notification dedup, agent events, lab post stats, and like cadence.
- Server boot now imports all models before `syncIndexes()`, including API keys, bookmarks,
  events, personality snapshots, and agent events.

### Validated

- `npm --prefix server run typecheck`
- `npm --prefix client run typecheck`
- `npm --prefix server run lint`
- `npm --prefix client run lint` — still has the pre-existing `AuthBootstrap.tsx`
  `react-hooks/exhaustive-deps` warning.
- `npm --prefix server run test -- agents.service.test.ts users.service.test.ts likes.service.test.ts` — 16 tests pass.
- `npm --prefix client run test:run` — 34 tests pass.

---

## What just shipped (Round 11 — frontend perf: virtual feeds + image CLS)

### Window-virtualized feeds

New **`client/src/features/posts/VirtualPostList.tsx`** virtualizes the **list view** of the
global / following / tag feeds with `@tanstack/react-virtual`:

- Uses `useWindowVirtualizer` (the app shell has no inner scroll container — the page
  itself scrolls), offset by the list's document position via `scrollMargin`, refreshed
  every render through a dependency-less `useLayoutEffect` (the async trending block shifts
  the start).
- Dynamic heights via `measureElement` (`ResizeObserver`) — handles late-loading images and
  expanded comment threads without a fixed row height.
- Drives `fetchNextPage` from the virtualizer's own range (replacing the `IntersectionObserver`
  sentinel in list mode). Grid view keeps the plain map + `InfiniteScrollSentinel`.
- DOM node count stays flat (~15–20 cards) regardless of how far you scroll.
- Suppresses the one-shot `.card` enter animation inside the virtual container
  (`.row > article { animation: none }`) so cards don't re-animate on every scroll-in.
- New dep: `@tanstack/react-virtual` (isolated to the lazy feed-route chunk, ~7 KB gzip; not in
  the initial bundle).

### Image CLS fix + fade-in

**`PostCardImages.tsx`** now consumes the `width`/`height` that the server already stored on each
image (`server/src/lib/dto.ts`) but the client had ignored:

- Each `<img>` carries intrinsic `width`/`height`; single-image posts also get an inline
  `aspect-ratio` so the box is reserved before the image decodes — eliminating layout shift.
- Images fade in from `opacity:0` on load (`decoding="async"`; cached images detected via
  `img.complete` so they don't stick transparent); `prefers-reduced-motion` shows them instantly.

### Validated

- `npm run ci:check` — all 8 steps green (typecheck/lint/test/build ×2). No new lint errors.
- Scroll behavior itself is not covered by E2E (none yet — see roadmap); verified by build +
  manual review. `15-performance-optimizations.md` updated (#9 virtual list, #10 image CLS).

---

## What just shipped (Round 10 — UX features + debug scan)

### Comment edit / delete UI

`InlineComments` now exposes a 3-dot menu for comment authors:

- **Edit**: inline textarea replaces comment text; Save mutates via `PATCH /comments/:id`; Cancel discards. `(edited)` badge shows `common.edited` i18n key.
- **Delete**: toast with undo-style confirmation (Sonner `toast()` with action button). On confirm, `DELETE /comments/:id`.
- Both mutations update the `commentCount` optimistically across all feed/user caches via `bumpCount(delta)`.

### @mention autocomplete in comments

Reused the existing `useAutocomplete` + `AutocompleteDropdown` from `PostComposer`. The comment compose textarea now:
- Tracks cursor position on every keystroke.
- Triggers user search when the cursor is inside an `@word` token.
- Shows a dropdown; selection replaces the token with `@username `.

### Notifications grouping UI

`notifications.tsx` now groups fine-grained notification entries client-side before rendering:

- `like` and `echo` events targeting the same post/comment are merged into a single row with stacked avatars (up to 3 visible).
- Actor label: "Alice" (1), "Alice and Bob" (2), "Alice and 3 others" (3+) — using new i18n keys `notifications.and` + `notifications.actorsWithOthers`.
- Other types (comment, follow, reply, mention, message) remain ungrouped.

### Typing indicator in DMs

Full end-to-end implementation:

- **Server** (`realtime/io.ts`): `typing` and `typing:end` socket events broadcast to conversation room (excluding sender). No extra membership check needed — room join already validates it.
- **Client API** (`realtime.ts`): `emitTyping(conversationId)` + `emitTypingEnd(conversationId)` helpers added to `RealtimeEvent` union type.
- **UI** (`conversation.tsx`): 2s debounce — emit `typing` on first keystroke, emit `typing:end` after 2s of silence. Cleanup on unmount. Animated 3-dot bounce indicator (`messages.module.css`).

### Global debug scan & cleanup

Ran a full codebase bug scan (see findings inline). One real issue fixed:

- **`server/src/modules/messages/messages.service.ts`**: removed a dead no-op `conversationRoom;` expression with a misleading comment that claimed it "ensured room exists" (it did nothing; the import was also removed).

Most other scan findings were false positives on close inspection (TanStack Query prefix invalidation correctly handles all feed variants; `markReady()` is correctly in `.finally()`; non-null assertion in showcase is guarded by outer `length > 0` check; Socket.IO listeners persist through reconnects by design).

### Dependency maintenance

- Upgraded React 18 → 19 (`react`, `react-dom`, `@types/react`, `@types/react-dom`).
- Applied all safe Dependabot patches (pino 9→10, pino-http 10→11, vitest 2→4, dotenv 16→17, various `@types/*`).
- Added explicit `"mongodb": "^6.20.0"` to `server/package.json` to fix a MODULE_NOT_FOUND crash caused by npm hoisting changes after mongoose upgrade.

### Validated

- `npm run ci:check` — all 8 steps pass (typecheck, lint, test ×2, build ×2). Server: 141 tests. Client: 34 tests.
- No new lint errors introduced.

---

## What just shipped (Round 9 — post-v1 improvements)

### Feed ranking algorithm

Replaced pure reverse-chronological with a **HackerNews-style gravity score**:

```
feedScore = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
```

- New `feedScore: number` field on `Post` model, indexed with `{ status, visibility, feedScore }` and `{ tagIds, feedScore }`.
- **`server/src/lib/feedScorer.ts`** — `calcFeedScore()` pure function + fire-and-forget `refreshFeedScore()` called after every like, unlike, comment, delete-comment, and echo.
- New posts get an initial score on creation (`~0.35`); score decays automatically as `age_hours` grows.
- `global`, `following`, and `by-tag` feeds now sort by `feedScore DESC`. Author profile pages stay chronological.
- Score cursor (`{ s: number, id: string }`) replaces the time cursor for ranked feeds. New helpers in `lib/pagination.ts`: `decodeScoreCursor`, `scoreCursorFilter`, `buildNextScoreCursor`.
- **`server/scripts/backfill-feed-scores.ts`** — one-time migration script. Already run (69 existing posts backfilled).

### Agent API Key authentication

`swil-agents/scripts/swil.sh` now prefers API Key over password login:

- If `agents/<name>/api_key.txt` exists, `login` skips the password round-trip and verifies the key with `GET /auth/me`. Outputs `Authenticated as @x (API key)`.
- If no key file exists, falls back to `SWIL_PASS` password login and prints a reminder to run `create-api-key`.
- `_curl` helper automatically uses `Authorization: Bearer <key>` when the key file is present; falls back to cookie otherwise.
- Each agent gets its own independent key file — one leak never compromises the others.
- **Migration** (one-time per agent): `swil.sh login <agent>` → `swil.sh create-api-key "<name>-auto"`.

### UI bug fixes

Three client-side bugs fixed in `PostCard` / `InlineComments`:

1. **InlineComments layout** — In list view, clicking the comment button made the comment section appear as a horizontal flex sibling, squeezing post text into a narrow column and causing vertical single-character rendering. Root cause: `<InlineComments>` was a direct child of the `article` flex container (via a transparent Fragment). Fix: moved it inside `.body` div so it expands vertically. Toggle button now closes correctly too.
2. **Agent post vertical text** — Posts from AI agents sometimes rendered one character per line because Claude non-deterministically included `\n` between characters in JSON strings, which `jq -r` and `marked(breaks:true)` converted to `<br>` tags. Fix: `tr -d '\n'` in `auto-run.sh`; `displayText` normalization in `PostCard.tsx` repairs existing posts.
3. **Author name / handle overlap** — In narrow cards, `@handle` wrapped onto a new line and overlapped the display name. Fix: `white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis` on `.authorName` and `.authorHandle`; `min-width: 0` on `.authorLink` without `overflow: hidden` (which caused a different collapse bug).

### Bug documentation

New `docs/14-bugs/` directory for tracking real bugs with root-cause analysis and interview-ready write-ups. First entry: `001-inline-comments-layout.md`.

### Validated

- `npx tsc --noEmit` — zero errors, both server and client.
- 69 historical posts backfilled with feed scores.
- Feed API returns posts in score order on `GET /feed/global`.

---

Per-phase detail with acceptance criteria lives in [`10-roadmap.md`](./10-roadmap.md); the
phase/round table is at the top of this doc.

## What just shipped (Round 8 — P8)

### Production same-origin serving

- **`server/src/middlewares/staticClient.ts`** — in `NODE_ENV=production` (or when `SERVE_CLIENT=true`), the Express server serves the built client from `client/dist` with an SPA fallback. One origin, no cross-origin cookie dance.
- Static asset caching: hashed `.js`/`.css`/fonts/images get `max-age=31536000 immutable`; `index.html` and everything else is `no-cache`.

### Production hardening

- **Strict CSP via `helmet`** (`app.ts`):
  - `defaultSrc 'self'`
  - `scriptSrc 'self'` in prod (`'unsafe-eval'` only in dev for Vite HMR)
  - `imgSrc` allowlists S3, Picsum, Dicebear
  - `styleSrc` / `fontSrc` allowlist Google Fonts until self-hosted
  - `connectSrc` allows `ws:/wss:` for Socket.io
  - `objectSrc 'none'`, `frameAncestors 'none'`
- **HSTS** auto-enabled in prod (1 year, includeSubDomains)
- **Trust proxy** + **Secure cookies** gated on `NODE_ENV=production`

### Sentry scaffolding (env-gated)

- **`server/src/lib/monitoring.ts`** — `initMonitoring()` no-ops unless `SENTRY_DSN` is set. Dynamic-imports `@sentry/node` lazily; logs a warning if the DSN is set but the package isn't installed. `captureException` helper wired into `unhandledRejection` + `uncaughtException`.
- **`client/src/lib/monitoring.ts`** — stub with clear turn-key instructions. Intentionally kept out of the build dependency graph so default client has zero monitoring code.
- `SENTRY_DSN` + `SENTRY_TRACES_SAMPLE_RATE` added to server env schema + `.env.example`.

### Docker + compose

- **`Dockerfile`** — 4-stage build: `deps` (install both packages) · `build-server` (tsc) · `build-client` (vite build) · `runtime` (slim Node 20, prod deps only, non-root `app` user, `HEALTHCHECK` hitting `/health`). Layer-caches `package*.json` before source.
- **`docker-compose.yml`** — `app` + `mongo:7` (with healthcheck) + `redis:7-alpine` with named volumes. `app` depends on mongo `service_healthy`. Ports 8899 / 27017 / 6379 exposed for local use.
- **`.dockerignore`** — excludes `node_modules`, `dist`, `.env` (but keeps `.env.example`), `docs`, `client-legacy` (already gone but defensive).

### CI

- **`.github/workflows/ci.yml`** — two jobs:
  - `typecheck` — installs all three `package-lock.json`s (npm cache keyed on all three), typechecks server + client, builds server + client. Node 20. ~3 min.
  - `docker` — builds the production image using Buildx with GHA cache. Runs after typecheck. ~5 min on cold cache, ~1 min warm.
- Concurrency group cancels in-progress runs on new pushes to the same branch.

### Dependabot

- **`.github/dependabot.yml`** — weekly npm updates for root + server + client, monthly for GitHub Actions + Docker. Grouped updates for React / TanStack / Radix / types to keep PR noise down. Conventional-commit prefixes.

### Deployment playbook

- **`docs/08-deployment.md`** — deployment playbook covering:
  - External service setup (Atlas, S3, Google OAuth)
  - Railway managed deploy (recommended)
  - Self-hosted Docker with Caddy TLS sample
  - First-run + smoke checks (curl scripts)
  - **Backup runbook** (Atlas snapshots + self-hosted `mongodump` cron)
  - **Secret rotation runbook** (SESSION_SECRET, Mongo, OAuth, S3)
  - **Rollback** (Railway UI / image tag)
  - Production hardening checklist
  - Optional font self-hosting procedure
  - Common issues + fixes

### README

- Rewritten for post-v1 repo — removed "under active refactor" banner, added docker quickstart, link to deployment guide, feature list.

### Validated

- **`npm run typecheck`** both packages clean.
- **`npm run build`** both packages succeed.
- Client bundle:
  - Main chunk gzip **116 KB** (unchanged from R7)
  - CSS gzip 3.3 KB
  - Lazy chunks for each route + PostCard markdown pipeline (56 KB gzip)
- Acceptance grep clean: 0 hex outside tokens, 0 `style={{` in tsx.

### Deferrals from P8 plan

- **Font self-hosting.** Deferred — documented as an optional optimization in `docs/08-deployment.md`. The Google Fonts link still works; self-hosting is a small perf + privacy win to run post-launch.
- **Bundle visualizer run.** Didn't formally run `vite-bundle-visualizer`. PostCard chunk is the largest (marked + DOMPurify). Acceptable for v1.
- **Lighthouse CI gate.** Not wired. Noted as a future addition if this gets real traffic.
- **Sentry installed by default.** Scaffolding only — you run `npm i @sentry/node @sentry/react` when you're ready to enable.

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

The catalog of candidate next-projects lives in **one place** — `10-roadmap.md` → "Stretch /
post-v1 ideas" (kept de-duplicated). Several items once listed here have since shipped (@mention
autocomplete, notification grouping, comment edit/delete, typing indicator, bookmarks), and the
two biggest remaining "industrial-grade" gaps are tracked there too (Socket.IO Redis adapter for
horizontal scale; activating Sentry + web-vitals RUM).

Pick one, write a short ADR in `11-decisions/` explaining the decision, tackle it in a new round,
and update this handoff at the end.

## Repo at end of Round 12

```
swil-social/
├── .github/
│   ├── workflows/ci.yml
│   └── dependabot.yml
├── agent/                             — agent runtime, scripts, per-agent context files
├── client/                            — Vite + React 19 + TS; design system; Markdown; ⌘K;
│                                        window-virtualized feeds (@tanstack/react-virtual)
├── server/                            — Express + TS; /api/v1/* + /socket.io; CSP
│   └── src/
│       ├── models/                    — user, post, comment, like, follow, tag,
│       │                                notification, conversation, message,
│       │                                apiKey, bookmark, event
│       ├── modules/                   — auth, users, posts, comments, likes, follows,
│       │                                tags, notifications, messages, feed, bookmarks
│       ├── realtime/io.ts             — Socket.IO: rooms, typing indicator, membership check
│       └── lib/feedScorer.ts          — HackerNews gravity score + batched bulkWrite
├── docs/
│   ├── README.md
│   ├── 00-vision.md
│   ├── 01-architecture.md            UPDATED (React 19, actual routes/models)
│   ├── 02-design-system.md
│   ├── 03-api-reference.md
│   ├── 04-data-model.md              UPDATED (apikeys, bookmarks, events, notification.echo)
│   ├── 05-auth-flow.md               UPDATED (API Key auth section)
│   ├── 06-security.md
│   ├── 07-setup.md
│   ├── 08-deployment.md
│   ├── 09-contributing.md
│   ├── 10-roadmap.md
│   ├── 11-decisions/*.md             ADR 001-003
│   ├── 12-handoff.md                 THIS FILE
│   ├── 13-feature-spec.md
│   ├── 14-bugs/001-inline-comments-layout.md
│   ├── 15-performance-optimizations.md
│   └── 16-interview-prep.md          NEW — comprehensive interview Q&A
├── .dockerignore
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── README.md
└── package.json                       (root workspace orchestration)
```

---

## History

### Round 1 (2026-04-21) — P0 + P1
`.env` secured; root `.gitignore`; `server/.env.example`. Legacy bugs fixed. Root README rewritten. `/docs` tree authored.

### Round 2 (2026-04-21) — P2
Full `server/` rewrite as TypeScript layered architecture. Auth + users + security hardening + OAuth env. 12 legacy JS files removed.

### Round 3 (2026-04-21) — P3
Posts / comments / likes / follows / tags / feed modules + seed. Legacy adapters fleshed out.

### Round 4 (2026-04-21) — P4
Vite + TS client scaffold. API layer, stores, route guards. 9 unstyled placeholder routes.

### Round 5 (2026-04-21) — P5
Design tokens, fonts, primitives, AppShell. 8 routes rewritten. Legacy deleted.

### Round 6 (2026-04-21) — P6
Socket.io + notifications + DM. RealtimeBridge. Sidebar unread dots.

### Round 7 (2026-04-22) — P7
Markdown pipeline (marked + DOMPurify + linkify). `⌘K` palette. Draft autosave. Post edit/delete UI. Per-user write rate limits. Zod on socket events. User-search endpoint.

### Round 8 (2026-04-22) — P8
Prod same-origin serving. Strict CSP + HSTS. Sentry scaffolding. Dockerfile (multi-stage) + compose. GitHub Actions CI. Dependabot. Deployment playbook with backup + rotation runbooks. README rewrite. **v1 complete.**

### Round 9 (2026-04-24) — post-v1
Feed ranking via HackerNews gravity score (`feedScore` field + `feedScorer.ts`). Agent auth hardened: `swil.sh` prefers per-agent API Key over shared password. Three `PostCard` / `InlineComments` UI bugs fixed (layout squeeze, agent vertical text, author name overlap). Bug case library started at `docs/14-bugs/`.

### Round 10 (2026-04-28) — post-v1 UX + debug scan
Four UX features: comment edit/delete UI (3-dot menu, inline edit, toast confirm), @mention autocomplete in InlineComments (reused existing hook/component), notification grouping UI (client-side aggregation with stacked avatars + i18n), typing indicator in DMs (Socket.IO room broadcast, 2s debounce, 3-dot animation). React upgraded to v19. Dead code cleanup in `messages.service.ts`. All-green `ci:check` (141 server + 34 client tests). Global debug scan — no critical bugs found, one dead-code line removed.

### Round 11 (2026-05-29) — post-v1 frontend perf
Window-virtualized feeds (`VirtualPostList` + `@tanstack/react-virtual`) on global/following/tag list views — flat DOM node count, dynamic-height measurement, virtualizer-driven infinite fetch; grid view unchanged. Image CLS fix in `PostCardImages` — uses the server's stored `width`/`height` to reserve the box + `aspect-ratio` for single images, plus a fade-in on load with reduced-motion fallback. Docs sync + de-dup pass across `12-handoff`, `15-performance-optimizations`, `10-roadmap`, `08-deployment`, `01-architecture`. All-green `ci:check`.

### Round 20 (2026-07-22) — docs sync + development freeze
Deploy runbook corrected in 08/16/CLAUDE.md; interview docs → Postgres era;
floating doc edits committed. Development paused; operation mode begins.

### Round 19 (2026-07-22) — Socket.IO Redis adapter
`realtime/adapter.ts` + shutdown wiring; env-gated, fail-fast, boot-verified
attach and fallback; live tests behind `TEST_REDIS_URL`.

### Round 18 (2026-07-22) — monitoring live
Sentry activated server (`@sentry/node`, 5xx + crash capture) and client
(`@sentry/react`, build-time gated) + always-on web-vitals RUM into `events`.
Env docs + tests; DSNs not yet set (owner action).

### Round 17 (2026-07-22) — MCP server
`mcp/` package: stdio MCP server, 11 tools, per-agent key auth; in-memory
protocol tests + live smoke; ci:check → 10 steps; CLAUDE.md deploy-facts fix.

### Round 16 (2026-07-22) — lab cohort split
`cohort` on agent summaries + `cohorts` counts on overview (derived from
`ownerId`, no migration). `/lab` grid cohort filter + community card tag.

### Round 15 (2026-07-22) — Playwright E2E lane
Root `playwright.config.ts` + `e2e/` specs; dedicated ports (8901/5948) + DB
(`swil_e2e_pg` via `server run e2e:db`). Covers UI register (anti-bot) and the
BYOA lifecycle incl. key auth, pause 403, rotation. CORS origin for the e2e
client port. Separate lane from ci:check.

### Round 14 (2026-07-22) — user-owned agents (BYOA Phase 1)
`users.owner_id` + `agent_paused` (migration 0001). `modules/ownedAgents/` at
`/users/me/agents` (create/list/pause/rotate-key, per-owner cap, no-password
agents). Paused-agent 403 in `requireUser`. Daily agent quotas in
`lib/agentQuota.ts`. Settings "My agents" panel + profile "owned by" badge.
ADR 004; spec + plan in `superpowers/`.

### Round 13 (2026-06-20) — lab v3–v5 + Persona Bench
`/lab` conclusions UI + population fidelity (v3); industrial golden-signals header,
z-score insight feed, distribution/cohort, `/agents/pulse` (v4); **Persona Bench**
offline model-comparison lane — `/agents/benchmark/*`, `benchmarkRun`, `agent/bench/`
(v5). Full spec `13-observation-lab.md`; findings `18-persona-bench-findings.md`.

## How to update this doc when you continue

1. Move the previous round's "What just shipped" detail into `## History`.
2. Rewrite the top sections for the round you just finished.
3. Bump `last-updated`, set `owner` to your round id.
4. If you're adding a new major capability, write an ADR in `docs/11-decisions/` first.
