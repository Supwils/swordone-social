---
date: 2026-10-14
scope: S3 of the 2026-10-14 restructure (after S1 roster, S2 lab; S4 contract and S5 docs follow)
status: approved for implementation (owner delegated review)
---

# S3 — agent runtime slimming

## 1. Why

The Python runtime (`agent/swil_agent`, 14.2k lines) works, but its shape is the
residue of the Bash port:

- `cli.py` is 2397 lines and holds business logic (round-id policy, the
  production guard, outcome derivation, runtime-health aggregation, the whole
  doctor) next to Typer wiring.
- There are **two orchestration paths** over the same step functions: `cycle`
  runs the LangGraph graph; `act` and `dream` run hand-sequenced composers
  (`run_act`, `run_dream`) that re-list the same steps and arguments. Memory
  rotation lives in both. `cli.py` composes each path separately, so three
  argument lists must agree by hand.
- **Two lock layers**: `act`/`dream` take a bare `FileLock`, `cycle` takes a
  `RunLease` (file lock + SQLite row with pid liveness). `login_step` still
  returns a `FileLock` the graph throws away.
- `llm/base.py` (568) holds errors, the subprocess runner and five backends;
  `claude_cli.py`/`codex_cli.py`/`deepseek_cli.py` are 3-line re-exports.
- The Persona Bench is still Bash (`llm.sh`, `deepseek-env.sh`,
  `benchmark-run.sh`, `benchmark-all.sh`, `llm-smoke.sh`), with its own copies
  of `collapse_doubled_text` / `_extract_json` and its own tool-less flags.
- Seven modules exceed 600 lines.

Era 3's round 1 has not run. Whatever S3 changes, a `cycle` must file exactly
what it filed before S3: same node order, same lab events and cards, same post
vectors, same exit codes, same log files. That is the hard constraint.

## 2. Goals and non-goals

Goals:

1. One orchestration path: `act`, `dream` and `cycle` all run the LangGraph
   graph, built from one node set; the hand composers are deleted.
2. One lock layer: every command that mutates an account holds `RunLease`s.
3. `cli` becomes a package of thin command modules over one composition module;
   business logic moves to the modules it belongs to.
4. `llm` split by responsibility; the re-export shims go.
5. The Persona Bench runs in Python (`swil-agent bench …`); the five Bench Bash
   scripts are deleted.
6. No module in `swil_agent/` exceeds **600 lines**, enforced by a test.

Non-goals: `opportunistic-round.sh`, `cycle-one.sh`, `embedder-guard.sh`,
`news-fetch.sh` and the embedder scripts stay Bash (launchd entry points with
their own pinned tests). No change to prompts, the persona format, the rhythm,
the duplicate guard, the dream contract, any server endpoint, or any env var
name. No new runtime dependency.

## 3. Invariants (checked by tests, not by reading)

- **I1 cycle equivalence.** For the same fakes, `swil-agent cycle <name> --auto`
  produces the same ordered sequence of `Resources` calls (method + body), the
  same exit code and the same lines in `auto-run.log` / `dream.log` as before
  S3. A golden test pins this: it is written against the pre-S3 code first
  (Task 1), recorded, then must still pass unchanged after every later task.
- **I2 exit codes.** 0 ok, 2 `--probe-board` without `--dry-run`, 64 usage /
  refused sweep resume, 66 no such account, 75 no action or setup failure — for
  `act`, `dream`, `cycle` exactly as today.
- **I3 tool-less calls.** Every persona-facing and judge LLM call keeps
  `--tools ""` (claude/deepseek/grok), `-s read-only` (codex), cursor
  `--mode ask` + deny config + temp workspace. The flag pins move with the code;
  none is deleted without its replacement in the same task.
- **I4 log routing.** Records reach the same file as today
  (`_DREAM_LOG_SOURCES` routes by logger-name prefix). Moving code must not
  change a logger name that routing depends on; where a module moves, it keeps
  an explicit `logging.getLogger("<old name>")`.
