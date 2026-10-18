"""`prompt-ab`: the offline v1/v2 prompt comparison (spec 2026-10-17 §5).

Per account: the round's own reads with `act --dry-run` semantics (no lease,
no `agentBackend` PATCH, no execute, no lab event), then `k` samples per prompt
version against the account's pinned model. The rhythm is not rolled: within
an arm the accounts, sorted by name, alternate must-post / no-post
(`bench.prompt_ab.assign_policies`; one at the daily ceiling keeps the
ceiling verdict), and v1 and v2 share it. The dream
phase reads only `memory.md` and the notifications the dream reads, and
writes no `personality.md`. On demand only, never inside a round: it spends
about accounts x 2 x k LLM calls. The two-key runtime switch does not gate it
-- it is offline by construction -- and neither does `SWIL_REQUIRE_NON_PROD`,
which refuses production WRITES: this command issues reads only. The one
non-GET it can send is `POST /auth/login`, for an account with no
`api_key.txt` on the `SWIL_PASS` fallback (`compose.resources_for`, as `act
--dry-run` does): a session, not a platform write.
"""

from __future__ import annotations

import time
from datetime import UTC
from pathlib import Path

import typer

from swil_agent.act.round import context_step
from swil_agent.bench import prompt_ab as ab
from swil_agent.cli import compose
from swil_agent.cli.app import (
    DEFAULT_ACT_BUDGET,
    EXIT_NO_ACTION,
    EXIT_NO_SUCH_ACCOUNT,
    EXIT_OK,
    EXIT_USAGE,
)
from swil_agent.cli.errors import (
    enforce_era_gate,
    load_persona_or_raise_setup_error,
    skip_for_exception,
)
from swil_agent.config import Settings
from swil_agent.dream.round import memory_tail, read_group_memory
from swil_agent.embedder.client import EmbedderClient
from swil_agent.models import Persona, RhythmPolicy
from swil_agent.persona.format import PersonaFormatError, parse_persona
from swil_agent.persona.loader import split_model
from swil_agent.persona.source import PersonaSource

_PHASES = ("act", "dream")


def _roster_arms(agent_root: Path, roster: list[str]) -> set[str]:
    """The arm of EVERY roster account, read from its `model:` line so a
    persona that fails full validation still counts; one with no readable
    model is its own `unreadable:<name>` arm."""
    arms: set[str] = set()
    for name in roster:
        try:
            doc = parse_persona(
                (agent_root / "agents" / name / "personality.md").read_text("utf-8")
            )
            backend, model = split_model(doc.meta["model"])
            arms.add(f"{backend}:{model}" if model else backend)
        except (PersonaFormatError, OSError, KeyError, AttributeError, UnicodeDecodeError):
            arms.add(f"unreadable:{name}")
    return arms


def _roster(agent_root: Path) -> list[str]:
    return sorted(path.parent.name for path in (agent_root / "agents").glob("*/personality.md"))


def _dream_samples(
    name: str,
    persona: Persona,
    source: PersonaSource,
    settings: Settings,
    embedder: EmbedderClient,
    *,
    k: int,
) -> list[ab.DreamSample]:
    persona, backend = compose.select_backend(persona, settings)
    resources = compose.resources_for(persona, settings)
    tail = memory_tail(source.read_memory(name))
    group = read_group_memory(resources)
    return [
        ab.sample_dream(
            persona=persona,
            backend=backend,
            memory_tail=tail,
            group_memory=group,
            version=version,
            embedder=embedder,
            clock=time.monotonic,
        )
        for version in ab.VERSIONS
        for _ in range(k)
    ]


