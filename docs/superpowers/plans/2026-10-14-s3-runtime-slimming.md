# S3 — agent runtime slimming: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One orchestration path (LangGraph) for `act` / `dream` / `cycle`, one lock layer (`RunLease`), `cli` and `llm` split into packages, the Persona Bench ported from Bash to `swil-agent bench`, and every module ≤ 600 lines — with `cycle`'s filed output unchanged.

**Architecture:** A golden test records what `cycle`, `act` and `dream` do today (calls, exit codes, log lines) before anything moves; every later task keeps it green. Moves are verbatim where possible; behaviour changes are limited to the ones the spec names.

**Tech Stack:** Python 3.13 / uv / Typer / LangGraph / pydantic / httpx / pytest + pytest-cov / ruff / mypy strict.

**Spec:** `docs/superpowers/specs/2026-10-14-s3-runtime-slimming-design.md` — **§12 (binding details from review) overrides §1–§11 wherever they conflict; every task reads §12 first.**

## Global Constraints

- **NO `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git reset`, `git clean`.** Leave every change in the working tree.
- **No production writes, no live LLM calls.** Never call `SWIL_URL` from `agent/.env` (Railway production); never invoke `claude`/`codex`/`cursor-agent`/`grok` for real; tests use the fakes in `agent/tests/unit/_runners.py` and friends.
- Run from `agent/`: `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest --cov-fail-under=97`. All four green at the end of every task. Never lower the coverage floor.
- **Tool-less invariant:** `--tools ""` (claude/deepseek/grok), `-s read-only` (codex), cursor `--mode ask` + deny config + temp workspace stay on every persona-facing and judge call; a pin may move only together with the code it pins, in the same task.
- Exit codes verbatim: 0 ok, 2 `--probe-board` without `--dry-run`, 64 usage / refused sweep resume, 66 no such account, 75 no action / setup failure.
- Lock file names verbatim: `.agent-state/lock_<name>`, `.agent-state/dream_lock_<name>`; lease DB `run_leases.sqlite`, schema unchanged; checkpoint DB `cycle_checkpoints.sqlite`.
- Entry point `swil-agent = "swil_agent.cli:app"` keeps working.
- No new runtime dependency; no env var renamed; no prompt text changed; no server change.
- Do not modify `agent/scripts/opportunistic-round.sh`, `cycle-one.sh`, `embedder-guard.sh`, `news-fetch.sh`, `scripts/embedder/*`, `agent/launchd/*`.
- Never touch `agent/Untitled`, `agent/archive/era-2/agents/fenziys/Untitled`, `agent/agents/*/api_key.txt`, `.env`.
- Code and comments in English; match the surrounding comment density (this codebase writes explanatory docstrings — keep moved docstrings intact).
- Golden files recorded in Task 1 are immutable; only `cycle` scenarios must stay byte-identical; `act`/`dream` scenarios may differ only by the deltas of spec §12.2 (re-record those scenarios once, in Task 4, and list each delta).
- Patch targets follow the caller (spec §12.15); moved modules keep their original logger names (§12.16).
- **Size cap:** every `agent/swil_agent/**/*.py` ≤ 600 physical lines once Task 7 lands (earlier tasks must not grow a file past 600 that is under it today).
- Test retargeting must not weaken tests: the count of test functions may drop only for deleted code paths, listed in the task report with the replacement test.

## Review Focus

1. A manual `act` while a sweep's `cycle` of the same account is running → the act SKIPs (75) with the lease-busy line; it never runs concurrently, never corrupts `memory.md`.
2. `dream <name>` without `--auto` right after a dream → still dreams (cooldown ignored), as today; with `--auto` inside the cooldown → no-op exit as today.
3. A `dream` whose model output is unparseable → `personality.md` untouched, `dream`/`fail` event filed, exit code as today.
4. `bench run` with the caller's shell exporting `ANTHROPIC_BASE_URL` (DeepSeek-configured) and `--judge` → the judge subprocess env lacks `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`; the model-under-test env for `ds-flash` has the DeepSeek values.
5. `bench run` for an Era 2 sealed persona (`archive/era-2/humans/<p>`, v1 file with no frontmatter) and for an Era 3 v2 file → system prompt never contains the `---` frontmatter block or the `model:` line.

Pinned in Tasks 4, 4, 4, 6, 6 respectively.

---

### Task 1: Golden equivalence test (before any move)

**Files:**
- Create: `agent/tests/unit/test_golden_runs.py`, `agent/tests/unit/golden/` (recorded JSON).
- Read (do not change): `agent/tests/unit/_runners.py`, `test_graph_cycle.py`, `test_cli.py` for existing fakes.

