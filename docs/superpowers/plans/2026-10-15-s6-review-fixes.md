# S6 — project review fixes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Fix what five whole-project reviews found — security holes, latent bugs, redundancy and
design debt — across server, client, mcp, agent and tooling, before Era 3 round 1.

**Source of requirements:** the findings files in `.superpowers/sdd/2026-10-15-s6-review/`
(`findings-server-core.md` = SC, `findings-server-agents.md` = SA, `findings-client.md` = CL,
`findings-agent.md` = AG, `findings-tooling.md` = TL). A task's brief names finding ids
(e.g. `SC-F1`); each finding's `fix` and `test` lines are the requirement, overridden only by
the rulings below.

## Global Constraints

- **NO `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git reset`, `git clean`,
  `git config`.** Leave every change in the working tree. The index has a staged deletion of
  `server/scripts/migrate-mongo-to-pg.ts`; leave it.
- **No production access**: no Neon, no deploy, no request to `SWIL_URL`. **No `swil-agent` CLI
  runs** (agent/.env points at Railway production and wins over the process env until AG-F4
  lands — and even after). Agent code is exercised only in pytest with settings patched.
  Never use `server/.env`'s DATABASE_URL.
- **One test-DB user at a time**: never run the server or e2e suites concurrently with another
  suite. Implementers run their own package's tests; the controller runs `ci:check`.
- Generated contract copies are only written by `npm --prefix server run contract:sync`.
- Coverage floors never lowered. Server: no `any`, no `console.log`. New dependencies only where
  a task names them (note the reason in the report).
- Experiment data path: `agent/tests/unit/golden/cycle_*`, `act*`, `dream_*` stay byte-identical
  **except** Task 2's argv/cwd/env delta (the isolation flags), which must be the only change in
  those files. `server/src/modules/agents/arms/protocol.ts` and `arms/stats.ts` numerics are not
  touched. No change to `agent/agents/**`, `agent/archive/**`, `docs/superpowers/specs/**`,
  pre-registration files, `agent/Untitled`, `.env`, `api_key.txt`.
- Every persona-facing LLM call stays tool-less (`--tools ""`, `-s read-only`, cursor `--mode
  ask` + deny config + temp workspace) — Task 2 only adds isolation on top.
- Subagents cannot write report files (harness rule): return the report as text, ≤ 40 lines.

## Rulings (controller, binding)

1. **AG-F1/F2 persona isolation — fix now.** Measured 2026-10-15 from the repo root:
   `claude -p --tools ""` loads 64 MCP tools (Gmail send, Blender execute, Drive…), 8 hooks
   injecting ~66k tokens (superpowers, vercel, remember), 22 plugins, CLAUDE.md, auto-memory.
   With cwd = fresh `mkdtemp` + `--strict-mcp-config --setting-sources "" --disable-slash-commands
   --no-session-persistence`: 0 tools, 0 MCP, 0 skills, ~0.7k tokens, the one residual hook
   returns `{}`. Era 3 has not run round 1, so this restores the pre-registered blinding rather
   than changing a running series. Recorded as a dated change point in `docs/13-observation-lab.md`.
   codex: `--ignore-user-config --ignore-rules -C <mkdtemp> --skip-git-repo-check` (verify each
   flag with one tiny live call; auth must still work). Same isolation for the Bench judge and
   the bench model under test. Cursor/grok already use temp workspaces — verify they don't load
   user MCP/rules either and isolate if they do.
2. **AG-F10** `ACCOUNT_TIMEOUT` default 900 → 1800 s, with a comment deriving it from the per-call
   caps; fix the "longest node 300 s" docstrings.
3. **AG-F11** `cycle --resume` refuses (exit 64, clear message) when the next node is `execute`
   or `write`.
4. **SA-F12** `occurredAt` accepted only for `type: 'anomaly'` (400 otherwise) — verify the agent
   never sends it for another type.
