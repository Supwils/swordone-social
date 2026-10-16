"""The operator commands: `version`, `doctor`, `register`, `measure-status`.

The probes and the aggregation they print live below the CLI, in
`swil_agent/doctor.py` and `swil_agent/analysis/measure_status.py`, and are
called as attributes of those modules -- the CLI's second seam home (S3
§12.13), so a test replaces one probe there and the command picks it up.
"""

from __future__ import annotations

import shutil
from datetime import UTC
from typing import Annotated

import typer

from swil_agent import __version__
from swil_agent import doctor as doctor_checks
from swil_agent.analysis import measure_status as runtime_status
from swil_agent.api.client import ApiError
from swil_agent.cli import compose
from swil_agent.cli.app import EXIT_NO_ACTION, EXIT_NO_SUCH_ACCOUNT, EXIT_OK
from swil_agent.cli.errors import ERA_START_REMEDY
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.persona.format import PersonaFormatError
from swil_agent.policy import PRODUCTION_HOST, is_production_url
from swil_agent.register import RegisterError, register_account


def version() -> None:
    """Print the installed `swil-agent` package version."""
    typer.echo(f"swil-agent {__version__}")


def doctor(
    smoke: Annotated[
        bool,
        typer.Option("--smoke", help="Send one tiny prompt through each roster backend:model."),
    ] = False,
) -> None:
    """Print operator readiness: URL, production-host warning, PATH, embedder,
    lock dir, heartbeat launchctl (spec §11). Exit 0 ready, 75 not.

    Documents SWIL_REQUIRE_NON_PROD; does not enforce it. Missing launchctl
    is not a failure.
    """
    settings = compose.load_settings()
    ready = True

    url = settings.swil_url
    typer.echo(f"SWIL_URL: {url or '(empty)'}")
    if not url.strip():
        typer.echo("  FAIL: SWIL_URL is empty")
        ready = False
    elif is_production_url(url):
        typer.echo(f"  WARN: host is production ({PRODUCTION_HOST})")
        typer.echo(
            "  SWIL_REQUIRE_NON_PROD=1 refuses cycle/act against this host "
            "unless --i-mean-production"
        )
    else:
        typer.echo("  ok (not production)")

    if settings.era_start is None:
        typer.echo("ERA_START: FAIL (unset)")
        typer.echo(f"  {ERA_START_REMEDY}")
        ready = False
    else:
        start = settings.era_start
        start = start.replace(tzinfo=UTC) if start.tzinfo is None else start
        typer.echo(f"ERA_START: {start.isoformat()}")
        if start > compose.now(UTC):
            typer.echo("  WARN: ERA_START is in the future -- every era read is empty until then")

    for binary in doctor_checks.doctor_binaries(settings.agent_root):
        if doctor_checks.on_path(binary):
            found = shutil.which(binary) or binary
            typer.echo(f"{binary}: {found}")
            if binary == "grok":
                audited, audit_msg = doctor_checks.grok_audit(doctor_checks.grok_version())
                typer.echo(f"  grok version: {'ok' if audited else 'FAIL'} {audit_msg}")
                if not audited:
                    ready = False
        else:
            typer.echo(f"{binary}: not on PATH")
            ready = False

    try:
        health = compose.embedder_for(settings).health()
        typer.echo(f"embedder: ok {health}")
    except EmbedderUnavailable as exc:
        typer.echo(f"embedder: FAIL ({exc})")
        ready = False

    if url.strip():
        since_ok, since_msg = doctor_checks.since_probe(settings)
        typer.echo(f"since probe: {'ok' if since_ok else 'FAIL'} ({since_msg})")
        if not since_ok:
            ready = False

    writable, lock_msg = doctor_checks.lock_dir_writable(settings.agent_root)
    typer.echo(f"lock dir: {lock_msg}")
    if not writable:
        ready = False

    if smoke and not doctor_checks.smoke_arms(
        settings, backend_for=compose.backend_for, emit=typer.echo
    ):
        ready = False

    typer.echo(f"{doctor_checks.HEARTBEAT_LABEL}: {doctor_checks.heartbeat_launchctl_status()}")

    if ready:
        typer.echo("doctor: ready")
        raise typer.Exit(EXIT_OK)
    typer.echo("doctor: not ready")
    raise typer.Exit(EXIT_NO_ACTION)


def register(
    username: Annotated[str, typer.Argument(help="Account directory under agents/.")],
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print each request; send none.")
    ] = False,
    adopt: Annotated[
        bool,
        typer.Option(
            "--adopt", help="Continue on a user that already exists without a local api_key.txt."
        ),
    ] = False,
) -> None:
    """Register an Era 3 account: user, API key, profile, backend, anchor snapshot.

    Safe to re-run once the key file exists. An existing user without one is
    refused unless `--adopt`.
    """
    settings = compose.load_settings()
    try:
        register_account(
            settings,
            compose.persona_source_for(settings),
            username,
            embedder=None if dry_run else compose.embedder_for(settings),
            dry_run=dry_run,
            adopt=adopt,
            emit=typer.echo,
        )
    except FileNotFoundError as exc:
        typer.echo(f"register: {exc}")
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except (PersonaFormatError, RegisterError, ApiError) as exc:
        typer.echo(f"register: FAIL {exc}")
        raise typer.Exit(EXIT_NO_ACTION) from exc


def measure_status(
    since: str | None = typer.Option(
        None,
        "--since",
        help="YYYY-MM-DD. Default: the ERA_START date, else 2026-07-25 (design date).",
    ),
) -> None:
    """Print rounds / missing samples / post vectors missing from GET
    /agents/runtime plus the local roster (spec §11). Exit 0, or 75 on API
    fail. "post vectors missing" prints only when the server reports it."""
    settings = compose.load_settings()
    try:
        since_date = runtime_status.parse_iso_date(
            since or runtime_status.measure_since_default(settings)
        )
    except ValueError as exc:
        typer.echo(f"measure-status: {exc}", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    try:
        payload = runtime_status.fetch_runtime_health(
            settings, since=since_date, today=compose.today()
        )
    except Exception as exc:
        typer.echo(f"measure-status: API fail ({exc})", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    totals = runtime_status.runtime_totals(payload, since=since_date)
    range_ = payload.get("range", "?")
    accounts = payload.get("accountsRun", 0)
    roster = doctor_checks.roster_count(settings.agent_root)
    typer.echo(f"measure-status since={since_date.isoformat()} range={range_}")
    typer.echo(f"  rounds: {totals.rounds}")
    typer.echo(f"  missing samples: {totals.missing_samples}")
    if totals.missing_post_vectors is not None:
        typer.echo(f"  post vectors missing: {totals.missing_post_vectors}")
    typer.echo(f"  landed actions: {totals.landed}")
    typer.echo(f"  accounts run: {accounts}")
    typer.echo(f"  roster: {roster}")
    raise typer.Exit(EXIT_OK)