**Interfaces:**
- Produces: `golden` fixtures that later tasks must keep passing unchanged. A later task may change a golden file only if the spec names that behaviour change (none in S3 except: `DREAM` gains the deadline check, a no-op without a deadline).

- [ ] Step 1: Build the harness of spec §12.3: `JournalingResources(FakeResources)` recording reads and writes in one ordered list; `_patch_cycle_seams` from `test_cli.py` (move it into one shared helper the golden test owns; that helper is the only thing Task 5 may retarget); frozen clock; `--seed 0`; normalisation of run ids, `durationMs`, log timestamps, `tmp_path`; snapshots of `memory.md`, `personality.md`, `personality.archive.md`, dream marker. Temp `agent_root` with one Era 3 persona built from an existing test fixture, not a real account's file.
- [ ] Step 2: Drive the real Typer app (`typer.testing.CliRunner` on `swil_agent.cli.app`) for these scenarios, each recorded to `golden/<scenario>.json` = `{calls, exit_code, auto_run_log, dream_log}` with timestamps/run ids/paths normalised:
  - `cycle --auto` posting round (post lands, vector filed, cycle_run card);
  - `cycle --auto` interact round (comment);
  - `cycle --auto` with dream granted (cooldown passed) and with dream not due;
  - `cycle --dry-run`;
  - `act` (real), `act --dry-run`, `act --dry-run --probe-board <board>`;
  - `dream` (forced), `dream --auto` inside cooldown, `dream` with unparseable output;
  - `act` while the act lock is held by a live pid (busy → 75);
  - OFFLINE `cycle`, `BACKEND_UNAVAILABLE` `cycle`, guardrail-emptied plan `cycle`, `act` with > 300 memory lines.
- [ ] Step 3: Write the recorder so the expected files are generated by an explicit `SWIL_GOLDEN_RECORD=1` env flag and compared otherwise; record once against the current code; commit nothing (leave files in the tree).
- [ ] Step 4: Run the full agent suite → PASS. Report lists each scenario and what it pins.

### Task 2: `llm` split

**Files:**
- Create: `swil_agent/llm/errors.py`, `runner.py`, `complete.py`, `backends/__init__.py`, `backends/claude.py`, `backends/codex.py`, `backends/cursor.py`, `backends/grok.py`.
- Delete: `swil_agent/llm/base.py`, `claude_cli.py`, `codex_cli.py`, `deepseek_cli.py`.
- Modify: every importer (grep `llm.base`, `llm.claude_cli`, `llm.codex_cli`, `llm.deepseek_cli`, `from .base`), `tests/unit/test_architecture.py` (deepseek guard → same property on `llm.backends.claude.DeepSeekCLIBackend`), backend tests' import paths.

- [ ] Step 1: Move code verbatim per spec §7; `build_backend` + `Backend` protocol in `backends/__init__.py`; `complete_text`/`complete_json` in `complete.py`.
- [ ] Step 2: Retarget imports and monkeypatch paths in tests; keep every flag pin (`test_backends.py`, `test_cursor_backend.py`, `test_grok_backend.py`).
- [ ] Step 3: Full suite + golden → PASS.

### Task 3: `locks` package

**Files:**
- Create: `swil_agent/locks/__init__.py`, `locks/file.py` (from `locks.py`), `locks/lease.py` (from `graph/leases.py`).
- Delete: `swil_agent/locks.py`, `swil_agent/graph/leases.py`.
- Modify: importers (grep `swil_agent.locks`, `graph.leases`, `from .leases`), tests (`test_locks*.py`, `test_leases*.py` or wherever they live), architecture test if it lists graph modules.

- [ ] Step 1: Verbatim move; `locks/lease.py` must not import langgraph (architecture test already requires langgraph only under `graph/`).
- [ ] Step 2: Full suite + golden → PASS.

### Task 4: Single orchestration and one lock layer

**Files:**
- Modify: `swil_agent/graph/cycle.py` (`Phases`, `run_graph`, lease kinds per phase, subset topologies, no checkpointer for subsets), `graph/nodes.py` (probe board on deps/state; logout skips the card for `ACT`), `graph/state.py`, `act/round.py` (delete `run_act` and its `locked()` composition; `login_step` takes no lock), `dream/round.py` (delete `run_dream`), `cli.py` (`act`, `dream` call `run_graph`; one deps builder for all three commands).
- Create: `swil_agent/graph/outcome.py` (`act_result_of`, `dream_result_of`, `cycle_granted_dream` moved from cli).
- Test: `test_act_round.py`, `test_dream_*.py`, `test_graph_cycle.py`, `test_graph_nodes.py`, `test_cli.py`, new `test_graph_phases.py`.

