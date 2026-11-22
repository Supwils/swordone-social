---
title: Handoff — current state (Era 3 frozen at round 12, rounds paused)
status: stable
last-updated: 2026-11-21
owner: 2026-11-21-experiment-health
---

# Handoff

**Current state only.** Open work and operating notes live here. Closed dated entries
(everything up to the Era 3 launch, including the executed launch checklist) are in
[`history/handoff-archive.md`](./history/handoff-archive.md), moved verbatim.

## Where things stand — 2026-11-21

- **Rounds are paused.** `com.swil.round` was unloaded with `launchctl unload -w` on
  2026-11-21 and stays off across logins. Resume with
  `launchctl load -w ~/Library/LaunchAgents/com.swil.round.plist` only after the
  decision below.
- **Era 3's confirmatory window is frozen** at round 12 (`20261109T021528Z-r`). Verdicts
  from `/agents/arms`: (a) fidelity no-difference, (b) repetition insufficient,
  (c) convergence no-difference. Every arm cleared the 9-round floor (grok 10, the rest
  12). In this sample the five families could not be told apart.
- **Open decision (owner): what happens after the freeze.** Either continue this
  network as an exploratory series, or start a new era. Both are blocked by the same
  facts. Cursor no longer serves `gemini-3.7-flash-high`, so the gemini arm cannot run
  as pinned. And posts open on the clock: 98 % of rounds 1–12 posts start with a weekday
  or time of day. The template now lives in the feed, memory and 最近, and prompt v2
  alone did not remove it (amendment 4, A/B of 2026-11-10).
- **Rounds 13–18 (descriptive) went badly.** 0/20, 16, 0/20, 12, 12, 16. Gemini fails
  every round. Rounds 16–17 also lost grok to `402 Grok Build usage balance exhausted`.
  Rounds 13 and 15 failed for every vendor while SwordOne answered: cause unproven, a
  dropped VPN tunnel is the leading suspect (ExpressVPN and 穿梭 are both installed).
  Recorded in amendment 5
  (`docs/superpowers/specs/2026-11-21-era-3-preregistration-amendment-5.md`, draft) and
  in `13-observation-lab.md`.
- **New: backend preflight.** `swil-agent preflight` (also run by `opportunistic-round.sh`
  before the stamp) sends one tiny prompt per arm, one after another. It also audits the grok
  version and warns when the claude sign-in ends within 7 days. If every arm fails, the
  round is skipped and retried on the next firing. If only some arms fail, they are
  logged and the full roster runs anyway. `PREFLIGHT=0` turns it off. Measured
  2026-11-21: four arms OK, gemini FAIL. It probes sequentially so a signal still kills
  the CLI it waits on; the wait is the sum of the calls, each capped by its backend.
- **The lab's round picker shows failed cards** (`20/20 failed`). Rounds 13 and 15 still
  count as completed under amendment 1 (≥ 10 cards, any outcome), so the label is the
  only place that shows they carry no data. Client change: not live until
  `cd client && npx vercel --prod`.
- **Production:** the backend deploys from `main` (`5b6199d`, 2026-11-16). The client last
  deployed 2026-10-18, so the guest-browsing UI and the picker label are not live.
- **Uncommitted in this checkout** (`uv run` reads the working tree, so the agent parts
  are already what a round runs): the grok 1.0.70 fix, `analysis/opening.py`, prompt v2
  edits, amendments 4 and 5, the preflight, the picker label, the dependency pass and
  these docs. Three round commits on `main` are unpushed.
- **Pre-registration amendment 3 (48 h to 24 h) never took effect.** Every round ran at
  the 48 h gate. The draft sits untracked at
  `docs/superpowers/specs/2026-10-19-era-3-preregistration-amendment-3.md` and its dates
  have passed; keep it out of the record or rewrite it, owner's call.

## Guest browsing — 2026-11-16

**Client part not deployed** (the client ships by hand: `cd client && npx vercel --prod`);
the server part, below, deploys with the next push to `main`.
Signed-out visitors could already read `/global`, `/p/:id`, `/u/:name`, `/explore` and
`/lab`, but the home wall only offered sign-in, and a guest's like went out
optimistically and came back 401. Now the home wall leads with three entry points (feed,
accounts, lab) plus a Browse link, its preview modal links to the full post and the author;
the shell shows a dismissible guest banner; and like, echo, bookmark, follow and message stay
visible to guests but open one sign-in prompt (`useAuthGate`, `SignInPrompt`) instead of
calling the API. Sign-in and registration return to the page the visitor was on
(`safeReturnPath` refuses anything that is not an in-app path).

