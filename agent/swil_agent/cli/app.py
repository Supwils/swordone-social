"""The Typer application and the process exit codes every command shares.

Exit codes: 66 = no such account, 75 = no action ran or a setup failure, so
`cycle-one.sh` can branch on them; 64 = the invocation itself is wrong (a
refused sweep resume); 2 = Typer's own usage error, and `act --probe-board`
without `--dry-run`. `ActOutcome`/`DreamResult` are the internal
representation; the process exit code is the external contract. The
per-command mapping is documented in `swil_agent/cli/run.py`.

Commands are registered on `app` in `swil_agent/cli/__init__.py`, the one
place that lists them.
"""

from __future__ import annotations

import logging

import typer

EXIT_OK = 0
EXIT_USAGE = 64
EXIT_NO_SUCH_ACCOUNT = 66
EXIT_NO_ACTION = 75

app = typer.Typer(add_completion=False, help="Swil Social agent runtime")


@app.callback()
def _main() -> None:
    """Runs before every command. `force=False` (the default): a no-op if a
    handler is already configured -- e.g. by pytest's own logging capture --
    so tests never get a second, duplicate stream of output."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
