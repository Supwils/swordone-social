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
import signal
import threading
from types import FrameType

import typer

EXIT_OK = 0
EXIT_USAGE = 64
EXIT_NO_SUCH_ACCOUNT = 66
EXIT_NO_ACTION = 75
# 128 + SIGTERM, what a shell reports for a process the signal killed.
EXIT_SIGTERM = 143

# The act path's action budget when `--budget` is not given (`act`, `cycle`;
# `prompt-ab` samples under the same one).
DEFAULT_ACT_BUDGET = 5

app = typer.Typer(add_completion=False, help="Swil Social agent runtime")


def _exit_on_sigterm(signum: int, frame: FrameType | None) -> None:
    """One-shot: the FIRST TERM unwinds, every later one is ignored.

    The round TERMs the worker's whole group, and `uv run` forwards the TERM
    it received to this process as well -- so the worker sees two (measured).
    A second `SystemExit` raised while the first is unwinding aborts the
    `finally` it lands in: the CLI kill, the lease release, the temp-cwd
    removal. Ignoring further TERMs lets that cleanup finish; the round's
    KILL after its grace is still the backstop."""
    _ = signum, frame
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(EXIT_SIGTERM)


def install_sigterm_exit() -> None:
    """Turn SIGTERM into `SystemExit(143)` so it unwinds like an exception.

    Python's default SIGTERM action ends the process on the spot: no
    `finally`, no `except BaseException`. Since every LLM CLI runs in its own
    session (`SubprocessRunner`, `start_new_session=True`), the round's
    per-account `kill -TERM -<pgid>` reaches this process but NOT the CLI --
    which was then orphaned, still running, and the call's temp cwd
    (`llm.isolation.isolated_cwd`) was never removed. Raised as an exception,
    the TERM lands in `SubprocessRunner.run_result`'s `except BaseException`,
    which kills and reaps the CLI's group, and then every `finally` runs
    (temp dirs, leases). SIGINT keeps its default: it is already
    `KeyboardInterrupt`, which takes the same path.

    SIGKILL remains an uncatchable residual: a KILLed worker still orphans
    its CLI and leaves its temp dir behind. Only the main thread can set a
    signal handler, so this is a no-op anywhere else."""
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, _exit_on_sigterm)


@app.callback()
def _main() -> None:
    """Runs before every command. `force=False` (the default): a no-op if a
    handler is already configured -- e.g. by pytest's own logging capture --
    so tests never get a second, duplicate stream of output. Also installs
    the SIGTERM -> `SystemExit(143)` handler (`install_sigterm_exit`)."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    install_sigterm_exit()