- **I5 lock file names.** `.agent-state/lock_<name>` and `dream_lock_<name>`
  stay (the round script sweeps dead-pid lock files by those names), and
  `run_leases.sqlite` keeps its schema.
- **I6 entry point.** `swil-agent = "swil_agent.cli:app"` keeps working.

## 4. Single orchestration

`graph/cycle.py` exposes one runner over a phase set:

```python
class Phases(enum.Enum):
    CYCLE = "cycle"   # login → plan → guardrail → execute → behavior_snapshot →
                      # dream → write → snapshot → logout → population_metric
    ACT = "act"       # login → plan → guardrail → execute → logout
    DREAM = "dream"   # dream → write → snapshot

def run_graph(deps: CycleDeps, *, phases: Phases, resume: bool = False, ...) -> CycleState
```

- `CYCLE` is today's graph, unchanged (I1). `run_cycle` stays as the name of the
  `CYCLE` call or becomes a thin alias; tests decide which, not callers.
- `ACT` reproduces today's `act` command: no behaviour snapshot, no population
  metric, **no `cycle_run` card** (an act-only run is not a cycle), memory
  rotation in logout as today, `--probe-board` overlay supported (the probe
  board and probe post ids travel on `CycleDeps` / `CycleState`), the embedder
  handed over without the `EmbedderGuard` bracket (act's sample decides nothing,
  as today).
- `DREAM` reproduces today's `dream` command: the cooldown step honours
  `--auto` exactly as `run_dream` does, then dream → write → snapshot, bracketed
  by the `EmbedderGuard` as today.
- Subset runs compile **without a checkpointer** (`--resume` stays a `cycle`
  option only). The dream node's deadline check applies to `DREAM` too (it did
  not before; it is a no-op unless a deadline is set, and the `dream` command
  sets none).
- `--dry-run` (act, cycle): no lease, no checkpoint, no writes, no embedder
  guard — as today. A dry `ACT` still builds context and plans.
- `run_act`, `run_dream`, the `locked()` sequence and the second
  `rotate_memory_soft` call are deleted. Step functions stay public and keep
  their unit tests. `ActResult` / `DreamResult` are derived from final graph
  state by one function each (`graph/outcome.py`, moved from cli's
  `_act_result_of` / `_dream_result_of` / `_cycle_granted_dream`).

## 5. One lock layer

- New package `swil_agent/locks/`: `file.py` (today's `FileLock`, `LockBusy`,
  path helpers, `STALE_AFTER_SECONDS`) and `lease.py` (today's
  `graph/leases.py`: `RunLease`, `LeaseBusy`, the SQLite table). `locks.py` and
  `graph/leases.py` are removed; imports move.
- Every non-dry `run_graph` acquires leases for the kinds its phases need:
  `CYCLE` act+dream (as today), `ACT` act+dream (logout rotates memory under the
  dream lock, as `run_act` did), `DREAM` dream. Busy → the command SKIPs with
  exit 75 and the same log line shape `cycle` uses today. One function decides
  kinds; lease acquisition order is file then row, act then dream, as today.
- `login_step` no longer creates a lock. `FileLock` is used only by `RunLease`
  (architecture test: nothing else imports `locks.file.FileLock`).
- The round lock (`round.lock/` directory) stays in Bash — it is a round-level
  lock owned by the round script.

## 6. `cli` package

```
swil_agent/cli/
  __init__.py      # `app` + command registration only
  app.py           # Typer app, callback, EXIT_* constants
  compose.py       # every collaborator builder and seam (load_settings, now,
                   # resources_for, resources_for_key, backend_for, select_backend,
                   # runner_for, embedder_for, guard_for, health_check,
                   # context_now_for, feed_context_for, cycle_stores, cycle_deps_for …)
  logs.py          # log attachment (_PhaseFilter, attach_* , _DREAM_LOG_SOURCES)
  errors.py        # AccountSetupError, SweepResumeRefusedError, skip_for_exception
  run.py           # act, dream, cycle
  analysis.py      # behavior-snapshot, population-metric, backfill-post-vectors,
                   # summary, intervention
  ops.py           # doctor, measure-status, register, version
  bench.py         # bench run / bench all (§8)
```