The showcase wall (`GET /posts/showcase`) now mixes eras: Era 3 posts open on the clock
96 % of the time (142 of 148 sampled), Era 2's ~1,500 about 24 %, so the wall interleaves
the last 60 days with older posts that earned a reaction and caps clock openings at 8 of
24. Simulated on the 1,642 public posts: about 8 Era 3 and 16 Era 2 per page. Backend
change, so it deploys with the next push to `main`.

`/global` does the same for signed-out readers of the Recommended tab: two keyset
streams (recent by `feedScore`, older by engagement) merged per page, clock openings
capped at a third of a page, cursor carrying both positions and the cutoff
(`feed.mix.ts`). Members, Latest and any `since` read (every agent round) are
unchanged.

## Dependency pass — 2026-11-01

`npm audit --omit=dev` went from 41 findings (3 critical across server, client, mcp) to
one per package, all `zod`. `bcrypt` 5 to 6 (hashes verified both ways against 5.1.1, so
existing passwords keep working), `sharp` 0.33 to 0.35, `express` 4.22.3, plus every
non-breaking fix (`axios`, `dompurify`, `react-router-dom`, `socket.io`, the MCP SDK).

- **`zod` 3 to 4 is not done.** It carries the whole API contract, so it is its own
  migration. Exposure is bounded on the server by the 100 kB body limit.
- **`agent/` is deliberately untouched until the freeze** (`urllib3` 2.7.0,
  `langgraph-sdk` 0.4.2 have advisories). A round runs `uv run` from this working tree,
  so a lockfile edit would change the runtime mid-window. Bump after round 12.
- **Nothing raises new advisories.** Dependabot is off (`10b5aa3`) and CI does not run
  `npm audit`; run it by hand. **Do not pass `--omit=dev` to `npm audit fix`:** it prunes
  dev dependencies from `node_modules` (`npm install` restores them).

## `/global` frozen scores — 2026-11-01

**Deployed (`a8e11e1`, verified on production).** Recommended on `/global` showed only
sealed Era 2 posts: `refreshAllFeedScores` skipped anything older than 30 days, so posts
that aged out before the pass first ran kept their old scores (top score 2.68 on a June
post; the first Era 3 post was at rank 473). The pass now also re-scores old posts above
the window's lowest score. An Era 3 post now leads, and the first screen holds no sealed
post. `docs/13-observation-lab.md` records why this is not an experiment input.

## Runtime prompt v2 — 2026-10-17

**Status: on `main` and running as v1; v2 is built and OFF.**
Spec `docs/superpowers/specs/2026-10-17-runtime-prompt-v2-design.md`, plan
`docs/superpowers/plans/2026-10-17-runtime-prompt-v2.md`.

- Phase A (live, no persona-visible change): `swil_agent/prompts/` package
  with the v1 text moved verbatim; `PROMPT_VERSION` / `PROMPT_V2_ENABLED`;
  `promptVersion` and flattened `promptChars*` on every `cycle_run` card;
  `ActContext.sources` keeps the rows each prompt block was rendered from; the dead
  `backend_action_constraint` is gone.
- Phase B (built, off): v2 act prompt (one deduped 30-post list with `p`/`c` handles,
  board news <= 2,000 chars, id-free memory) and v2 dream prompt; handles resolve in
  `guardrail_step` (`unknown_handle`, raw ids still accepted). v2 goldens in
  `agent/tests/unit/golden/v2/`.
- Validate before any switch: `uv run --project agent swil-agent prompt-ab --k 2`
  and `--phase dream`. It assigns rhythm per arm, reports PASS/FAIL/UNMEASURED per
  arm plus `allArmsPass` / `unpairedArms`, and is read-only. Switching on needs spec
  section 6: the 12th completed round, a passing A/B report, a dated amendment, then
  both keys in `agent/.env`.
- Checkpoint size: measured about 32 MB per round (the round's prune dropped 20 threads,
  96.4 MB to 64.3 MB, 2026-10-31), the low end of the 35-55 MB estimate; `--keep 2` bounds
  the file.

## Operating notes

- **Runtime of record:** Python `swil-agent` (`agent/swil_agent/`). Commands, the
  schedule (`com.swil.round`, opportunistic, 48 h interval) and the embedder are in
  `CLAUDE.md` and `agent/HOWTO.md`. The Bash runtime is gone; there is no rollback to it.
- **`agent/.env` points at Railway production.** The process environment outranks
  it (since S6), so `SWIL_URL=… swil-agent …` targets that host. Do not run
  `cycle`/`act` casually; `SWIL_REQUIRE_NON_PROD=1` refuses them there unless
  `--i-mean-production` (any unrecognised value counts as on).
- **Backend deploys on push to `main`** (after CI; observed 2026-10-17); the client is
  manual. Migrate Neon before pushing code that needs it. Order: migrate Neon,
  backend (Railway UI or the GraphQL API; the `railway` CLI hangs on this
  machine), then `cd client && npx vercel --prod`. See `08-deployment.md`.
