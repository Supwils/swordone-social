"""`swil-agent bench run|all`: the Persona Bench, composed.

The bench itself is `swil_agent/bench/`; this module only reads the flags,
builds the collaborators through `cli/compose.py`'s seams and maps a
`BenchStop` to its exit code. The Typer group is bound to `bench_app` and
registered as `bench` in `cli/__init__.py` -- never bound to the name `bench`,
which would shadow this module as an attribute of the package (S3 §12.13).

Every flag defaults from the environment variable that drove the Bash scripts
(S3 §12.22), so `BENCH_TASKS=free_post JUDGE=1 ...` and `PERSONAS=... MODELS=...
K=3 ...` keep working: `JUDGE`, `JUDGE_MODEL` and `BENCH_TASKS` on both
commands, `PERSONAS`, `MODELS`, `K` and `CODEX_K` on `all`. `--timeout`
(`BENCH_TIMEOUT`, new, default 1200 s) bounds each model-under-test call.

**The server and the embedder must be up.** Both are checked before anything
runs (exit 75 with the remedy) -- a deliberate change from Bash, which checked
neither and quietly filed a sweep of `null` fidelities (S3 §12.21).

**Caller env** (S3 §12.25): the model under test inherits this process's
environment, as it did in Bash -- only `ds-flash` sets its own; the judge's is
scrubbed of the DeepSeek variables (`bench/judge.py`).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, NoReturn

import typer

from swil_agent.bench.errors import EXIT_NO_ACTION, BenchStop
from swil_agent.bench.judge import DEFAULT_JUDGE_MODEL, Judge
from swil_agent.bench.models import DEFAULT_BENCH_TIMEOUT, check_model_spec, resolve_model
from swil_agent.bench.persona import BenchPersona, check_persona_name
from swil_agent.bench.runner import (
    BATTERY_PATH,
    DEFAULT_CODEX_K,
    DEFAULT_K,
    DEFAULT_MODELS,
    DEFAULT_PERSONAS,
    BenchDeps,
    BenchSink,
    Task,
    check_batch_id,
    load_battery,
    parse_task_ids,
    run_batch_id,
    run_pair,
    run_sweep,
    select_tasks,
    sweep_batch_id,
)
from swil_agent.cli import compose
from swil_agent.cli.errors import AccountSetupError
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderUnavailable

bench_app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Persona Bench: replay a persona offline through a model and score it. "
    "Never posts to the feed.",
)

# `runIndex` is `int().min(0).max(64)` on the server.
_MAX_K = 65

TasksOption = Annotated[
    str | None,
    typer.Option(
        "--tasks", envvar="BENCH_TASKS", help="Comma-separated task ids, run in this order."
    ),
]
JudgeOption = Annotated[
    bool,
    typer.Option("--judge/--no-judge", envvar="JUDGE", help="Also score with the LLM judge."),
]
JudgeModelOption = Annotated[
    str, typer.Option("--judge-model", envvar="JUDGE_MODEL", help="claude alias for the judge.")
]
TimeoutOption = Annotated[
    float,
    typer.Option(
        "--timeout",
        envvar="BENCH_TIMEOUT",
        min=1.0,
        help="Seconds per model-under-test call (the judge keeps 300).",
    ),
]


def _stop(stop: BenchStop) -> NoReturn:
    typer.echo(stop.message, err=True)
    raise typer.Exit(stop.code) from stop


def _err(line: str) -> None:
    typer.echo(line, err=True)


def _tasks(settings: Settings, raw: str | None) -> list[Task]:
    return select_tasks(load_battery(settings.agent_root / BATTERY_PATH), parse_task_ids(raw))


def _deps(settings: Settings, *, judge: bool, judge_model: str, timeout: float) -> BenchDeps:
    """The collaborators, after the up-front health checks."""
    if not compose.health_check(settings):
        raise BenchStop(
            EXIT_NO_ACTION,
            f"bench: server unreachable at {settings.swil_url}/health -- start it "
            "(`npm run dev`) or point SWIL_URL at one",
        )
    embedder = compose.embedder_for(settings)
    try:
        embedder.health()
    except EmbedderUnavailable as exc:
        raise BenchStop(
            EXIT_NO_ACTION,
            f"bench: embedder unreachable at {settings.embedder_url} ({exc}) -- start it: "
            "`bash agent/scripts/embedder/start.sh`",
        ) from exc
    runner = compose.runner_for(settings)

    def sink_for(persona: BenchPersona) -> BenchSink:
        try:
            return compose.resources_for_key(persona.directory, settings)
        except AccountSetupError as exc:
            raise BenchStop(EXIT_NO_ACTION, f"bench: {exc}") from exc

    def now() -> datetime:
        return compose.now(UTC)

    return BenchDeps(
        agent_root=settings.agent_root,
        resolve=lambda spec: resolve_model(spec, runner, settings, timeout=timeout),
        embedder=embedder,
        sink_for=sink_for,
        judge=Judge(runner, judge_model) if judge else None,
        now=now,
        emit=typer.echo,
        emit_err=_err,
    )


@bench_app.command("run")
def run(
    persona: Annotated[str, typer.Argument(help="Persona directory name.")],
    model: Annotated[
        str,
        typer.Argument(
            help="codex | ds-flash | a claude alias (opus, sonnet, haiku, ...) | "
            "<backend>:<model> (e.g. grok:grok-4.6)."
        ),
    ],
    k: Annotated[int, typer.Option("--k", min=1, max=_MAX_K, help="Runs per task.")] = DEFAULT_K,
    batch_id: Annotated[
        str | None,
        typer.Option("--batch-id", help="Default: <UTC %Y%m%dT%H%M%S>-<epoch ms>."),
    ] = None,
    tasks: TasksOption = None,
    judge: JudgeOption = False,
    judge_model: JudgeModelOption = DEFAULT_JUDGE_MODEL,
    timeout: TimeoutOption = DEFAULT_BENCH_TIMEOUT,
) -> None:
    """One persona x one model over the battery. Exit 0; 64 bad persona name
    / task id / model / batch id; 66 no such persona; 75 a setup failure, a
    service down, or any POST failed (the rows stay on disk)."""
    settings = compose.load_settings()
    try:
        batch = batch_id if batch_id is not None else run_batch_id(compose.now(UTC))
        check_batch_id(batch)
        check_persona_name(persona)
        check_model_spec(model)
        selected = _tasks(settings, tasks)
        deps = _deps(settings, judge=judge, judge_model=judge_model, timeout=timeout)
        code = run_pair(deps, selected, persona, model, k=k, batch_id=batch)
    except BenchStop as stop:
        _stop(stop)
    raise typer.Exit(code)


@bench_app.command("all")
def all_(
    personas: Annotated[
        str, typer.Option("--personas", envvar="PERSONAS", help="Space-separated personas.")
    ] = DEFAULT_PERSONAS,
    models: Annotated[
        str, typer.Option("--models", envvar="MODELS", help="Space-separated models.")
    ] = DEFAULT_MODELS,
    k: Annotated[
        int, typer.Option("--k", envvar="K", min=1, max=_MAX_K, help="Runs per task.")
    ] = DEFAULT_K,
    codex_k: Annotated[
        int,
        typer.Option(
            "--codex-k", envvar="CODEX_K", min=1, max=_MAX_K, help="Runs per task for codex."
        ),
    ] = DEFAULT_CODEX_K,
    tasks: TasksOption = None,
    judge: JudgeOption = False,
    judge_model: JudgeModelOption = DEFAULT_JUDGE_MODEL,
    timeout: TimeoutOption = DEFAULT_BENCH_TIMEOUT,
) -> None:
    """Every persona x every model under one `<UTC>-sweep` batch id. Goes on
    past a failing pair; exits with the worst pair's code. A bad persona
    name, model or task id is refused (64) before anything runs."""
    settings = compose.load_settings()
    persona_names = personas.split()
    model_specs = models.split()
    try:
        for name in persona_names:
            check_persona_name(name)
        for spec in model_specs:
            check_model_spec(spec)
        selected = _tasks(settings, tasks)
        deps = _deps(settings, judge=judge, judge_model=judge_model, timeout=timeout)
    except BenchStop as stop:
        _stop(stop)
    code = run_sweep(
        deps,
        selected,
        persona_names,
        model_specs,
        k=k,
        codex_k=codex_k,
        batch_id=sweep_batch_id(compose.now(UTC)),
        tasks_label=tasks,
    )
    raise typer.Exit(code)