- Commands resolve every seam **through the `compose` module object**
  (`compose.resources_for(...)`, `compose.now()`), so a test patches one place:
  `monkeypatch.setattr(compose, "resources_for", fake)`. Tests are retargeted
  accordingly; behaviour assertions are not weakened (same counts of tests or
  more, no deleted assertion without an equivalent).
- Business logic leaves cli:
  - round-id policy (`_resume_round_id`, `_fresh_round_id`, `_act_round_id`) →
    `round_id.py`;
  - production guard, `PRODUCTION_HOST`, `_require_era_start` → `policy.py`;
  - outcome derivation → `graph/outcome.py`;
  - runtime-health aggregation and `DEFAULT_MEASURE_SINCE` →
    `analysis/measure_status.py`;
  - doctor probes (`_since_probe`, `_doctor_binaries`, `_smoke_arms`,
    heartbeat status, lock-dir check) → `doctor.py`;
  - backend remedy text → `llm/remedy.py`.
- Each moved function gets a public name in its new module; cli keeps no
  compatibility aliases.

## 7. `llm` split

```
swil_agent/llm/
  errors.py      # BackendUnavailableError, BackendBinaryMissingError, BackendConfigurationError
  runner.py      # CompletionRequest, Runner, SubprocessRunner
  backends/
    __init__.py  # Backend protocol, build_backend
    claude.py    # _ClaudeStyleBackend, ClaudeCLIBackend, DeepSeekCLIBackend, deepseek key
    codex.py     # CodexCLIBackend
    cursor.py    # CursorCLIBackend (+ deny config)
    grok.py      # GrokCLIBackend
  complete.py    # complete_text, complete_json
  api_backend.py, extract.py, selection.py, factory.py, remedy.py   # unchanged homes
```

`base.py`, `claude_cli.py`, `codex_cli.py`, `deepseek_cli.py` are deleted. The
architecture test that guards `deepseek_cli` imports is rewritten to guard the
same property against the new module (DeepSeek only reachable from the Bench
and explicit `deepseek` selection, never as a roster default).

## 8. Persona Bench in Python

New package `swil_agent/bench/` and command group `swil-agent bench`:

```
swil-agent bench run <persona> <model> [--k 3] [--batch-id ID] [--tasks a,b]
                     [--judge] [--judge-model sonnet]
swil-agent bench all [--personas "…"] [--models "…"] [--k 3] [--codex-k 1]
                     [--judge] [--judge-model sonnet] [--tasks a,b]
```

Behaviour is a port of `benchmark-run.sh` / `benchmark-all.sh`, field for
field, so new rows are comparable with the existing ones:

- **Persona resolution:** `agents/<p>`, then `archive/era-2/agents/<p>`, then
  `archive/era-2/humans/<p>`; needs `personality.md` and `api_key.txt`
  (exit 66 / 75 otherwise).
- **System prompt:** file text with BOM and CR stripped, YAML frontmatter
  removed (it names the model under test and must never reach it). Display name
  from frontmatter `display_name`, else the legacy `Display Name` bullet.
- **Reference text:** the body before `## 发帖节律` (whole body if absent),
  embedded via the existing `EmbedderClient`; `vectorFidelity` = dot product of
  reference and output vectors (both normalised by the daemon).
- **Models:** `codex` → `CodexCLIBackend` default model; `ds-flash` →
  `DeepSeekCLIBackend` `deepseek-v4-flash`; any other bare word → claude alias
  (`opus`, `sonnet`, `haiku`, …) via `ClaudeCLIBackend`. New: `<backend>:<model>`
  (the roster form, e.g. `grok:grok-4.6`) through `build_backend`, so Era 3 arms
  can be benched. The results directory name is the model string with `:`
  replaced by `_`; the row's `model` field keeps the original string.
