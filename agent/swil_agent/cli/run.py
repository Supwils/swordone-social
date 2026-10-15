"""`act`, `dream` and `cycle`: the three commands that run an account's round.

Exit codes are the external contract (`cli/app.py`); the mapping, by command:

  * `act`  -- `ActResult.grants_dream` (design spec §7.1) IS the exit-code
    decision: `True` (landed, partial, vetoed-empty, planner-empty -- every
    outcome except a dead backend or an unreachable platform) exits 0,
    `False` exits 75. A rhythm-vetoed or deliberately empty plan is NOT a
    failure: conflating them is exactly the bug `grants_dream` exists to fix
    (CLAUDE.md, "Empty plan counts as failure"). A caller that branches on
    this exit code to decide whether to run `dream` next gets that decision.
  * `dream` -- `DreamResult.proceeded` is the exit-code decision:
    `False` (a cooldown SKIP -- the LLM was never even called) exits 75,
    matching "no action ran"; `True` (the dream ran, whether its list was
    written or the reply was unusable) exits 0, matching
    "something ran". This mirrors `act`'s "attempted vs never-attempted" shape
    rather than inventing a third scheme.
  * `cycle` -- `act`'s and `dream`'s codes, plus 64 for a refused sweep
    resume.
  * Everything else -- ANY exception, not an enumerated list of them --
    also exits 75, via ONE broad guard wrapping composition-plus-run in each
    command; `cli/errors.py`'s `skip_for_exception` draws the one
    distinction inside it:

      - `AccountSetupError` (raised only by the CLI's own composition
        helpers, at the exact point each one knows both the cause and the
        remedy: `compose.resources_for` for no credentials or a failed
        `PasswordAuth.login()`, `compose.backend_for` for a dead backend key,
        `load_persona_or_raise_setup_error` for a personality.md that
        exists but won't parse, `lease_busy_guard` for an account another
        run holds) is a KNOWN, remediable setup problem -- not a bug. Its
        own message (already a complete "cause -- remedy" sentence) becomes
        the SKIP line verbatim.
      - Anything else is, by definition, NOT one of those -- a genuine
        programming error. Logged as `UNEXPECTED <ExceptionType>: <message>`
        (never disguised as a setup problem someone could fix by running
        `swil-agent register`) with its traceback at DEBUG, so it is recoverable
        by whoever is looking without being the operator's primary output.

Per-command preambles are deliberately different (S3 §12.12): `act` and
`cycle` run the production guard, the era gate and log the `round <id>`
line; `dream` has none of the three. Every collaborator is reached through
`compose`, so one `monkeypatch.setattr(compose, ...)` covers all three.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC

import typer

from swil_agent import round_id as round_ids
from swil_agent.cli import compose
from swil_agent.cli.app import EXIT_NO_ACTION, EXIT_NO_SUCH_ACCOUNT, EXIT_OK, EXIT_USAGE
from swil_agent.cli.errors import (
    AccountSetupError,
    SweepResumeRefusedError,
    enforce_era_gate,
    enforce_production_guard,
    load_persona_or_raise_setup_error,
    skip_for_exception,
)
from swil_agent.cli.logs import (
    ACT_LOG_FILENAME,
    DREAM_LOG_FILENAME,
    attach_cycle_logs,
    attach_round_log,
)
from swil_agent.cli.report import report_act_result, report_cycle_result, report_dream_result
from swil_agent.cli.stores import CycleStores, checkpoint_db_path, checkpoint_db_path_hint
from swil_agent.config import Settings
from swil_agent.graph.checkpoint import (
    Checkpointer,
    checkpointer_at,
    latest_round_id,
    thread_exists,
)
from swil_agent.graph.cycle import Phases, run_cycle
from swil_agent.graph.deps import agent_dir_name
from swil_agent.graph.outcome import act_result_of, cycle_granted_dream, dream_result_of
from swil_agent.graph.run import run_graph
from swil_agent.graph.state import BUILTIN_TENANT, thread_id

logger = logging.getLogger("swil_agent.cli")


def act(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
    i_mean_production: bool = typer.Option(
        False,
        "--i-mean-production",
        help="Allow writes against the production host when SWIL_REQUIRE_NON_PROD=1.",
    ),
    probe_board: str | None = typer.Option(
        None,
        "--probe-board",
        help="Overlay this board's latest posts into the planner feed. Requires --dry-run.",
    ),
) -> None:
    """Run the act phase for one account: the `Phases.ACT` LangGraph run
    (login -> plan -> guardrail -> execute -> logout).

    It holds the act lease for the run (`graph/run.py`), so a manual `act`
    beside a sweep's `cycle` of the same account SKIPs with exit 75 and the
    lease's remedy line, before any read. Logout rotates `memory.md` under a
    dream lease of its own, taken non-blocking; it files no cycle_run card.

    `--dry-run` is the shadow-round mode (design spec §9.4): it builds
    context and produces a plan but executes nothing, writes nothing, and --
    since it needs no mutual exclusion -- takes no lease either, so it can
    never make a concurrent real round lose the race and SKIP. Every step
    the graph runs is inert under it, and this command adds no writes of its
    own on that path either.

    An `EmbedderClient` is handed to the graph for the shadow act-path
    self-similarity sample (Phase B task 2). NO `probe_embedder` call and no
    `EmbedderGuard` bracket go with it, unlike `dream`/`cycle` -- see
    `compose.act_deps_for`.

    Two `try` blocks, not one, so exit 66 can only ever mean "this account
    directory does not exist" (fix wave, F5). Folding them together let ANY
    `FileNotFoundError` raised during the round -- most importantly
    `subprocess`'s, for a `claude`/`codex` binary missing from PATH -- be
    reported as "no such account", sending whoever is debugging to the roster
    instead of to PATH. `dream` has always had this shape; `act` now matches
    it.
    """
    settings = compose.load_settings()
    enforce_production_guard(settings, i_mean_production=i_mean_production)
    if probe_board and not dry_run:
        typer.echo("--probe-board requires --dry-run", err=True)
        raise typer.Exit(2)
    attach_round_log(settings, ACT_LOG_FILENAME)
    persona_source = compose.persona_source_for(settings)
    try:
        persona = load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    enforce_era_gate(settings)

    try:
        round_id = _act_round_id(settings, agent_dir_name(persona), dry_run=dry_run)
        logger.info("%s — round %s", name, round_id)
        with (
            compose.cycle_stores(settings, dry_run=dry_run, checkpoint=False) as stores,
            compose.backend_setup_guard(persona),
            compose.lease_busy_guard(name),
        ):
            persona, deps, finish = compose.act_deps_for(
                persona,
                persona_source,
                settings,
                dry_run=dry_run,
                budget=budget,
                seed=seed,
                probe_board=probe_board,
                backend_override=backend,
                model_override=model,
            )
            final = run_graph(
                deps,
                phases=Phases.ACT,
                persona=persona,
                lease_db=stores.lease_db,
                round_id=round_id,
                finish_deps=finish,
            )
        result = act_result_of(final)
        if result is None:
            # Unreachable for the ACT topology (every path sets an outcome);
            # an invented outcome would report a round that did not happen.
            raise RuntimeError("the act graph ended without an act outcome")
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if probe_board and result.plan is not None:
        from swil_agent.act.probe import load_probe_battery, score_probe_plan

        battery = load_probe_battery(settings.agent_root)
        score = score_probe_plan(
            result.plan,
            canaries=battery.canaries,
            attacker_usernames=battery.attacker_usernames,
            probe_post_ids=result.context.probe_post_ids if result.context else (),
        )
        typer.echo(
            json.dumps(
                {
                    "probe": True,
                    "hard_hit": score.hard_hit,
                    "soft_hit": score.soft_hit,
                    "missed": score.missed,
                    "matched": list(score.matched),
                }
            )
        )
    report_act_result(name, result, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if result.grants_dream else EXIT_NO_ACTION)


def dream(
    name: str,
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h cooldown."),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
) -> None:
    """Run the dream phase for one account: the `Phases.DREAM` LangGraph run
    (dream -> write -> snapshot), under the dream lease. `--auto` honours the
    cooldown exactly as before; without it the account dreams regardless.

    Brackets the embedder daemon for a real
    round (`up` before, `down` after), because the guard bracket belongs at
    the caller composing multiple accounts' dreams -- i.e. here -- and not
    inside a graph node.

    This docstring used to add "`act/round.py` never touches the embedder at
    all" as the reason only this command needs the guard. That stopped being
    true on 2026-08-19: `execute_step` now takes a shadow self-similarity
    sample through an injected embedder (Phase B task 2). The conclusion is
    unchanged and the reason is now a different one -- that sample feeds the
    enforcing duplicate guard (>= 0.92 drops the post) and fails open when the
    daemon is down. A standalone `act` brackets no embedder guard (the round
    always runs `cycle`, which does), where a dream's snapshot upload needs it.
    """
    settings = compose.load_settings()
    attach_round_log(settings, DREAM_LOG_FILENAME)
    persona_source = compose.persona_source_for(settings)
    try:
        persona = load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    guard = compose.guard_for(settings)
    try:
        guard.up()
        with (
            compose.cycle_stores(settings, dry_run=False, checkpoint=False) as stores,
            compose.backend_setup_guard(persona),
            compose.lease_busy_guard(name),
        ):
            persona, deps, _ = compose.dream_deps_for(
                persona,
                persona_source,
                settings,
                auto=auto,
                backend_override=backend,
                model_override=model,
            )
            final = run_graph(deps, phases=Phases.DREAM, persona=persona, lease_db=stores.lease_db)
        result = dream_result_of(final)
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    report_dream_result(name, result)
    raise typer.Exit(EXIT_OK if result.proceeded else EXIT_NO_ACTION)


def cycle(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    resume: bool = typer.Option(
        False, "--resume", help="Continue this account's last checkpointed cycle."
    ),
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h dream cooldown."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
    backend: str | None = typer.Option(
        None,
        "--backend",
        help="Override the backend: claude | codex | deepseek | api. Outranks personality.md.",
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the model id. Outranks personality.md."
    ),
    i_mean_production: bool = typer.Option(
        False,
        "--i-mean-production",
        help="Allow writes against the production host when SWIL_REQUIRE_NON_PROD=1.",
    ),
) -> None:
    """Run login -> act -> dream -> logout for one account as ONE LangGraph run.

    Exit codes are `act`'s and `dream`'s (ruling R17), because `cycle-one.sh`
    and the round driver branch on exactly those three: `0` the cycle ran,
    `66` no such account, `75` a setup failure or a busy lease. `0` vs `75`
    is `ActResult.grants_dream` over the final state's outcome -- the same
    decision `act` exits on.

    **`--auto` defaults to OFF.** `cycle-one.sh` always passes it, which
    honours the dream cooldown; without it the account dreams every round
    regardless of `DREAM_COOLDOWN_HOURS`. The flag is spelled and defaulted
    exactly like `swil-agent dream`'s, so the CLI has one meaning for it.

    **`--dry-run` takes NO lease and NO checkpoint.** A shadow round executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock costs a concurrent real round its whole turn (F4). It also
    does not dream: `write_step`/`snapshot_step` have no `dry_run` to be inert
    under, so `graph/cycle.py` routes a dry cycle from the act phase straight
    to logout (design spec §9.4, "executes nothing and writes nothing").

    **`--resume`** continues the last checkpointed cycle for this account,
    reusing its `thread_id`. The round id is read back out of the checkpoint
    database (`latest_round_id`) rather than recomputed from the clock, which
    would produce a different thread and silently start a fresh cycle. A
    sweep's thread (`-r`) resumes only under that sweep's own
    `SWIL_ROUND_ID`; otherwise exit 64 -- run a fresh manual `cycle`.
    """
    settings = compose.load_settings()
    enforce_production_guard(settings, i_mean_production=i_mean_production)
    attach_cycle_logs(settings)
    persona_source = compose.persona_source_for(settings)
    try:
        persona = load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    enforce_era_gate(settings)

    # A shadow round never reaches the dream phase, so it needs no embedder --
    # and starting one is not free: `EmbedderGuard.up()` writes
    # `.agent-state/embedder_guard/*` and `logs/embedder.log`, and can `nohup`
    # the bge-m3 daemon for up to 150s. `compose.DryRunGuard` is the no-op that
    # keeps `guard.up()`/`guard.down()` unconditional in the control flow (the
    # `finally` below must not have to know which kind it holds).
    guard: compose.Guard = compose.DryRunGuard() if dry_run else compose.guard_for(settings)
    try:
        guard.up()
        with (
            compose.cycle_stores(settings, dry_run=dry_run) as stores,
            compose.backend_setup_guard(persona),
            compose.lease_busy_guard(name),
        ):
            # Resolved here rather than inside `cycle_deps_for` because
            # `run_cycle` takes the persona separately from the deps, and both
            # have to carry the same answer -- see `compose.select_backend`.
            persona, llm = compose.select_backend(
                persona, settings, backend_override=backend, model_override=model
            )
            dir_name = agent_dir_name(persona)
            round_id = (
                _resume_round_id(stores, dir_name, env_round_id=settings.swil_round_id)
                if resume
                else _fresh_round_id(settings, stores.checkpointer, dir_name)
            )
            logger.info("%s — round %s", name, round_id)
            final = run_cycle(
                persona=persona,
                deps=compose.cycle_deps_for(
                    persona,
                    persona_source,
                    settings,
                    dry_run=dry_run,
                    auto=auto,
                    budget=budget,
                    seed=seed,
                    backend=llm,
                ).deps,
                lease_db=stores.lease_db,
                checkpointer=stores.checkpointer,
                round_id=round_id,
                resume=resume,
            )
    except SweepResumeRefusedError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(EXIT_USAGE) from exc
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    report_cycle_result(name, final, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if cycle_granted_dream(final) else EXIT_NO_ACTION)


# ── round ids (the policy is `swil_agent/round_id.py`; this is its I/O) ──


def _resume_round_id(stores: CycleStores, agent: str, *, env_round_id: str | None) -> str:
    """The round id `--resume` continues, read back out of the checkpoint
    database (`round_id.resume_round_id` decides; this maps its refusals).

    A SWEEP thread (`-r`) resumes only when `env_round_id` (`SWIL_ROUND_ID`)
    is that same id -- the sweep re-launching its own account; anything else
    raises `SweepResumeRefusedError` (exit 64). A manual (`-m`) thread
    resumes as is.
    """
    checkpointer = stores.checkpointer
    if checkpointer is None:
        raise AccountSetupError(
            f"{agent}: --resume and --dry-run are mutually exclusive -- a shadow "
            "round writes no checkpoint, so there is nothing to continue from"
        )
    try:
        return round_ids.resume_round_id(
            lambda: latest_round_id(checkpointer, BUILTIN_TENANT, agent),
            env_round_id=env_round_id,
        )
    except round_ids.NoCheckpoint as exc:
        raise AccountSetupError(
            f"{agent}: no checkpointed cycle to resume -- run "
            f"`swil-agent cycle {agent}` (without --resume) first, or check that "
            f"{checkpoint_db_path_hint()} still exists"
        ) from exc
    except round_ids.SweepResumeRefused as exc:
        found = exc.round_id
        raise SweepResumeRefusedError(
            f"{agent}: refusing to --resume sweep round {found} -- only that sweep "
            f"(SWIL_ROUND_ID={found}) may resume its own thread; a late resume would "
            f"file this cycle's data under the sweep. Run a fresh manual "
            f"`swil-agent cycle {agent} --auto` (without --resume) instead"
        ) from exc


def _fresh_round_id(settings: Settings, checkpointer: Checkpointer | None, agent: str) -> str:
    """The round id a NON-resumed cycle runs under (`round_id.fresh_round_id`).

    `checkpointer` is `None` on a dry run, which has no database to ask: the
    guard then answers "no thread", and the label goes nowhere anyway.
    """
    return round_ids.fresh_round_id(
        settings.swil_round_id,
        now=compose.now(UTC),
        thread_exists=lambda rid: thread_exists(
            checkpointer, thread_id(BUILTIN_TENANT, agent, rid)
        ),
    )


def _act_round_id(settings: Settings, agent: str, *, dry_run: bool) -> str:
    """`act`'s round id (`round_id.act_round_id`). The DB is only OPENED when
    it already exists and the run is real: opening it runs `setup()`, a
    write, and a dry run writes nothing. A DB that cannot be opened loses the
    guard, not the round."""
    db = checkpoint_db_path(settings)
    if not dry_run and db.exists():
        try:
            with checkpointer_at(db) as saver:
                return round_ids.act_round_id(
                    settings.swil_round_id,
                    now=compose.now(UTC),
                    thread_exists=lambda rid: thread_exists(
                        saver, thread_id(BUILTIN_TENANT, agent, rid)
                    ),
                )
        except sqlite3.Error as exc:
            logger.warning("could not read %s for the round-id guard: %s", db, exc)
    return round_ids.act_round_id(settings.swil_round_id, now=compose.now(UTC), thread_exists=None)