**Interfaces:**
- Produces: `run_graph(deps: CycleDeps, *, phases: Phases, resume: bool = False, ...) -> CycleState`; `Phases.CYCLE|ACT|DREAM`; `graph.outcome.act_result_of(state) -> ActResult`, `dream_result_of(state) -> DreamResult`, `cycle_granted_dream(state) -> bool`; `lease_kinds(phases) -> tuple[str, ...]`.
- Consumes: Task 3 `locks.lease.RunLease`, `LeaseBusy`.

- [ ] Step 1: Failing tests in `test_graph_phases.py`: `build_graph(CYCLE)` nodes+edges equal today's (pin the list); ACT/DREAM topologies (spec §12.5); ACT files no cycle_run card; ACT logout rotates only when not OFFLINE, under a node-local non-blocking dream lease, busy → the existing INFO skip line and success; DREAM honours `--auto` cooldown; subset runs create no checkpoint rows; `lease_kinds` CYCLE (act, dream) / ACT (act) / DREAM (dream); ACT busy lease → exit 75; dry ACT takes no lease and writes nothing; probe board reaches `context_step` in ACT; DREAM deps make no feed/search reads and spawn no `news-fetch.sh`, and probe the embedder before backend selection; ACT never probes the embedder.
- [ ] Step 2: Implement spec §4–§5 as amended by §12.4–§12.11. `run_cycle` stays the CYCLE entry (thin wrapper over `run_graph`). New `graph/run.py` (`run_graph`, `_acquire`, `lease_kinds`) and `graph/policies.py` (retry policies) so `graph/cycle.py` stays ≤ 600. Per-phase deps builders in cli (moved to `compose` in Task 5).
- [ ] Step 3: Delete `run_act`/`run_dream` and their composer tests; move each behaviour assertion that only they carried to the phase tests (list them in the report).
- [ ] Step 4: Re-record the `act`/`dream` golden scenarios once with `SWIL_GOLDEN_RECORD=1`; the report diffs old vs new for each and maps every difference to a §12.2 delta letter. `cycle` goldens untouched. Full suite → PASS. Review Focus 1–3 pinned here.

### Task 5: `cli` package

**Files:**
- Create: `swil_agent/cli/__init__.py`, `app.py`, `compose.py`, `stores.py`, `report.py`, `logs.py`, `errors.py`, `run.py`, `analysis.py`, `ops.py`; `swil_agent/policy.py`, `swil_agent/doctor.py`, `swil_agent/analysis/measure_status.py`, `swil_agent/llm/remedy.py`; extend `swil_agent/round_id.py`.
- Delete: `swil_agent/cli.py`.
- Modify: all tests that patch or import `swil_agent.cli` (≈ 300 setattr sites; see spec §6), `pyproject.toml` only if the entry point string must change (it must not).

**Interfaces:**
- Produces: `swil_agent.cli.compose` seams (public names, no leading underscore): `load_settings`, `now`, `persona_source_for`, `resources_for`, `resources_for_key`, `select_backend`, `backend_for`, `api_backend_for`, `backend_setup_guard`, `runner_for`, `embedder_for`, `guard_for`, `state_for`, `health_check`, `context_now_for`, `feed_context_for`, `probe_embedder`, `cycle_stores`, `cycle_deps_for`, `lease_busy_guard`; `swil_agent.cli.app.app` and `EXIT_*`; `round_id.resume_round_id/fresh_round_id/act_round_id`; `policy.refuse_production_writes/require_era_start/is_production_url`; `analysis.measure_status.runtime_totals/range_covering/measure_since_default`; `doctor.since_probe/doctor_binaries/smoke_arms/heartbeat_launchctl_status/lock_dir_writable`.
- Commands call seams as `compose.<name>(...)` so one `monkeypatch.setattr(compose, ...)` covers every command; `compose.now(tz=None)` / `compose.today()` replace clock reads at the same sites and order; `doctor.*` / `analysis.measure_status.*` are the second seam home; `backend_for(persona, settings)` keeps two arguments; `cli/__init__.py` re-exports `act`, `dream`, `cycle`; per-command preambles unchanged (spec §12.12); layering and domain errors per §12.14.

- [ ] Step 1: Move code per spec §6; log routing (I4) — any logger name in `_DREAM_LOG_SOURCES` keeps resolving: set explicit logger names where modules moved; add a test that a record from `run.dream` reaches `dream.log` and one from `run.act` reaches `auto-run.log`.
- [ ] Step 2: Retarget tests mechanically (`setattr(cli, "_resources_for"` → `setattr(compose, "resources_for"`, etc.); `datetime` patches → `compose.now`.
- [ ] Step 3: Full suite + golden → PASS; `uv run swil-agent --help` lists the same commands as before (assert in a test).