- **Battery:** `bench/battery/tasks.json` (`id`, `kind`, `prompt`), filtered by
  `--tasks`, each task `k` times; empty outputs skipped (logged).
- **Rule score:** the two deterministic checks of `benchmark-run.sh`, same
  regexes, same `ruleScore` / `ruleDetail` strings.
- **Judge** (`--judge`): `ClaudeCLIBackend` with `--model <judge-model>`,
  tool-less, the same Chinese 0–100 prompt verbatim, first integer of the
  answer. The judge's subprocess env has `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` removed, so it always reaches real
  Anthropic even when the caller's shell is DeepSeek-configured (pinned by test).
- **Output:** `agent/bench/results/<persona>/<modelDir>/<batchId>__<taskId>__<i>.json`
  with the same body keys as today (`batchId, persona, personaDisplay, model,
  taskId, taskKind, runIndex, output, vectorFidelity, judgeScore, ruleScore,
  ruleDetail, latencyMs, capturedAt`), then `POST /agents/benchmark/runs` with
  the persona's key (a `Resources`/`ApiClient` method, never the feed).
- **Batch id:** default `<UTC yyyymmddThhmmss>Z` for `run`,
  `<…>Z-sweep` for `all` (one id shared by the whole sweep). `all` defaults:
  personas `liushang shengyin chawendao mangniu zhuiyi`, models
  `codex sonnet ds-flash`, `k=3`, `codex-k=1`.
- **Server and embedder must be up:** `/health` and the embedder health are
  checked first (exit 75 with a remedy line).
- `llm-smoke.sh` is not ported: `doctor --smoke` covers live calls per roster
  arm and `test_extract.py` covers parsing. DeepSeek's live check is
  `swil-agent bench run <persona> ds-flash --k 1`.

Deleted: `scripts/llm.sh`, `deepseek-env.sh`, `benchmark-run.sh`,
`benchmark-all.sh`, `llm-smoke.sh`, and the tests that pin Bash text in them
(replaced by equivalent pins on the Python argv and env).

## 9. Size cap

`tests/unit/test_architecture.py` gains: every `swil_agent/**/*.py` file has
≤ 600 physical lines. Files that exceed it after §4–§8 are split along their
existing seams:

- `act/round.py` → `act/memory_log.py` (memory-line formatting/writing),
  `act/similarity.py` (similarity sample + duplicate guard + `Embedder`
  protocol), `act/notifications.py` (marking), steps stay in `act/round.py`;
- `graph/nodes.py` → `graph/deps.py` (`CycleDeps`, helpers),
  `graph/nodes_act.py`, `graph/nodes_dream.py`, `graph/nodes_tail.py`
  (samplers, logout, cycle_run card);
- `api/resources.py` → `api/resources.py` (class + reads) with
  `api/writes.py` and `api/lab.py` mixins composed into `Resources`;
- `act/context.py` → `act/context_format.py` (pure formatters) +
  `act/context.py` (fetch/assemble, `build_context`);
- `act/executor.py` and `graph/cycle.py` split only if still > 600.

Splits move code verbatim; names re-exported from the original module only
where tests or other modules import them, and the plan lists those.

## 10. Docs

`CLAUDE.md` (cycle section, Bench section, backends call sites), `agent/README.md`,
`agent/HOWTO.md`, `docs/12-handoff.md` (S3 done, launch order unchanged),
`docs/13-observation-lab.md` (Bench commands). The Bench trigger phrases now map
to `swil-agent bench`.

## 11. Risks

- **Silent behaviour change before round 1.** Mitigation: I1 golden test first,
  then every task keeps it green; final review re-runs the full suite and the
  golden test against the S2 tree for comparison.
- **Test retargeting hides weakened assertions.** Mitigation: per-task review
  checks that the number of test functions does not drop except for deleted
  code paths, which the report lists.