def _act_samples(
    persona: Persona,
    source: PersonaSource,
    settings: Settings,
    embedder: EmbedderClient,
    *,
    policy: RhythmPolicy,
    k: int,
    seed: int | None,
) -> list[ab.ActSample]:
    persona, deps, finish = compose.act_deps_for(
        persona,
        source,
        settings,
        dry_run=True,
        budget=DEFAULT_ACT_BUDGET,
        seed=seed,
        probe_board=None,
    )
    if finish is not None:
        deps = finish(deps)
    step = context_step(
        resources=deps.resources,
        persona=persona,
        memory_text=deps.memory_text,
        now=deps.now,
        rng=deps.rng,
        budget=deps.budget,
        context_now=deps.context_now,
        feed_context=deps.feed_context,
        era_start=settings.era_start,
        post_probability=settings.post_probability,
        post_ceiling=settings.post_ceiling_per_day,
        world=deps.world,
    )
    rhythm = ab.assigned_rhythm(
        policy,
        posts_today=step.context.today_post_count,
        probability=settings.post_probability,
        ceiling=settings.post_ceiling_per_day,
    )
    return [
        ab.sample_act(
            persona=persona,
            backend=deps.backend,
            context=step.context,
            rhythm=rhythm,
            version=version,
            embedder=embedder,
            clock=time.monotonic,
        )
        for version in ab.VERSIONS
        for _ in range(k)
    ]


def prompt_ab(
    accounts: str = typer.Option("all", "--accounts", help="`all`, or comma-separated names."),
    k: int = typer.Option(2, "--k", help="Samples per account and prompt version."),
    phase: str = typer.Option("act", "--phase", help="act | dream"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed each account's RNG; the rhythm is assigned, never rolled."
    ),
) -> None:
    """Compare prompt v1 and v2 offline on live, read-only contexts; never posts.

    Writes `bench/results/prompt-ab/<UTC stamp>-<phase>.json` and prints a table.
    Exit 0 written, 64 bad --phase/--k, 66 unknown account, 75 no sample at all.
    """
    if phase not in _PHASES or k < 1:
        typer.echo("--phase must be act or dream and --k at least 1", err=True)
        raise typer.Exit(EXIT_USAGE)
    settings = compose.load_settings()
    enforce_era_gate(settings)
    roster = _roster(settings.agent_root)
    names = roster if accounts == "all" else [n.strip() for n in accounts.split(",") if n.strip()]
    missing = [name for name in names if name not in roster]
    if missing:
        typer.echo(f"no such account: {', '.join(missing)}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT)

    source = compose.persona_source_for(settings)
    embedder = compose.embedder_for(settings)
    guard = compose.guard_for(settings)
    personas: dict[str, Persona] = {}
    skipped: list[str] = []
    for name in names:
        try:
            personas[name] = load_persona_or_raise_setup_error(source, name)
        except Exception as exc:
            skipped.append(name)
            skip_for_exception(name, exc)
    arms = {name: ab.arm_of(persona) for name, persona in personas.items()}
    policies = ab.assign_policies(arms)

    samples: list[ab.ActSample | ab.DreamSample] = []
    guard.up()
    try:
        for name, persona in personas.items():
            try:
                if phase == "dream":
                    samples.extend(_dream_samples(name, persona, source, settings, embedder, k=k))
                else:
                    samples.extend(
                        _act_samples(
                            persona,
                            source,
                            settings,
                            embedder,
                            policy=policies[name],
                            k=k,
                            seed=seed,
                        )
                    )
            except Exception as exc:
                skipped.append(name)
                skip_for_exception(name, exc)
    finally:
        guard.down()
    if not samples:
        raise typer.Exit(EXIT_NO_ACTION)

    generated = compose.now(UTC)
    report = ab.build_report(
        phase=phase,
        k=k,
        generated_at=generated.strftime("%Y-%m-%dT%H:%M:%SZ"),
        accounts=names,
        samples=samples,
        expected_arms=sorted(_roster_arms(settings.agent_root, roster) | set(arms.values())),
        skipped_accounts=skipped,
    )
    path = ab.write_report(
        report,
        settings.agent_root / "bench" / "results" / "prompt-ab",
        stamp=generated.strftime("%Y%m%dT%H%M%SZ"),
    )
    typer.echo(ab.render_table(report))
    typer.echo(f"report: {path}")
    raise typer.Exit(EXIT_OK)
