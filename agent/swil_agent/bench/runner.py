"""One persona x model bench run, and the sweep over many.

`run_pair` runs one persona x model pair; `run_sweep` runs the grid of them
(ported from the deleted `benchmark-run.sh` / `benchmark-all.sh`). For every
task of the battery, `k` times: call the model under test with the persona as
the system prompt and the task as the user prompt, clean the answer, score it,
archive it, POST it. Field for field with the Bash it replaced, so the rows stay one
series (S3 §8, §12.18-§12.25):

  * an empty answer -- including a model that said nothing
    (`BackendUnavailableError`, Bash's `llm_text ... || true`) -- is skipped,
    not scored and not posted;
  * fidelity fails open to `null` when an embed fails, the reference's
    included (the embedder going down mid-run degrades, it does not abort);
  * the archive file is pretty-printed JSON written BEFORE the POST, so a
    failed POST still leaves the row on disk (the source of truth);
  * a failed POST prints `post=ERR` and the run goes on.

Deliberate changes from Bash (S3 §12.21), each pinned by a test: unknown task
ids, and a `--tasks` that names none, are refused (64) and `--tasks` order is
kept; the model under test runs under the bench's own timeout (1200 s by
default, where Bash had none) and a timed-out call is reported as `TIMEOUT`; a
run with any failed POST exits 75 instead of 0; the sweep goes on past a
failing pair and returns the worst code; the POSTs go through the same
throttle and `Retry-After` wait as `backfill-post-vectors`, because
`/agents/benchmark/runs` sits behind the server's 20/min
`snapshotIngestLimiter` and one pair at k=3 is 30 POSTs. And one the spec
leaves to the port: a backend that cannot run at all (a missing binary, a
refused configuration) stops the run with 75, where Bash would have filed
nothing and exited 0 with a screen of `EMPTY` lines.

Nothing here reads the clock, sleeps or prints on its own: `BenchDeps` carries
all of it, so a test runs a whole sweep instantly.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final, Protocol

from swil_agent.api.client import ApiError
from swil_agent.api.ingest_throttle import (
    INGESTS_PER_MINUTE,
    THROTTLE_WINDOW_SECONDS,
    IngestThrottle,
    RateLimited,
    retry_after_seconds,
    retry_rate_limited,
)
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.bench.errors import EXIT_NO_ACTION, EXIT_USAGE, BenchStop
from swil_agent.bench.judge import Judge
from swil_agent.bench.models import ModelUnderTest, is_codex
from swil_agent.bench.persona import BenchPersona, load_bench_persona
from swil_agent.bench.rules import clean_output, rule_score, vector_fidelity
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.errors import (
    BackendBinaryMissingError,
    BackendConfigurationError,
    BackendUnavailableError,
)
from swil_agent.llm.runner import CompletionRequest

logger = logging.getLogger(__name__)

BATTERY_PATH: Final = Path("bench") / "battery" / "tasks.json"
RESULTS_PATH: Final = Path("bench") / "results"

# `benchmark-all.sh:21-24`.
DEFAULT_PERSONAS: Final = "liushang shengyin chawendao mangniu zhuiyi"
DEFAULT_MODELS: Final = "codex sonnet ds-flash"
DEFAULT_K: Final = 3
DEFAULT_CODEX_K: Final = 1

# `benchmarkRunIngest.batchId` is `z.string().trim().min(1).max(80)`.
MAX_BATCH_ID_LENGTH: Final = 80

POST_FAILED: Final = "ERR"


@dataclass(frozen=True)
class Task:
    id: str
    kind: str
    prompt: str


def load_battery(path: Path) -> list[Task]:
    """The frozen battery's tasks, in file order."""
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    return [
        Task(id=str(item["id"]), kind=str(item.get("kind", "")), prompt=str(item["prompt"]))
        for item in payload["tasks"]
    ]


def parse_task_ids(raw: str | None) -> list[str] | None:
    """`BENCH_TASKS` / `--tasks` as Bash split it (`tr ',' '\\n' | tr -d ' '`,
    then word splitting): `None` (the whole battery) when unset, else the ids
    in the order given.

    A value that is SET but names no task (`--tasks ""`, `BENCH_TASKS=" "`,
    `","`) is refused (64): Bash ran nothing for it, and silently running
    the whole battery instead errs in the expensive direction. An EMPTY
    `BENCH_TASKS=` is unset to Click, and to Bash's `[[ -n ... ]]` too --
    the whole battery, in both."""
    if raw is None:
        return None
    ids = raw.replace(",", "\n").replace(" ", "").split()
    if not ids:
        raise BenchStop(EXIT_USAGE, f"bench: --tasks {raw!r} names no task")
    return ids