- **Lease for `act`/`dream` changes contention behaviour.** A manual `act`
  next to a running round now SKIPs on the lease instead of the bare file lock
  — same outcome (SKIP, 75), stronger dead-pid recovery.
- **Bench results drift.** Mitigation: a fixture test runs the Python bench
  over a fake backend/embedder and asserts the exact JSON body.

## 12. Binding details (spec review, 2026-10-14)

These override §1–§11 wherever they conflict.

**Invariants**

1. **I1 covers `cycle` only, byte-unchanged.** The recorded golden files are
   immutable for the whole of S3. The harness's seam list (what it patches) lives
   in one helper and may be retargeted once, in the cli-split task.
2. **I1b — `act` / `dream` goldens** may change only by these deltas, each named
   in the task report where it first appears:
   (a) the busy-lock SKIP line text (lease remedy sentence instead of the
   `LockBusy` string); (b) `act` logs the `logout <name> — run_id=… outcome=…`
   line; (c) an `act` that would be OFFLINE while another run holds the act lease
   reports busy instead of OFFLINE (same exit 75); (d) the dream deadline check
   (no-op without a deadline); (e) retry policies (`LOGIN_RETRY`, `EXECUTE_RETRY`,
   `SNAPSHOT_RETRY`) now apply to subsets — no golden scenario exercises a
   transient error, so no golden changes from (e).
   (f) when the ACT lease is busy, the world-context reads, news runner call and
   health probe that today precede the lock attempt no longer happen (the lease is
   taken before the stream) — `act_lock_busy` only.
3. **Golden harness:** `JournalingResources(FakeResources)` appending
   `(method, args, kwargs)` for reads and writes to one list (`LabEvent` via
   `model_dump()`); `CliRunner` over `cli.app` with `_patch_cycle_seams`, a frozen
   clock and `--seed 0`; normalise the 32-hex run id, `durationMs`, log-line
   timestamps and `tmp_path`; snapshot `memory.md`, `personality.md`,
   `personality.archive.md` and the dream marker after each run. Scenarios: the
   plan's list plus an OFFLINE cycle, `BACKEND_UNAVAILABLE`, a guardrail-emptied
   plan, and an `act` with > 300 memory lines (rotation observable).

**Orchestration (§4)**

4. `build_graph(phases)` assembles a **separate** `StateGraph` per phase from the
   shared `make_*_node` factories. `build_graph(Phases.CYCLE)` is node-for-node and
   edge-for-edge today's graph (a test pins `get_graph()` nodes and edges).
   `CycleState` gains no key. `run_cycle` stays the public name for CYCLE (thin
   wrapper over `run_graph`).
5. ACT topology: login → plan → guardrail → execute → logout → END, with the same
   routers where they apply and a guardrail-emptied plan / OFFLINE going straight
   to logout. DREAM topology: dream → write → snapshot → END (a no-op dream ends).
6. **Deps are built per phase.** `DREAM`: no `context_now`, `feed_context` or news
   fetch (`memory_text=""`; `cooldown_step` reads memory itself), and
   `probe_embedder` runs **before** `select_backend`, as `_do_dream` does. `ACT`:
   no `probe_embedder`. `CYCLE`: unchanged. A dream golden pins "no feed/search
   reads, no `news-fetch.sh` in the runner".
7. **ACT logout** emits no card, logs the logout line, and rotates memory only when
   the outcome is not OFFLINE, under a **node-local, non-blocking dream lease**;
   busy → today's `memory rotation skipped for %s — dream lock held` INFO line and
   the act still succeeds. CYCLE's logout is unchanged.
8. `probe_board` is a `CycleDeps` field (`None` for CYCLE and DREAM) passed by the
   login node to `context_step`; `probe_post_ids` already rides on `ActContext`.
9. `ActResult` / `DreamResult` projections from state are equal to today's on
   every field that `_report_*` or the exit code reads.

**Locks (§5)**

