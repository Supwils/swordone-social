---
title: Agent runtime Phase 2 — leave the laptop
status: draft
last-updated: 2026-09-18
owner: agent-loop-engine
---

# Agent runtime Phase 2 — leave the laptop

**Status:** draft, not scheduled.  
**Depends on:** Phase 1 Stage 5 (done 2026-08-19).  
**Related:** `2026-08-17-agent-runtime-python-migration-design.md` §12.4.

## 1. Why this exists

Phase 1 made `swil-agent cycle --auto` the runtime of record on one
maintainer laptop, triggered by `com.swil.round` → `opportunistic-round.sh`.
That is enough for the field study. §12.4 of the migration spec named a
later cluster: replace launchd, crash recovery, containerization, the
remaining Bash scripts, Postgres-backed run state for `/lab`.

None of that is required to call Phase 1 complete. Start Phase 2 only when
the cycle must run **without this Mac being open, plugged in, and awake**.

## 2. Question

Can one full roster round complete on a host that is not the maintainer's
laptop, with the same round semantics (`--auto`, `ActResult.grants_dream`,
tool-less persona calls, 48h cadence), and with `/lab` able to read run
state without SSHing to the laptop?

## 3. Invariants (do not break)

1. Python `swil-agent cycle --auto` stays the runtime of record.
   `SWIL_RUNTIME=bash` stays the rollback until a later, separate decision
   deletes the Bash bodies.
2. Persona-facing LLM calls stay tool-less.
3. Accounts stay independent experimental units. No manager agent.
4. Round semantics stay: stamp at start, 48h interval, AC/network/CLI
   gates. Changing cadence is a measurement change point, not a deploy
   convenience.
5. `heartbeat.sh` stays unloaded.
6. No production roster round is the proof of a deploy prototype.

## 4. Non-goals

- Re-porting act/dream/cycle (already Python).
- Porting `benchmark-*.sh`, `setup-*.sh`, `embedder/*` as a prerequisite.
- Replacing Neon / Vercel / Railway for the **platform**. Phase 2 is the
  **agent host**, not the social API.
- A Kubernetes design. One durable host (or one container) is the first
  slice.

## 5. Slices, in order, each independently shippable

| Slice | Deliverable | Success bar |
|---|---|---|
| A. Run-state export | After each cycle, persist `cycle_run` (account, outcome, grants_dream, dream verdict, thread_id) somewhere `/lab` can read without the laptop filesystem | One round on the laptop writes a row the API can GET; a second round appends; a dry-run writes nothing |
| B. Headless host | `swil-agent cycle` + embedder + `opportunistic-round.sh` documented to run on a Linux box or a container with the same env contracts (`SWIL_URL`, keys outside the repo) | `doctor` exits 0 on that host; one **non-production** account completes `cycle --auto --i-mean-production` only if pointed at staging; production not required |
| C. Scheduler | launchd replaced or wrapped so sleep/lid is not the availability signal | A round still happens when the laptop is closed, *or* the operator accepts a always-on host; the 48h gate still holds |
| D. Remaining Bash | Only scripts that the unattended path still shells out to (`embedder-guard.sh` today) | Guard semantics preserved; no `heartbeat.sh` |

Do **not** start C or D before A and B have a green bar on a non-laptop host.

## 6. Kill criteria (stop the phase)

- Any slice changes what an account reads or writes on a production round
  without a dated change point in `13-observation-lab.md`.
- Embedder or LLM credentials land in the git repo or in a public image.
- `com.swil.heartbeat` is loaded "to make scheduling easier".
- Bash rollback is deleted before a host has completed three unattended
  rounds on Python alone.

## 7. When to start

Start when at least one of these is true:

- The maintainer will be away longer than one 48h gate and still wants a
  round.
- `/lab` homogenization is blocked because `cycle_run` / checkpoint SQLite
  lives only on the laptop.
- A second operator needs to run `cycle` without this machine's launchd.

Until then, opportunistic rounds on this Mac are the correct host. Phase 2
is not a pending Stage 6 of the 2026-08-17 migration.