### Task 6: Persona Bench in Python

**Files:**
- Create: `swil_agent/bench/__init__.py`, `bench/persona.py` (resolution, system prompt, reference text, display name), `bench/rules.py` (rule score), `bench/judge.py` (exact Bash argv over the `Runner`, no `--system-prompt`, scrubbed env), `bench/runner.py` (run + all, throttle ≤ 18/min + Retry-After), `swil_agent/cli/bench.py` (Typer sub-app bound as `bench_app`, commands `run`, `all`, flags defaulting from the Bash env vars); a `Resources` method `record_benchmark_run(body) -> str`.
- Delete: `agent/scripts/llm.sh`, `deepseek-env.sh`, `benchmark-run.sh`, `benchmark-all.sh`, `llm-smoke.sh`.
- Modify: `tests/unit/test_backends.py` (Bash pins → Python argv/env pins for the judge and model dispatch), `tests/unit/test_scripts.py` (benchmark frontmatter test → Python test).
- Test: new `tests/unit/test_bench_*.py`.

**Interfaces:**
- Consumes: Task 2 `llm.backends` (`ClaudeCLIBackend`, `CodexCLIBackend`, `DeepSeekCLIBackend`, `build_backend`), `EmbedderClient`, `ApiClient`.

- [ ] Step 1: Read the five Bash scripts fully; port per spec §8 as amended by §12.18–§12.26 field for field. Copy the judge prompt and rule regexes verbatim from `benchmark-run.sh`. Do not modify `.claude/worktrees/**`.
- [ ] Step 2: Tests: exact JSON body and file path for one run over fake backend/embedder/API (batch id formats of §12.18; 6-decimal fidelity; ruleScore rounding/null; per-line trim; pretty JSON written before POST); judge argv exact, >100 → null; POST failure → `post=ERR`, file kept, exit 75; unknown task id → 64; env-var defaults; empty output skipped; v1 and v2 persona prompts carry no frontmatter (Review Focus 5); judge env scrubbed and argv tool-less (Review Focus 4); `ds-flash` env; `<backend>:<model>` dir naming; `all` shares one batch id ending `-sweep`, uses `codex-k` for codex; server/embedder down → 75.
- [ ] Step 3: Delete the scripts; `test_scripts.py`'s `bash -n` parametrization shrinks accordingly.
- [ ] Step 4: Full suite + golden → PASS.

### Task 7: Size cap

**Files:**
- Modify/create per spec §9 + §12.27: `act/executor.py` helpers → `act/execution_outcome.py`; `act/round.py` → `act/memory_log.py`, `act/similarity.py`, `act/notifications.py`; `graph/nodes.py` → `graph/deps.py`, `graph/nodes_act.py`, `graph/nodes_dream.py`, `graph/nodes_tail.py` (keep `graph/nodes.py` only if a thin re-export is needed by tests, else delete); `api/resources.py` → `api/writes.py`, `api/lab.py` mixins; `act/context.py` → `act/context_format.py`; any other file still > 600.
- Test: `tests/unit/test_architecture.py` — `test_no_module_exceeds_600_lines`.

- [ ] Step 1: Failing architecture test listing offenders.
- [ ] Step 2: Verbatim moves along the seams; retarget test imports/patches.
- [ ] Step 3: Full suite + golden → PASS; architecture test green.

### Task 8: Docs

**Files:** `CLAUDE.md` (agent cycle section, Bench section, backend call sites list, "Kept Bash" line), `agent/README.md`, `agent/HOWTO.md`, `docs/12-handoff.md` (S3 done; Not done list), `docs/13-observation-lab.md` (Bench commands; dated note of the Bench deliberate changes of spec §12.21), `docs/03-api-reference.md`, `docs/18-persona-bench-findings.md` (current-state lines), `agent/.env.example` if it names Bench scripts, `client/src/features/lab/BenchmarkView.tsx` + `BenchmarkView.test.tsx` (hint → `uv run --project agent swil-agent bench all`).

- [ ] Step 1: Replace every reference to deleted scripts and moved modules (grep `llm.sh`, `benchmark-run.sh`, `benchmark-all.sh`, `deepseek-env.sh`, `llm-smoke.sh`, `cli.py`, `llm/base.py`, `graph/leases.py`, `locks.py`, `run_act`, `run_dream`) in current-state docs; historical dated entries stay as history.
- [ ] Step 2: From the repo root run `npm run ci:check` → all steps green.