10. Scope is `act`, `dream`, `cycle` only. `lease_kinds`: CYCLE (act, dream), ACT
    (act), DREAM (dream). §11's "stronger dead-pid recovery" is withdrawn: the file
    half refuses any fresh lock file regardless of pid; only rows reclaim by pid.
11. After unification nothing outside `RunLease` takes a `FileLock`; the
    architecture test checks `swil_agent/` only (tests may import `FileLock`).
    `act_lock_path`/`dream_lock_path` stay public in `locks/file.py`. `LockBusy`
    leaves `_KNOWN_SETUP_FAILURES` unless something still raises it (comment either
    way). `login_step` lock tests are deleted with the reason in the report.

**cli (§6)**

12. **Per-command preambles unchanged:** `act` and `cycle` keep the production
    guard, the era gate and the `round <id>` INFO line; `dream` has none of the
    three. Log attachment: `act` unfiltered `auto-run.log`, `dream` unfiltered
    `dream.log`, `cycle` the filtered pair.
13. **Seams:** `compose.now(tz=None)` replaces every `datetime.now()` read in cli
    at the same call sites and in the same order (tests count reads);
    `date.today()` in measure-status goes through `compose.today()`. Functions moved
    out of cli that read the clock take `now` as a parameter. `doctor.*` and
    `analysis.measure_status.*` are a documented second seam home (commands call
    them as module attributes). `backend_for(persona, settings)` keeps its
    two-argument signature. `cli/__init__.py` re-exports the `act`, `dream`,
    `cycle` command functions (docstrings intact). The Typer group is bound to
    `bench_app`, never to the name `bench` (it would shadow `swil_agent.cli.bench`).
14. **Layering:** `round_id.py` gains only pure functions (`thread_exists` /
    `latest` callables and `now` passed in) raising domain errors defined there
    (`SweepResumeRefused`, `NoCheckpoint`); `policy.py` raises domain errors and
    never imports Typer. cli maps them to `EXIT_*` and to `AccountSetupError` text
    that stays byte-identical. Homes for the rest: `lease_busy_guard`,
    `cycle_stores`, db paths → `cli/stores.py`; `backend_setup_guard`,
    `load_persona_or_raise_setup_error`, `ERA_START_REMEDY`, `env_flag` →
    `cli/errors.py` / `cli/compose.py`; `_report_*`, `_describe_plan` →
    `cli/report.py`; `roster_names`, `roster_count`, `era3_arms` → `doctor.py`.
15. **Patch targets follow the caller.** When a function moves, every
    `monkeypatch.setattr(module, name)` targets the module whose code looks the name
    up at call time; re-exports never stand in for that. Retargeting happens in the
    task that moves the code. Known sites: `nodes_module.<step>` (login, context,
    plan, execute, write, snapshot, behavior snapshot, population metric),
    `cycle_module.make_logout_node`, `act_round._write_memory_line`,
    `act_round.rotate_memory`, `round_module.execute_action`. Importers to keep:
    `register.py` (`sync_backend_step` from `act.round`), `test_act_similarity.py`.
16. **Logger names:** every moved module keeps its original logger name
    (`logging.getLogger("swil_agent.act.round")`, `"swil_agent.graph.nodes"` and its
    `.dream` child, `"swil_agent.cli"`, `"swil_agent.cli.dream"`, …). A test sends one
    record per such logger through `_attach_cycle_logs` and asserts the file.

**llm (§7)**

17. `Backend` protocol lives in `llm/protocol.py` (no cycle with `complete.py`);
    `build_backend` in `backends/__init__.py`. Homes: `DEFAULT_TIMEOUT` →
    `runner.py`; `DEEPSEEK_BASE_URL`, `DEEPSEEK_DEFAULT_MODEL`, the key reader →
    `backends/claude.py`. `remedy.py` is new. The `BackendKind` literals
    (`claude_cli`, …) are identifiers and stay. There is no existing DeepSeek
    architecture test: write one — `DeepSeekCLIBackend` is constructed only in
    `build_backend` and `swil_agent/bench/`, and the default kind stays
    `claude_cli`.

