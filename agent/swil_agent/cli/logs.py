"""The round logs: `agent/logs/auto-run.log` and `agent/logs/dream.log`.

Every `swil_agent` log record a round emits is mirrored into one of these
two files, in the Bash runtime's `[YYYY-MM-DD HH:MM:SS] <message>` format, so
straggler reconciliation and post-run QA can grep them. `act` and `dream`
attach one unfiltered file each; `cycle` attaches the pair, split per record
by `_DREAM_LOG_SOURCES`.

Routing is by LOGGER NAME, so a module that moves keeps the logger name it
had (S3 §12.16): the CLI's own records are `swil_agent.cli` wherever in the
`cli` package they are emitted, and its dream-phase channel stays
`swil_agent.cli.dream`.
"""

from __future__ import annotations

import logging
from typing import Final

from swil_agent.config import Settings

logger = logging.getLogger("swil_agent.cli")

_ROUND_LOG_FORMAT: Final = "[%(asctime)s] %(message)s"
_ROUND_LOG_DATE_FORMAT: Final = "%Y-%m-%d %H:%M:%S"
_round_log_handlers: list[logging.Handler] = []
_round_log_key: tuple[tuple[str, tuple[str, ...] | None], ...] = ()


ACT_LOG_FILENAME: Final = "auto-run.log"
DREAM_LOG_FILENAME: Final = "dream.log"

# Which loggers emit DREAM-phase records. Used ONLY by `cycle`, which is the
# one command that produces both phases in a single process and therefore
# needs the two files' contents decided per record rather than per command.
#
# `act` and `dream` still attach one unfiltered handler each -- a `dream`
# invocation emits only dream-phase records, an `act` invocation only
# act-phase ones, so filtering there would be machinery with no failure mode
# to prevent.
#
# Matching is by dotted-prefix. `swil_agent.graph.nodes` (the cycle's own
# logout record) is deliberately absent: it is the cycle's terminal line and
# belongs with the act log. `swil_agent.cli.dream` is the CLI's own dream-phase channel
# (`cli/compose.py`) -- the round-level embedder-down ERROR, which
# `swil-agent dream` already writes to `dream.log` and which must not change
# file just because the same probe ran inside a cycle.
# `swil_agent.analysis.*` is deliberately ABSENT, so the cycle-wired samplers
# land in `auto-run.log`: the behaviour snapshot embeds the posts this round's
# act phase produced, so it belongs with the act log.
_DREAM_LOG_SOURCES: Final[tuple[str, ...]] = (
    "swil_agent.dream",
    "swil_agent.embedder",
    "swil_agent.cli.dream",
)


class _PhaseFilter(logging.Filter):
    """Keep (or drop) records emitted by one phase's loggers.

    One class, two instances, one source list: `keep=True` for `dream.log`
    and `keep=False` for `auto-run.log`. Two independent lists would be two
    things to keep in sync, and a record matching neither would silently land
    in no file at all -- which reads exactly like a round that never ran.
    """

    def __init__(self, sources: tuple[str, ...], *, keep: bool) -> None:
        super().__init__()
        self._sources = sources
        self._keep = keep

    def filter(self, record: logging.LogRecord) -> bool:
        matched = any(
            record.name == source or record.name.startswith(f"{source}.")
            for source in self._sources
        )
        return matched is self._keep


def attach_round_log(settings: Settings, filename: str) -> logging.Handler | None:
    """Mirror every `swil_agent` log record into `agent/logs/<filename>`, in
    the act/dream log format.

    **The filename is PER COMMAND, and getting it wrong is silent.** Act
    records go to `auto-run.log` and dream records to `dream.log`
    (`ACT_LOG_FILENAME`/`DREAM_LOG_FILENAME`, passed explicitly rather than
    defaulted). Sending both to one file leaves the other empty: anyone
    grepping `dream.log` for a round's verdict finds nothing, and anyone
    counting act lines in `auto-run.log` counts dream lines too.

    Each line is `[YYYY-MM-DD HH:MM:SS] <message>`, echoed to stdout AND
    appended to the file under `agent/logs/`, with NO level name, so a
    straggler reconciliation or a post-run QA pass can grep for it. Without
    this a round leaves both files untouched, which reads exactly like a
    round that never ran.

    `basicConfig`'s stderr stream is untouched and keeps its
    `%(levelname)s %(message)s` shape. The one cosmetic difference from Bash
    is that its second copy goes to stdout, not stderr.

    Attached to the `swil_agent` logger, NOT the root: the root would also
    capture `httpx`'s own INFO-level "HTTP Request: ..." line for every API
    call, which `auto-run.log` has never contained.

    At most ONE round-log ATTACHMENT exists at a time (one handler for
    `act`/`dream`, two for `cycle`). Re-attaching the same one is a no-op (a
    `CliRunner`-driven test invokes the app many times in one process, and a
    second handler would double every line); attaching a DIFFERENT one --
    including the other command's -- closes and replaces the previous
    attachment rather than accumulating open files across a session.

    Returns the handler, or `None` if the file could not be opened -- a
    round must not die because a log file could not be opened.
    """
    handlers = _attach_round_logs(settings, ((filename, None),))
    return handlers[0] if handlers else None


