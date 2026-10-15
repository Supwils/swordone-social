"""What `act`, `dream` and `cycle` print about a finished round.

One renderer per phase result, and `cycle` composes the two, so the three
commands cannot drift into three wordings of the same outcome.
"""

from __future__ import annotations

import typer

from swil_agent.graph.outcome import act_result_of, dream_result_of
from swil_agent.graph.state import CycleState
from swil_agent.models import ActResult, DreamResult


def describe_plan(result: ActResult) -> str:
    if result.plan is None or not result.plan.actions:
        return "(nothing)"
    return ", ".join(action.kind for action in result.plan.actions)


def report_act_result(name: str, result: ActResult, *, dry_run: bool) -> None:
    if dry_run:
        typer.echo(
            f"[dry-run] {name}: outcome={result.outcome.value} -- "
            f"would execute: {describe_plan(result)}"
        )
    else:
        typer.echo(
            f"{name}: outcome={result.outcome.value} landed={result.landed}/{result.attempted}"
        )
    if result.rhythm is not None and result.rhythm.roll is not None:
        typer.echo(
            f"  rhythm: policy={result.rhythm.policy.value} roll={result.rhythm.roll}"
            f"/{result.rhythm.post_probability}"
        )
    for vetoed in result.vetoed:
        typer.echo(f"  vetoed: {vetoed.action.kind} -- {vetoed.reason}")


def report_dream_result(name: str, result: DreamResult) -> None:
    if not result.proceeded:
        typer.echo(f"SKIP {name} -- {result.reason}")
    elif result.accepted:
        typer.echo(f"{name}: dream written -- 最近 updated ({len(result.recent or [])} items)")
    else:
        typer.echo(f"{name}: dream failed -- {result.reason}")


def report_cycle_result(name: str, state: CycleState, *, dry_run: bool) -> None:
    """Both halves, in the order they happened, through the two renderers
    `act` and `dream` already use.

    The dream line is printed only when the dream phase actually ran --
    `proceeded` is absent entirely for an offline round, a dead backend, and
    a dry run, and printing `SKIP <name> -- ` with an empty reason for those
    would make three quite different rounds read identically.
    """
    act_result = act_result_of(state)
    if act_result is not None:
        report_act_result(name, act_result, dry_run=dry_run)
    if "proceeded" in state:
        report_dream_result(name, dream_result_of(state))