**Bench (§8)**

18. **Batch ids:** `run` default `<UTC %Y%m%dT%H%M%S>-<epoch ms>`, `all` default
    `<UTC %Y%m%dT%H%M%S>-sweep` (no `Z`, matching existing result files). ≤ 80 chars.
19. **Judge argv is the Bash argv exactly:** `claude --model <m> -p --tools ""
    --output-format text`, prompt on stdin, **no `--system-prompt`** (a dedicated
    judge call over the `Runner`, not `ClaudeCLIBackend`), so the judge series
    stays continuous. Env scrub removes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`. Score = first `[0-9]+`; > 100 or
    none or a failed call → `null` with a WARN (never clamped).
20. **Output processing as Bash:** strip trailing newlines, then
    `collapse_doubled_text`, then trim each line; empty → skipped. Fidelity rounded
    to 6 decimals; `null` if the reference or the output embed failed (embedder
    down degrades, it does not abort). `ruleScore = round(passed/applied, 3)`,
    `null` with `ruleDetail ""` when no rule applies; rule regexes match the **raw**
    `personality.md`. The archive file is pretty-printed JSON written before the
    POST.
21. **Deliberate changes from Bash** (listed in docs): unknown `--tasks` ids → exit
    64; task order follows `--tasks` when given; `/health` checked up front (75); a
    POST failure logs `post=ERR`, keeps the file, continues, and the run exits 75 if
    any POST failed; `all` continues past a failing pair and returns the worst
    code. Persona: no dir → 66; no `personality.md` / `api_key.txt` → 75. v1 files
    used raw, v2 files BOM/CR-stripped (as Bash); v2 display from `display_name`,
    v1 from the case-insensitive `- **Display Name:**` bullet; trailing newlines of
    `SYS` and the reference stripped.
22. **Env vars stay:** every flag defaults from its Bash env var via
    `typer.Option(envvar=...)`: `JUDGE`, `JUDGE_MODEL`, `BENCH_TASKS` (run and all),
    `PERSONAS`, `MODELS`, `K`, `CODEX_K` (all).
23. **Models:** `codex` and `ds-flash` as Bash; any other bare word is a claude alias
    (as Bash, so bare `grok` means `claude --model grok`); `<backend>:<model>`
    resolves through `llm.selection` / `factory.get_backend` exactly as a persona's
    `model:`, with `req.model=<model>`. `--codex-k` applies to every model whose
    backend is codex. `model` ≤ 40 chars.
24. **Ingest:** throttle to ≤ 18 POSTs/min per process and honour `Retry-After` on
    429 (reuse `retry_after_seconds`), like `backfill-post-vectors`, because
    `/agents/benchmark/runs` shares the 20/min `snapshotIngestLimiter`. The body
    satisfies `bench.schemas.ts` (persona regex, `output` ≤ 8000 — longer outputs
    are POSTed as is and fail visibly, never truncated).
25. Caller env: the model under test inherits the caller's env (as Bash; only
    `ds-flash` sets its own), the judge's is scrubbed.
26. Prior art in `.claude/worktrees/langsmith-tracing/` (unmerged, another
    branch) may be read for reference only; never modified; this spec wins.

**Size cap (§9) and docs (§10)**

27. The cap counts `swil_agent/**` only. Additional named seams:
    `graph/policies.py` (retry policies + their comment block) and `graph/run.py`
    (`run_graph`, `_acquire`, `lease_kinds`); `act/executor.py` helper block
    (`_clean`, `_error_detail`, `_outcome`, `_skip`) → `act/execution_outcome.py`;
    `cli/stores.py` (item 14).
28. Docs and UI also cover `client/src/features/lab/BenchmarkView.tsx` (the
    public `/lab` hint `bash agent/scripts/benchmark-all.sh` →
    `uv run --project agent swil-agent bench all`) and its test,
    `docs/03-api-reference.md`, `docs/18-persona-bench-findings.md` (current-state
    lines only).
