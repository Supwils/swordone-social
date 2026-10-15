"""The one error the bench raises to say "stop, with this exit code"."""

from __future__ import annotations

EXIT_USAGE = 64
EXIT_NO_SUCH_ACCOUNT = 66
EXIT_NO_ACTION = 75


class BenchStop(Exception):  # noqa: N818 -- a control-flow signal, not a failure type
    """A run that cannot go on. `code` is the process exit code the CLI
    returns (the same 64 / 66 / 75 the rest of `swil-agent` uses -- see
    `cli/app.py`); `message` is the one line it prints to stderr.

    The codes are restated here rather than imported from `cli/app.py` so
    this package never imports the CLI layer above it."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
