"""The `Runner` seam and its production `SubprocessRunner`."""

from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel

from swil_agent.llm.errors import BackendBinaryMissingError

logger = logging.getLogger("swil_agent.llm.base")

DEFAULT_TIMEOUT = 300.0


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
    ) -> RunResult: ...


class SubprocessRunner:
    """The real `Runner`.

    `env` entries with an empty string value are treated as "strip this key
    from the merged environment" rather than "set it to empty". Python's
    subprocess `env=` has no way to express `unset FOO` the way a POSIX shell
    does — a backend that needs to guarantee a var is absent (see
    `DeepSeekCLIBackend`, which must not let an inherited real Anthropic key
    leak into a DeepSeek-endpoint call) has no other lever to pull.
    """

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        return self.run_result(argv, stdin, env, timeout).stdout

    def run_result(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
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
            completed = subprocess.run(
                argv,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=merged,
                check=False,
            )
        except subprocess.TimeoutExpired:
            # Was a silent `return ""` -- indistinguishable downstream from a
            # backend that answered instantly with nothing. One is a wedged
            # host, the other a broken install, and both surfaced to the
            # operator as the same `outcome=backend_unavailable`.
            logger.warning("WARN %s timed out after %.0fs", argv[0], timeout)
            return RunResult(stdout="", returncode=None, timed_out=True)
        except FileNotFoundError as exc:
            # `subprocess.run` raises `FileNotFoundError` when argv[0] itself
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
        if completed.returncode != 0:
            # The CLI writes WHY it failed to stderr -- "Credit balance too
            # low", "not logged in", a rate-limit notice, a model the
            # installed version does not know. Returning only stdout threw
            # all of that away and left `BackendUnavailableError(... produced
            # no output)` as the operator's whole artefact, which is exactly
            # the "no response from codex" incident class the FileNotFoundError
            # branch above already names. Logged, not raised: the empty return
            # is the existing contract and callers are built on it.
            detail = " ".join((completed.stderr or "").split())[:300]
            logger.warning(
                "WARN %s exited %d%s",
                argv[0],
                completed.returncode,
                f": {detail}" if detail else "",
            )
        return RunResult(stdout=completed.stdout, returncode=completed.returncode)