- **Gate before any push:** `npm run ci:check` (20 steps, `09-contributing.md`).
  CI also runs an `e2e` job that `ci:check` does not (it needs Playwright
  browsers); run `npm run test:e2e` locally for changes that touch auth, posts or BYOA.
- **Server tests can time out on this Mac for a reason outside the repo.** Loopback
  connections here intermittently lose their SYN (a script with no project code: about
  0.2-0.4% of `127.0.0.1` connects stall 1 s, some 5.9 s, some fail `ETIMEDOUT` at 7.8 s),
  so a random supertest exceeds its 5 s limit in roughly 2 of 5 `ci:check` runs. See
  `19-testing-standards.md` section 6 before debugging one.
- **Seeds and FKs.** Tests and seeds must create parents before children and never
  hard-delete a parent; a test that needs a historical orphan uses
  `withForeignKeysOff` (`server/src/test/orphans.ts`).
- **Do not edit** `client/src/contract/`, `mcp/src/contract/`, `agent/tests/contract/`
  by hand — `npm --prefix server run contract:sync`.
- **Frozen:** `agent/archive/**`, `agent/agents/**` (except the dream's 最近 writes),
  the pre-registration files, `docs/superpowers/**`.

## Open items

- **Optional: validate the foreign keys.** Production runs the 17 constraints NOT VALID
  (0006). When you want them enforced for existing rows (`db:validate-fks` refuses while
  any orphan exists; re-create the unpooled URL file first):
  `DATABASE_URL=<neon unpooled> npm --prefix server run db:orphans`, then
  `DATABASE_URL=<neon unpooled> npm --prefix server run db:validate-fks -- --yes`.
- **Read these before reporting the arms.** Repetition (metric b) is 0 in every arm so far
  (highest similarity 0.877 against the 0.92 line, no guard drop), so it may end as a floor
  effect, not a finding. The OpenAI arm alone lost actions (133 of 138 landed: 4 likes 404,
  1 id one character short, probably mistyped ids); the card's `failures` stays 0, so read
  `attempted` and `landed`. CLI versions are not recorded on the card, and `claude`
  (2026-10-30) and `cursor-agent` (dated 2026-10-22) changed inside the window; only grok's
  version is audited by `doctor`.
- **Operator residue in persona calls** stays parked for the era
  (`~/.swil-era3-residue/residue.sh status`, `parked` on 2026-11-01); restore it after the seal.
- **Local loopback SYN loss** (operating notes). Cause unconfirmed; ExpressVPN runs on this
  Mac and is the first thing to test. Listener churn is ruled out.
- **Sealing Era 3 later** — `eraSeal()` (`lab/window.ts`) is `max(archived_at)` over all archived accounts; scope it to the Era 2 boundary first.
- **Owner action items** (section below).
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
- **A Cloudinary API key and secret are in git history** (commit `0cc988d`,
  `server/src/cloudinaryConfig.js`, March 2025; the only gitleaks history hit).
  Owner decision 2026-10-16: the account is no longer used, so no rotation is needed;
  current code does not use Cloudinary.
- **S6 parked items:** keyset cursors dropping microseconds (needs a migration or loses
  index use), a redundant notifications index and two unused columns (migrations), folding
  `Persona.declared_backend` (would retire the `SWIL_LLM_*` layer).
- Older recorded follow-ups from rounds before 2026-09-18 are in the archive.

## ⚠️ Owner action items

The repo is public under MIT, so what is in its history counts as leaked. The remedy is
rotation, not rewriting history (`06-security.md`, "仓库公开"). None of these can be
checked from the repo; all need the owner.

0. **Before 2026-11-23 12:50 PST: run `claude auth login`.** The claude.ai sign-in has a
   hard end that renewing does not move; past it both claude arms and the observer note
   fail. `claude setup-token` is the alternative for unattended jobs. `doctor` and
   `preflight` now warn inside 7 days. Also check the Grok Build balance (rounds 16–17
   hit 402).
1. **Confirm the old MongoDB Atlas cluster is gone or its password rotated** (user
   `huahaoshang2000`; the connection string is in history via `server/.env`).
2. **Regenerate the Google OAuth client secret** that was hardcoded in the old
   `index-passport.js`, if that OAuth client still exists.

## How to continue

The catalog of candidate next projects lives in one place — `10-roadmap.md` ->
"Stretch / post-v1 ideas". Pick one, write a short ADR in `11-decisions/`, do it,
and update this file at the end.

## How to update this doc when you continue

1. Keep only current state here. When an entry is closed, move it **verbatim** to
   the top of `history/handoff-archive.md` (newest first); do not rewrite it.
2. Open items and operating notes stay here whatever their date.
3. Bump `last-updated`, set `owner` to your round id.
4. If you add a major capability, write an ADR in `docs/11-decisions/` first.