5. **SA-F16** bench reads stay public; correct CLAUDE.md. `requireUser` reuses `req.user`.
6. **SC-F6** recommended feed: client de-duplicates pages by id; server comment documents
   best-effort pagination. No cursor-format change.
7. **SA-F5/F10** one `labWindow(range, era)`: Era 2 windows end at the seal (max `archived_at`
   of Era 2 accounts, cached), Era 3 at now; per-account reads end at `archivedAt ?? now`. One
   `RANGE_DAYS`.
8. **SA-F9** drop the never-produced `kind: 'out'` from the contract.
9. **CL-F8** CSP ships as `Content-Security-Policy-Report-Only` plus enforced `X-Frame-Options:
   DENY`, nosniff, Referrer-Policy; flips to enforcing after a preview-deploy check (launch
   checklist line).
10. **TL-F10** displayName max = server's 80, added to `LIMITS`; client imports every limit.
11. **TL-F2** `install-hooks.sh` sets `core.hooksPath` (the script, not the implementer, runs
    `git config`; the owner runs `npm run install-hooks`). Add a CI commitlint step.
12. **TL-F6** Vite single major is attempted last in Task 10; if `ci:check` or the build breaks
    and the fix is not small, revert it and park it.
13. **Deferred (parked, no change):** SC-F10 (needs a migration or loses index use), SC-F22
    (migration), SC-F19 column drops (comment them instead), SA-F7's `stats.olsSlope`.

## Tasks (strictly in order)

### Task 1: Test-DB guard and hooks
TL-F1, TL-F2, TL-F3, TL-F15. Sonnet.

### Task 2: Persona-call isolation
AG-F1, AG-F2, AG-F15 (process-group kill in `llm/runner.py`). Ruling 1. Goldens: argv/cwd delta
only. Docs: CLAUDE.md backend paragraph, `docs/13` change point, handoff.

### Task 3: Agent runtime safety
AG-F4, AG-F5, AG-F9, AG-F12, AG-F13, AG-F14, AG-F17.

### Task 4: Round script and cycle runtime
AG-F3, AG-F6, AG-F7, AG-F8, AG-F10, AG-F11, AG-F16, AG-F18, AG-F19, AG-F20. Rulings 2, 3.
Goldens byte-identical.

### Task 5: Server security
SC-F1, SC-F2, SC-F3, SC-F13, SC-F14, SC-F21, SA-F1, SA-F6, SA-F16. Ruling 5.

### Task 6: Server correctness
SC-F4, SC-F5, SC-F7 (server half), SC-F8, SC-F9, SC-F11, SC-F12, SC-F20, SA-F2, SA-F8, SA-F11,
SA-F12. Ruling 4.

### Task 7: Server efficiency and redundancy
SA-F3, SA-F4, SA-F5, SA-F7, SA-F9, SA-F10, SA-F13, SA-F14, SA-F15, SC-F15, SC-F16, SC-F17,
SC-F18, SC-F19. Rulings 7, 8, 13. Output-identical except where a finding says otherwise.

### Task 8: Client security and data integrity
CL-F1, CL-F2, CL-F3, CL-F4, CL-F5, CL-F6, CL-F9, CL-F11, CL-F12, CL-F13, CL-F14, CL-F15,
SC-F7 (client reconnect), SC-F6 (ruling 6).

### Task 9: Client UX and redundancy
CL-F7, CL-F8, CL-F10, CL-F16, CL-F17, CL-F18, CL-F19, CL-F20, CL-F21, TL-F10. Rulings 9, 10.

### Task 10: Tooling, mcp, CI
TL-F4, TL-F5, TL-F7, TL-F8, TL-F9, TL-F11, TL-F12, TL-F13, TL-F14, TL-F6 (last; ruling 12).

### Task 11: Docs and final check (controller)
Handoff S6 section, launch-checklist additions (CSP flip, `npm run install-hooks`, Node 22 on
Railway), `ci:check` green.
