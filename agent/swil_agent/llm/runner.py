"""The `Runner` seam and its production `SubprocessRunner`."""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel

from swil_agent.llm.errors import BackendBinaryMissingError

logger = logging.getLogger("swil_agent.llm.base")

DEFAULT_TIMEOUT = 300.0

# After a timeout the whole process group gets SIGTERM, then SIGKILL if it is
# still holding the pipes this long after. Short: the call has already failed.
KILL_GRACE_SECONDS = 2.0


class CompletionRequest(BaseModel):
    system: str
    user: str
    model: str | None = None


class Runner(Protocol):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        cwd: str | None = None,
    ) -> str: ...


@dataclass(frozen=True)
class RunResult:
    """One subprocess call with its exit status, for the one caller that
    must not trust stdout alone: the Persona Bench judge (S3 §12.19), whose
    score is the first integer of stdout -- and a CLI that exited non-zero
    may still print one ("5-hour limit reached, resets at 3pm").
    `returncode` is `None` when the call timed out."""

    stdout: str
    returncode: int | None
    timed_out: bool = False


class StatusRunner(Runner, Protocol):
    """A `Runner` that can also report the exit status (`run_result`).

    Opt-in: every round caller keeps `run` and its "stdout, WARN on
    failure" contract; only the bench asks for the status."""

    def run_result(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        cwd: str | None = None,
    ) -> RunResult: ...


class SubprocessRunner:
    """The real `Runner`.

    `env` entries with an empty string value are treated as "strip this key
    from the merged environment" rather than "set it to empty". Python's
    subprocess `env=` has no way to express `unset FOO` the way a POSIX shell
    does — a backend that needs to guarantee a var is absent (see
    `DeepSeekCLIBackend`, which must not let an inherited real Anthropic key
    leak into a DeepSeek-endpoint call) has no other lever to pull.

    `cwd` is the child's working directory (`None` inherits ours). Every
    persona-facing call passes a fresh empty directory from
    `llm.isolation.isolated_cwd`, never the repository.

    Every child starts in its own session (`start_new_session=True`), so a
    timeout can kill the whole process GROUP. `subprocess.run`'s timeout
    SIGKILLs only the direct child: a CLI that forked a helper (a node
    worker, an MCP server, a shell tool) left it running, still holding the
    stdout pipe -- so the "timed out" call kept blocking on the read, and the
    orphan kept running after the round moved on.
    """

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        cwd: str | None = None,
    ) -> str:
        return self.run_result(argv, stdin, env, timeout, cwd).stdout

    def run_result(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        cwd: str | None = None,
    ) -> RunResult:
        """`run` with the exit status kept. Same subprocess, same env
        handling, same WARN lines; `run` is exactly `run_result(...).stdout`.
        """
        merged = dict(os.environ)
        for key, value in (env or {}).items():
            if value:
                merged[key] = value
            else:
                merged.pop(key, None)
        try:
            # stdin is a pipe only when there is input to send; otherwise it
            # is inherited, exactly as `subprocess.run(input=None)` left it.
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE if stdin is not None else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=merged,
                cwd=cwd,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            if cwd is not None and exc.filename == cwd:
                raise  # a missing working directory is not a missing binary
            # `Popen` raises `FileNotFoundError` when argv[0] itself
            # is not on PATH. Left raw it escapes as the SAME exception type
            # "this account directory does not exist" uses, and the CLI's
            # `act` reported a missing `claude`/`codex` binary as exit 66,
            # "no such account" -- pointing whoever is debugging at the
            # roster instead of at PATH. This project has already lost real
            # time to "no response from codex" incidents (CLAUDE.md); an
            # exit code naming the wrong thing makes the next one worse.
            #
            # Re-raised as `BackendBinaryMissingError` -- see that class for
            # why it is NOT a `BackendUnavailableError`. Deliberately not
            # `return ""` either: an empty string is indistinguishable from a
            # dead LLM and would cost the same diagnosis.
            raise BackendBinaryMissingError(f"executable not found on PATH: {argv[0]!r}") from exc
        try:
            stdout, stderr = proc.communicate(input=stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            # Was a silent `return ""` -- indistinguishable downstream from a
            # backend that answered instantly with nothing. One is a wedged
            # host, the other a broken install, and both surfaced to the
            # operator as the same `outcome=backend_unavailable`.
            logger.warning("WARN %s timed out after %.0fs", argv[0], timeout)
            return RunResult(stdout="", returncode=None, timed_out=True)
        except BaseException:
            # KeyboardInterrupt, the CLI's SIGTERM -> SystemExit(143) (see
            # `cli/app.py`), anything raised mid-read: the child is in its own
            # session, so nothing else will ever signal it. Kill and reap the
            # group before the exception unwinds the caller's `finally`s
            # (the isolated cwd's rmtree among them).
            _kill_group(proc)
            raise
        if proc.returncode != 0:
            # The CLI writes WHY it failed to stderr -- "Credit balance too
            # low", "not logged in", a rate-limit notice, a model the
            # installed version does not know. Returning only stdout threw
            # all of that away and left `BackendUnavailableError(... produced
            # no output)` as the operator's whole artefact, which is exactly
            # the "no response from codex" incident class the FileNotFoundError
            # branch above already names. Logged, not raised: the empty return
            # is the existing contract and callers are built on it.
            detail = " ".join((stderr or "").split())[:300]
            logger.warning(
                "WARN %s exited %d%s",
                argv[0],
                proc.returncode,
                f": {detail}" if detail else "",
            )
        return RunResult(stdout=stdout, returncode=proc.returncode)


def _kill_group(proc: subprocess.Popen[str]) -> None:
    """SIGTERM the child's process group, SIGKILL it after
    `KILL_GRACE_SECONDS`, and reap the child.

    The group id is the child's pid (`start_new_session=True`), and the pid
    cannot have been reused: the child is not reaped until `communicate`
    returns here. `ProcessLookupError` means the group is already empty;
    macOS answers `PermissionError` instead when the only member left is
    the unreaped (zombie) leader. Neither leaves anything to signal."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, sig)
        try:
            proc.communicate(timeout=KILL_GRACE_SECONDS)
            return
        except subprocess.TimeoutExpired:
            continue
    # Something that left the group (its own `setsid`) still holds the pipes.
    # The child itself is dead; stop reading and reap it. That descendant is
    # out of reach here and keeps running -- say so.
    logger.warning(
        "WARN pid %d: a descendant outside its process group survived the kill "
        "and still holds its output pipes",
        proc.pid,
    )
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream is not None:
            with contextlib.suppress(OSError):
                stream.close()
    proc.wait()
