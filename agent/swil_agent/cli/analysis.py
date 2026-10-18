"""The analysis / QA commands: `behavior-snapshot`, `backfill-post-vectors`,
`population-metric`, `intervention`, `summary`, `observe`.

Thin wrappers over `swil_agent/analysis/`: each resolves its collaborators
through `compose`, runs one measurement or one write, and prints one line
per account. The exit-code rules are in the section comment below.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import typer

from swil_agent import doctor as doctor_checks
from swil_agent.analysis import observe as observe_module
from swil_agent.analysis.backfill_post_vectors import run_backfill_post_vectors
from swil_agent.analysis.behavior_snapshot import run_behavior_snapshot
from swil_agent.analysis.intervention import (
    DatingBasis,
    InterventionKind,
    build_intervention_event,
    run_intervention,
)
from swil_agent.analysis.population_metric import (
    ACCOUNTS_DIR,
    API_KEY_FILENAME,
    find_account_with_api_key,
)
from swil_agent.analysis.population_metric import run_population_metric as run_metric
from swil_agent.analysis.summary import local_today, run_summary
from swil_agent.cli import compose
from swil_agent.cli.app import EXIT_NO_ACTION, EXIT_NO_SUCH_ACCOUNT, EXIT_OK, EXIT_USAGE
from swil_agent.cli.errors import (
    AccountSetupError,
    enforce_era_gate,
    load_persona_or_raise_setup_error,
    skip_for_exception,
)
from swil_agent.cli.logs import ACT_LOG_FILENAME, attach_round_log
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.persona.format import card_text

# ── analysis / QA commands ───────────────────────────────────────────────
#
# The three SAMPLERS -- `behavior-snapshot`, `population-metric`, `summary`
# -- are OBSERVABILITY, never the main flow, and their exit codes say so:
# `0` whenever the command ran, whatever it found, and a measurement
# outage -- no api_key, no parseable rule, a dead embedder, an unreachable
# platform -- is never a
# round failure. `75` is reserved for the SETUP failures that mean nothing
# was measured at all, and `66` for an account that does not exist.
#
# `intervention` lives in this section and does NOT follow that
# rule, deliberately. It is a WRITE that nothing retries and nothing else
# notices, so it exits 75 on a server rejection rather than 0. Do not
# "correct" it to match its neighbours: the swallowed 400 is the exact
# six-week defect this command was written to end.
#
# `behavior-snapshot` and `population-metric` are ALSO wired into `cycle`
# (`graph/nodes_tail.py`); these commands exist for re-sampling one account by
# hand without spending a round on it, and for anyone driving the act phase
# with `swil-agent act`, which does not
# sample.


def behavior_snapshot(
    name: str,
    limit: int | None = typer.Option(
        None, "--limit", help="Recent posts to embed (default: BEHAVIOR_POST_LIMIT)."
    ),
) -> None:
    """Sample one account's behaviour snapshot.

    Embeds the account's recent posts as ONE document and ships the vector;
    the server computes persona fidelity = cosine(personality, behavior).
    This is the *revealed self* half of `/lab`'s fidelity pair -- `dream`'s
    own snapshot supplies the *stated self*, and neither is derivable from
    the other.

    **The embedder daemon is NOT started for this**: only `cycle` brackets
    the embedder guard. A daemon that is down means this fails open with a
    WARN and exits 0. Start it yourself (`agent/scripts/embedder/start.sh`)
    if you want the sample to land.

    Exits 0 on every outcome: no
    api_key, no recent posts, a dead embedder, a server rejection.
    """
    settings = compose.load_settings()
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

    try:
        result = run_behavior_snapshot(
            compose.resources_for(persona, settings),
            directory=persona.directory,
            username=persona.username,
            embedder=compose.embedder_for(settings),
            captured_at=compose.now(UTC),
            limit=limit if limit is not None else settings.behavior_post_limit,
        )
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if result.ok:
        fidelity = "n/a" if result.fidelity is None else result.fidelity
        typer.echo(
            f"behavior-snapshot {name} -- ok id={result.snapshot_id} "
            f"fidelity={fidelity} posts={result.post_count}"
        )
    else:
        typer.echo(f"behavior-snapshot {name} -- skipped ({result.reason})")
    raise typer.Exit(EXIT_OK)


def _backfill_accounts(
    settings: Settings,
    targets: list[str],
    era_start: datetime,
    *,
    embedder: EmbedderClient | None,
) -> bool:
    """`backfill-post-vectors`' per-account loop, one line per account. True
    when every account was listed and every post filed. `embedder` is `None`
    only on a dry run."""
    dry_run = embedder is None
    persona_source = compose.persona_source_for(settings)
    clean = True
    for name in targets:
        try:
            persona = load_persona_or_raise_setup_error(persona_source, name)
            resources = compose.resources_for_key(persona.directory, settings)
        except Exception as exc:
            typer.echo(f"backfill-post-vectors {name} -- skipped ({exc})")
            clean = False
            continue
        result = run_backfill_post_vectors(
            resources,
            username=persona.username,
            card=card_text(persona.card),
            embedder=embedder,
            era_start=era_start,
            dry_run=dry_run,
        )
        if result.reason is not None:
            typer.echo(f"backfill-post-vectors {name} -- skipped ({result.reason})")
        elif dry_run:
            typer.echo(f"backfill-post-vectors {name} -- dry-run posts={result.posts}")
        else:
            typer.echo(
                f"backfill-post-vectors {name} -- posts={result.posts} "
                f"filed={result.filed} failed={result.failed} echoes={result.skipped}"
            )
        clean = clean and result.ok
    return clean


def backfill_post_vectors(
    names: Annotated[
        list[str] | None,
        typer.Argument(help="Accounts to backfill (default: every roster account)."),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="List and count era posts; embed and file nothing.")
    ] = False,
) -> None:
    """File post vectors for each account's own posts since ERA_START (S2 §4).

    For posts that landed without one: `[card, *texts]` is embedded in
    batches and each post is filed with `roundId: null` and `maxSim: null`.
    The ingest is idempotent, so a re-run is safe. Needs ERA_START (exit 75),
    each account's `api_key.txt`, and the embedder: a real run brackets the
    embedder guard like `cycle` and exits 75 with a remedy if /health still
    fails; a dry run embeds nothing and starts nothing.

    Exit 0 when every account was listed and every post filed; 75 when any
    account was skipped or any post was not filed; 66 for an unknown name,
    checked before anything is read.
    """
    settings = compose.load_settings()
    enforce_era_gate(settings)
    era_start = settings.era_start
    assert era_start is not None  # narrowed by `enforce_era_gate`
    targets = names or doctor_checks.roster_names(settings.agent_root)
    unknown = [name for name in targets if not _account_directory_exists(settings.agent_root, name)]
    if unknown:
        typer.echo(f"no such account: {', '.join(unknown)}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT)

    if dry_run:
        clean = _backfill_accounts(settings, targets, era_start, embedder=None)
        raise typer.Exit(EXIT_OK if clean else EXIT_NO_ACTION)

    # Bracketed like `cycle`: the guard starts the daemon if nothing else
    # holds it. `up()` cannot fail loudly, so the health check is what turns a
    # dead daemon into one remedy line instead of every post counted failed.
    guard = compose.guard_for(settings)
    try:
        guard.up()
        embedder = compose.embedder_for(settings)
        try:
            embedder.health()
        except EmbedderUnavailable as exc:
            typer.echo(
                f"backfill-post-vectors: embedder unreachable at {settings.embedder_url} "
                f"({exc}) -- start it with `bash agent/scripts/embedder/start.sh`",
                err=True,
            )
            raise typer.Exit(EXIT_NO_ACTION) from exc
        clean = _backfill_accounts(settings, targets, era_start, embedder=embedder)
    finally:
        guard.down()
    raise typer.Exit(EXIT_OK if clean else EXIT_NO_ACTION)


def population_metric(
    name: str | None = typer.Argument(
        None, help="Account whose api_key.txt authorises the call. Any keyed account works."
    ),
) -> None:
    """Trigger one population-cohesion sample.

    Triggers ONE population-cohesion sample. The route
    (`POST /agents/population-metric`) is global and the server does the
    maths; this only triggers and timestamps it -- which is why `name` picks
    a CREDENTIAL rather than a subject, and why omitting it is normal: the
    first keyed account under `agents/` (sorted) is used.

    Exit codes:

      * `66` -- a NAME was given and no such account directory exists.
      * `75` -- an account exists but has no usable `api_key.txt`, no keyed
        account exists at all, or the server rejected the call. Nothing was
        measured, which is what 75 means everywhere else in this CLI.

    Those two have different fixes: one is a typo, the other is a missing key.

    `n < 2` is a SUCCESS. The server declines to historise a degenerate
    sample but still answers with a `capturedAt`, so a first run against a
    fresh database is not a failure.
    """
    settings = compose.load_settings()
    try:
        directory = _population_metric_account(settings, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        skip_for_exception(name or "(any keyed account)", exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    label = directory.name
    try:
        result = run_metric(compose.resources_for_key(directory, settings))
    except Exception as exc:
        skip_for_exception(label, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if not result.ok:
        typer.echo(f"population-metric -- server rejected ({result.reason})", err=True)
        raise typer.Exit(EXIT_NO_ACTION)
    typer.echo(
        f"population-metric -- ok personaCohesion={result.persona_cohesion} "
        f"behaviorCohesion={result.behavior_cohesion} n={result.n} at={result.captured_at}"
    )
    raise typer.Exit(EXIT_OK)


def _population_metric_account(settings: Settings, name: str | None) -> Path:
    """The account directory whose key authorises the metric call.

    `find_account_with_api_key` answers `None` for BOTH "no such account" and
    "that account has no key", because the script it ports cannot tell them
    apart. This CLI's `66` means exactly the first of those, so the account
    directory is probed separately when -- and only when -- a name was
    given.

    An EMPTY name is a name, not an absent one: bash's `$# -ge 1` makes
    `population-metric ""` look for `agents//api_key.txt` and find nothing,
    rather than falling through to the scan and authenticating as an
    arbitrary account. `find_account_with_api_key` reproduces that with
    `if name is not None`, and the same distinction is kept here.
    """
    found = find_account_with_api_key(settings.agent_root, name)
    if found is not None:
        return found
    if name is not None and not _account_directory_exists(settings.agent_root, name):
        raise FileNotFoundError(name)
    who = f"{name!r}" if name is not None else "any account"
    raise AccountSetupError(
        f"no usable {API_KEY_FILENAME} for {who} under {settings.agent_root} -- "
        "any lab account's key authorises this global route, so create one with "
        "`uv run --project agent swil-agent register <name>`"
    )


def _account_directory_exists(agent_root: Path, name: str) -> bool:
    """Is there an `agents/<name>` directory at all?

    `bool(name)` first, and it is load-bearing rather than defensive:
    `Path("agents") / ""` is `Path("agents")`, which IS a directory, so an
    empty name would otherwise report the cohort directory itself as a real
    account and downgrade `population-metric ""` from "no such account" to
    "that account has no key". Caught by
    `test_an_empty_name_is_a_name_not_an_absent_one`, which is the same empty
    -name case `find_account_with_api_key` already had to spell out.
    """
    return bool(name) and (agent_root / ACCOUNTS_DIR / name).is_dir()


# `Annotated` rather than this module's prevailing `x: T = typer.Option(...)`
# style, for the whole signature rather than only the two parameters that
# forced it. Ruff's B008 exempts a call default only when the parameter is
# annotated with a builtin immutable type, so `kind: InterventionKind =
# typer.Option(...)` is flagged where `at: str = typer.Option(...)` is not --
# and a signature that used one style for its enums and another for its
# strings would read as if the difference meant something.
def intervention(
    name: str,
    kind: Annotated[InterventionKind, typer.Option("--kind", help="What was done, by hand.")],
    at: Annotated[
        str,
        typer.Option(
            "--at", help="When it happened. ISO-8601; a bare local time is resolved as local."
        ),
    ],
    summary_text: Annotated[
        str,
        typer.Option(
            "--summary", help="One line, <=500 chars: what a reader of /lab needs to know."
        ),
    ],
    evidence: Annotated[
        str,
        typer.Option(
            "--evidence", help="Where the claim can be checked: archive header, commit, note."
        ),
    ],
    dated_from: Annotated[
        DatingBasis,
        typer.Option(
            "--dated-from", help="How --at was established. A commit date is an UPPER BOUND."
        ),
    ],
    reason: Annotated[
        str | None, typer.Option("--reason", help="Why, if it needs saying (<=300).")
    ] = None,
    window_start: Annotated[
        str | None,
        typer.Option(
            "--window-start",
            help="Earliest possible instant, when --at is only a bound. ISO-8601.",
        ),
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print the exact wire body and send nothing.")
    ] = False,
) -> None:
    """Record ONE human intervention as an `anomaly` lab event on `/lab`.

    A manual edit to an account's `personality.md` or `memory.md` bypasses
    every mechanism that would otherwise leave a trace -- the archive and
    the snapshot upload -- so the `/lab` series that covers it
    goes on looking normal while being wrong. This is how that stops being
    invisible.

    Optimised for "impossible to do wrong at 2am" rather than for keystrokes,
    and every one of the five required options is a failure that has already
    happened here:

      * `--at` has NO default. "Now" is almost never when an intervention
        happened, and a silent default would put the marker at the far end of
        the series from the stretch it annotates -- which is the same as not
        recording it.
      * `--dated-from` is required because a commit date and an archive
        header are not the same kind of fact. One is an upper bound on an
        edit that happened at some unknown earlier moment; the other is a
        second-accurate observation. Recorded separately so nobody later
        reads a bound as a measurement.
      * `--evidence` is required because an intervention record nobody can
        check against a header, a commit or a note is a rumour in the one
        series whose job is to make the data auditable.
      * `metrics` is assembled from these scalars and is never accepted as a
        mapping: a nested value 400s the whole event and both runtimes
        swallow it, which is exactly how that defect ran six weeks unnoticed.
      * The write is VERIFIED, not fire-and-forget. `Resources.lab_event`
        swallows every `ApiError`; this path uses `record_intervention`,
        which raises, so a 403 (wrong account's credential) or a 400
        (rejected body) exits 75 with the server's own message instead of
        printing a success line.

    No round log is attached, unlike every other command here: this is not a
    round, and `auto-run.log`'s line counts are read as act-round counts
    during straggler reconciliation. The durable record is the lab event.

    Exit codes: `66` no such account, `75` anything that stopped the record
    from landing (bad timestamp, over-length field, setup failure, server
    rejection), `0` recorded.
    """
    settings = compose.load_settings()
    persona_source = compose.persona_source_for(settings)
    try:
        persona = load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    try:
        occurred_at = _intervention_instant(at, "--at")
        window = (
            None if window_start is None else _intervention_instant(window_start, "--window-start")
        )
        if window is not None and window > occurred_at:
            raise ValueError("--window-start is after --at; the window would run backwards")
        event = build_intervention_event(
            kind=kind,
            occurred_at=occurred_at,
            summary=summary_text,
            evidence=evidence,
            dated_from=dated_from,
            reason=reason,
            window_start=window,
        )
    except ValueError as exc:
        typer.echo(f"intervention {name} -- refused: {exc}", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    # Echoed on BOTH paths, before the write. The single most likely 2am
    # mistake is a timestamp that parsed successfully into the wrong instant
    # (an offset assumed, a month and day transposed), and the only thing
    # that catches it is seeing the resolved value next to the account it is
    # about while there is still time to Ctrl-C.
    typer.echo(
        f"intervention {name} -- @{persona.username} {kind.value} "
        f"at {occurred_at.astimezone().isoformat()} "
        f"(wire {occurred_at.astimezone(UTC).isoformat()})"
    )
    if dry_run:
        typer.echo(f"intervention {name} -- dry run, nothing sent: {event.to_wire()}")
        raise typer.Exit(EXIT_OK)

    try:
        result = run_intervention(
            compose.resources_for(persona, settings), username=persona.username, event=event
        )
    except Exception as exc:
        skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    if not result.ok:
        typer.echo(f"intervention {name} -- server rejected ({result.reason})", err=True)
        raise typer.Exit(EXIT_NO_ACTION)
    typer.echo(f"intervention {name} -- recorded id={result.event_id}")
    raise typer.Exit(EXIT_OK)


def _intervention_instant(raw: str, flag: str) -> datetime:
    """Parse one operator-supplied timestamp, or raise `ValueError` naming
    the flag.

    A NAIVE value is resolved as LOCAL time, because that is what every
    source an operator copies from is written in: `memory.md`'s note lines are
    `date +%Y-%m-%d`, and `git log`'s default is the committer's local zone.
    Assuming UTC instead would shift every backfilled marker by the machine's
    offset -- seven hours here, small enough to still look plausible.

    A FUTURE instant is refused. There is no legitimate one, and the typo
    that produces it (a year or a month off) otherwise files a marker that
    sorts to the top of every timeline forever.
    """
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{flag}={raw!r} is not an ISO-8601 timestamp ({exc})") from exc
    resolved = parsed.astimezone() if parsed.tzinfo is None else parsed
    if resolved > compose.now(UTC):
        raise ValueError(f"{flag}={raw!r} resolves to a future instant ({resolved.isoformat()})")
    return resolved


def summary(
    date: str | None = typer.Argument(None, help="YYYY-MM-DD. Defaults to today, LOCAL time."),
) -> None:
    """The daily activity dashboard.

    LOCAL only -- it reads each account's `memory.md` and touches no API, so
    it needs no credentials, no server and no account to exist. There is
    therefore no `66` and no `75` here: an empty roster prints an empty
    table, which is the honest answer.

    The default date is LOCAL, not UTC, and printing uses `nl=False` because
    `run_summary`'s string already ends in a newline.
    """
    settings = compose.load_settings()
    typer.echo(
        run_summary(
            settings.agent_root,
            date=date if date is not None else local_today(compose.now()),
        ),
        nl=False,
    )
    raise typer.Exit(EXIT_OK)


_OBSERVE_EXIT = {"usage": EXIT_USAGE, "missing": EXIT_NO_SUCH_ACCOUNT, "setup": EXIT_NO_ACTION}


def observe(
    round_id: Annotated[str, typer.Argument(help="The round id, e.g. 20261017T062000Z-r.")],
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Print the note; write nothing.")
    ] = False,
) -> None:
    """Write the machine observer note for one round (lab v2 §5).

    GET the round's digest, ONE isolated claude-opus-5-5 completion (tool-less,
    like every model call), PUT the note with LAB_OBSERVER_TOKEN. Re-running
    replaces the note. Exit 0 written (or printed with --dry-run), 64 bad round
    id, 66 no such round, 75 token unset, server or model down (a non-zero exit
    or timeout publishes nothing), empty reply, digest over 128 KB, or the write
    refused. The success line names the target host. The round script runs it
    with `|| true`.
    """
    settings = compose.load_settings()
    try:
        backend = observe_module.observer_backend(compose.runner_for(settings), settings)
        result = observe_module.run_observe(
            settings,
            round_id,
            backend,
            dry_run=dry_run,
            transport=observe_module.http_transport(),
        )
    except observe_module.ObserveError as exc:
        typer.echo(f"observe: FAIL {exc}", err=True)
        raise typer.Exit(_OBSERVE_EXIT[exc.kind]) from exc
    except BackendBinaryMissingError as exc:
        typer.echo(f"observe: FAIL {exc}", err=True)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    if result.written:
        host = observe_module.target_host(settings.swil_url)
        typer.echo(f"observe: observed {result.round_id} → {host} (hash {result.digest_hash[:12]})")
    else:
        typer.echo(result.text)
    raise typer.Exit(EXIT_OK)