def select_tasks(battery: Sequence[Task], ids: Sequence[str] | None) -> list[Task]:
    """The whole battery, or the named tasks in the order named. An unknown
    id is refused (64): Bash ran the model on an EMPTY prompt for it and
    filed the answer as a row of a task that does not exist."""
    if ids is None:
        return list(battery)
    by_id = {task.id: task for task in battery}
    unknown = [task_id for task_id in ids if task_id not in by_id]
    if unknown:
        raise BenchStop(
            EXIT_USAGE,
            f"bench: unknown task id(s) {', '.join(unknown)} -- the battery has {', '.join(by_id)}",
        )
    return [by_id[task_id] for task_id in ids]


def run_batch_id(now: datetime) -> str:
    """`benchmark-run.sh:36`: `<UTC %Y%m%dT%H%M%S>-<epoch ms>`, no `Z`."""
    moment = now.astimezone(UTC)
    return f"{moment:%Y%m%dT%H%M%S}-{int(moment.timestamp() * 1000)}"


def sweep_batch_id(now: datetime) -> str:
    """`benchmark-all.sh:25`: `<UTC %Y%m%dT%H%M%S>-sweep`, no `Z` -- the
    shape every existing `results/*/*/*-sweep__*` file has."""
    return f"{now.astimezone(UTC):%Y%m%dT%H%M%S}-sweep"


def check_batch_id(batch_id: str) -> None:
    if not batch_id.strip() or len(batch_id) > MAX_BATCH_ID_LENGTH or "/" in batch_id:
        raise BenchStop(
            EXIT_USAGE,
            f"bench: batch id {batch_id!r} must be 1-{MAX_BATCH_ID_LENGTH} characters, no '/'",
        )


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class BenchSink(Protocol):
    """Where a scored run is filed: `Resources.record_benchmark_run`."""

    def record_benchmark_run(self, body: dict[str, Any]) -> str: ...


@dataclass
class BenchDeps:
    """Every collaborator a bench run reaches, built once per command.

    `resolve` turns a model string into its backend (`models.resolve_model`
    in production); `sink_for` opens the persona's own key (the POST must be
    authorised as that persona); `now` is the wall clock (batch ids,
    `capturedAt`), `clock` the monotonic one (latency, the throttle).
    `throttle` is built from `clock` and `sleep` and shared by the whole
    sweep: <= 18 POSTs a minute per process.
    """

    agent_root: Path
    resolve: Callable[[str], ModelUnderTest]
    embedder: Embedder
    sink_for: Callable[[BenchPersona], BenchSink]
    judge: Judge | None
    now: Callable[[], datetime]
    emit: Callable[[str], None]
    emit_err: Callable[[str], None]
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    throttle: IngestThrottle = field(init=False)

    def __post_init__(self) -> None:
        self.throttle = IngestThrottle(
            limit=INGESTS_PER_MINUTE,
            window=THROTTLE_WINDOW_SECONDS,
            clock=self.clock,
            sleep=self.sleep,
        )


def _embed(embedder: Embedder, text: str) -> list[float] | None:
    """One text's vector, or `None` on any failure (`embed_one`'s empty)."""
    try:
        vectors = embedder.embed([text])
    except (EmbedderUnavailable, ValueError):
        return None
    return vectors[0] if vectors and vectors[0] else None


def _show(value: float | int | None) -> str:
    return "null" if value is None else str(value)


def _post(deps: BenchDeps, sink: BenchSink, body: dict[str, Any]) -> str:
    """The row's id, or `ERR`. Every attempt goes through the throttle; a
    429 waits what the server said (`Retry-After`, else a minute) and is
    retried up to `MAX_RATE_LIMIT_RETRIES` times -- `backfill-post-vectors`'s
    policy against the same limiter (`api/ingest_throttle.py`)."""

    def attempt() -> str | RateLimited:
        try:
            return sink.record_benchmark_run(body)
        except WriteNotVerifiedError as exc:
            logger.warning("WARN bench POST not filed: %s", exc)
            return POST_FAILED
        except ApiError as exc:
            if exc.status != 429:
                logger.warning("WARN bench POST failed: %s", exc)
                return POST_FAILED
            return RateLimited(retry_after_seconds(exc.headers), cause=exc)

    def on_retry(wait: float) -> None:
        logger.warning("WARN bench POST rate-limited; retrying in %.0f s", wait)

    outcome = retry_rate_limited(
        attempt, throttle=deps.throttle, sleep=deps.sleep, on_retry=on_retry
    )
    if isinstance(outcome, RateLimited):
        logger.warning("WARN bench POST failed: %s", outcome.cause)
        return POST_FAILED
    return outcome


def _complete(model: ModelUnderTest, persona: BenchPersona, task: Task) -> str:
    """The raw answer; `""` for a model that said nothing. A backend that
    cannot run at all stops the run (75) instead of filing nothing."""
    request = CompletionRequest(system=persona.system, user=task.prompt, model=model.model)
    try:
        return model.backend.complete(request)
    except BackendUnavailableError:
        return ""
    except (BackendBinaryMissingError, BackendConfigurationError) as exc:
        raise BenchStop(EXIT_NO_ACTION, f"bench: model {model.spec!r} cannot run -- {exc}") from exc