def attach_cycle_logs(settings: Settings) -> list[logging.Handler]:
    """`cycle`'s TWO round logs, split by phase.

    A cycle acts AND dreams inside one process, so "which file does this line
    belong in" cannot be answered per command the way it is for `act` and
    `dream` -- it has to be answered per RECORD. `_DREAM_LOG_SOURCES` is that
    answer, and the two filters are complementary halves of one list so no
    record can fall through into neither file.

    The failure this prevents is silent in exactly the way ruling R20's was:
    a cycle that sent both phases to `auto-run.log` leaves `dream.log` empty,
    and every straggler-reconciliation grep for a dream verdict comes back
    with nothing while the act log's line counts are quietly inflated.
    """
    return _attach_round_logs(
        settings,
        (
            (ACT_LOG_FILENAME, None),
            (DREAM_LOG_FILENAME, _DREAM_LOG_SOURCES),
        ),
    )


def _attach_round_logs(
    settings: Settings, specs: tuple[tuple[str, tuple[str, ...] | None], ...]
) -> list[logging.Handler]:
    """Install exactly the round-log handlers `specs` describes, replacing
    whatever was installed before.

    Each spec is `(filename, dream_sources)`. `dream_sources=None` means "no
    filter, take every `swil_agent` record" -- what `act` and `dream` use.
    A non-`None` value installs the DREAM half of the split on that file and
    the ACT half (its complement) on every other file in the same
    attachment, which is how one list drives both filters.

    The key includes the resolved paths AND the source tuples, so switching
    between `act`'s single unfiltered `auto-run.log` and `cycle`'s filtered
    pair is detected as a different attachment even though both include a
    handler on the same path.
    """
    global _round_log_handlers, _round_log_key
    package_logger = logging.getLogger("swil_agent")
    key = tuple((str(settings.agent_root / "logs" / name), sources) for name, sources in specs)
    if key == _round_log_key:
        return _round_log_handlers

    for existing in _round_log_handlers:
        package_logger.removeHandler(existing)
        existing.close()
    _round_log_handlers = []
    _round_log_key = ()

    installed: list[logging.Handler] = []
    dream_sources = next((sources for _, sources in specs if sources is not None), None)
    for filename, sources in specs:
        path = settings.agent_root / "logs" / filename
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(path, mode="a", encoding="utf-8")
        except OSError as exc:
            logger.warning("could not open %s for the round log: %s", path, exc)
            continue
        handler.setFormatter(logging.Formatter(_ROUND_LOG_FORMAT, datefmt=_ROUND_LOG_DATE_FORMAT))
        # Level on the HANDLER, never on the logger: `skip_for_exception`
        # logs its traceback at DEBUG, and raising the LOGGER's level would
        # discard that record before any handler (including pytest's caplog)
        # saw it. Bash's `auto-run.log` has no debug tier, so the file takes
        # INFO and up.
        handler.setLevel(logging.INFO)
        if dream_sources is not None:
            handler.addFilter(_PhaseFilter(dream_sources, keep=sources is not None))
        package_logger.addHandler(handler)
        installed.append(handler)
    _round_log_handlers = installed
    # Only remember the attachment if EVERY file opened. A partial (or empty)
    # install must stay retryable, matching the previous single-handler
    # behaviour where a failed open left the module global at `None`.
    _round_log_key = key if len(installed) == len(specs) else ()
    return installed