def _write_archive(path: Path, body: dict[str, Any]) -> None:
    """`jq '.'`: two-space indent, non-ASCII as is, one trailing newline."""
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_pair(
    deps: BenchDeps,
    tasks: Sequence[Task],
    persona_name: str,
    model_spec: str,
    *,
    k: int,
    batch_id: str,
) -> int:
    """One persona x one model over `tasks`, `k` runs each. Returns 0, or
    75 when any POST failed. Raises `BenchStop` for a persona or model that
    cannot run (66 / 75 / 64)."""
    persona = load_bench_persona(deps.agent_root, persona_name)
    model = deps.resolve(model_spec)
    sink = deps.sink_for(persona)
    out_dir = deps.agent_root / RESULTS_PATH / persona.name / model.dir_name
    out_dir.mkdir(parents=True, exist_ok=True)

    reference_vector = _embed(deps.embedder, persona.reference)
    if reference_vector is None:
        deps.emit_err("bench: embedder unreachable — vectorFidelity will be null")

    deps.emit(
        f"=== Persona Bench: @{persona.name} × {model.spec} × k={k}  "
        f"({len(tasks)} tasks)  batch={batch_id} ==="
    )
    failed_posts = 0
    for task in tasks:
        for index in range(k):
            if model.watch is not None:
                model.watch.reset()
            started = deps.clock()
            raw = _complete(model, persona, task)
            latency_ms = int((deps.clock() - started) * 1000)
            if model.watch is not None and model.watch.timed_out:
                deps.emit(
                    f"  [{task.id}#{index}] TIMEOUT ({model.spec}, "
                    f"{model.watch.timeout:.0f}s) — skipped"
                )
                continue
            output = clean_output(raw)
            if not output:
                deps.emit(f"  [{task.id}#{index}] EMPTY ({model.spec}) — skipped")
                continue

            fidelity: float | None = None
            if reference_vector is not None:
                output_vector = _embed(deps.embedder, output)
                if output_vector is not None:
                    fidelity = vector_fidelity(reference_vector, output_vector)
            rules = rule_score(persona.raw, output)
            judge = deps.judge.score(persona.reference, output) if deps.judge else None

            body: dict[str, Any] = {
                "batchId": batch_id,
                "persona": persona.name,
                "personaDisplay": persona.display,
                "model": model.spec,
                "taskId": task.id,
                "taskKind": task.kind,
                "runIndex": index,
                "output": output,
                "vectorFidelity": fidelity,
                "judgeScore": judge,
                "ruleScore": rules.score,
                "ruleDetail": rules.detail,
                "latencyMs": latency_ms,
                "capturedAt": f"{deps.now().astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}",
            }
            # The archive is the source of truth: written before the POST.
            _write_archive(out_dir / f"{batch_id}__{task.id}__{index}.json", body)
            posted = _post(deps, sink, body)
            if posted == POST_FAILED:
                failed_posts += 1
            deps.emit(
                f"  [{task.id}#{index}] fid={_show(fidelity)} rule={_show(rules.score)} "
                f"judge={_show(judge)} {latency_ms}ms  post={posted[:8]}"
            )

    deps.emit(f"=== done @{persona.name} × {model.spec} (batch={batch_id}) ===")
    if failed_posts:
        deps.emit_err(
            f"bench: {failed_posts} POST(s) failed for @{persona.name} × {model.spec} -- "
            f"the rows are on disk under {out_dir}"
        )
        return EXIT_NO_ACTION
    return 0


def run_sweep(
    deps: BenchDeps,
    tasks: Sequence[Task],
    personas: Sequence[str],
    models: Sequence[str],
    *,
    k: int,
    codex_k: int,
    batch_id: str,
    tasks_label: str | None,
) -> int:
    """Every persona x every model under ONE batch id, so `/lab`'s
    leaderboard and matrix read the sweep as one. A codex model runs
    `codex_k` times per task (codex is ~3x slower). A pair that fails is
    reported and the sweep goes on; the return is the worst exit code."""
    deps.emit(f"############ Persona Bench sweep  batch={batch_id} ############")
    deps.emit(f"personas: {' '.join(personas)}")
    deps.emit(f"models:   {' '.join(models)}")
    deps.emit(f"tasks:    {tasks_label or '<full battery>'}   K={k} (codex K={codex_k})")
    deps.emit("")
    worst = 0
    for persona in personas:
        for model in models:
            runs = codex_k if is_codex(model) else k
            try:
                code = run_pair(deps, tasks, persona, model, k=runs, batch_id=batch_id)
            except BenchStop as stop:
                deps.emit_err(stop.message)
                code = stop.code
            worst = max(worst, code)
    deps.emit("")
    deps.emit(f"############ sweep complete: batch={batch_id} ############")
    deps.emit("view: /lab?view=benchmark")
    return worst
