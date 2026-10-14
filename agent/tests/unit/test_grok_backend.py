"""The grok.com CLI backend: `--tools ""` plus a throwaway cwd.

Unlike cursor-agent, `grok -p` actually has `--tools ""` (verified against
grok 1.0.5 on 2026-08-25). The constitution layer's guarantee can live in
the argv the same way it does for `claude -p`. These tests pin that argv,
and the flags that must never appear next to it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.llm.base import (
    BackendConfigurationError,
    BackendUnavailableError,
    CompletionRequest,
    GrokCLIBackend,
    build_backend,
)

REQ = CompletionRequest(system="SYS", user="USR", model="grok-4.6")


class CwdReadingRunner:
    """Captures `--cwd` at call time. The backend deletes the directory in
    a `finally`, so inspecting it afterwards would always see nothing."""

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.argvs: list[list[str]] = []
        self.cwds: list[Path] = []
        self.listings: list[list[str]] = []
        self.timeouts: list[float] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.argvs.append(list(argv))
        self.timeouts.append(timeout)
        cwd = Path(argv[argv.index("--cwd") + 1])
        self.cwds.append(cwd)
        self.listings.append(sorted(p.name for p in cwd.iterdir()))
        return self.output


def _arg_after(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


def test_tools_empty_is_on_the_argv() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    assert _arg_after(argv, "--tools") == ""


def test_permission_mode_is_plan() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    assert _arg_after(runner.argvs[0], "--permission-mode") == "plan"


def test_force_and_bypass_are_never_passed() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    for forbidden in (
        "--always-approve",
        "--yolo",
        "--force",
        "-f",
        "bypassPermissions",
        "acceptEdits",
        "dontAsk",
    ):
        assert forbidden not in argv, f"{forbidden} must never be passed"
    assert _arg_after(argv, "--permission-mode") != "auto"


def test_argv_shape() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    assert argv[0] == "grok"
    assert argv[1] == "-p"
    assert argv[2] == "USR"
    assert _arg_after(argv, "--output-format") == "plain"
    assert _arg_after(argv, "--max-turns") == "8"
    assert "--no-subagents" in argv
    assert "--no-plan" in argv
    assert "--disable-web-search" in argv
    assert _arg_after(argv, "-m") == "grok-4.6"
    assert _arg_after(argv, "--system-prompt-override") == "SYS"
    assert runner.timeouts[0] == 600.0


def test_missing_model_is_a_configuration_error() -> None:
    with pytest.raises(BackendConfigurationError, match="explicit model"):
        GrokCLIBackend(CwdReadingRunner()).complete(
            CompletionRequest(system="S", user="U", model=None)
        )


def test_empty_output_is_unavailable() -> None:
    with pytest.raises(BackendUnavailableError, match="grok produced no output"):
        GrokCLIBackend(CwdReadingRunner(output="")).complete(REQ)


def test_cwd_is_never_the_repository() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    workspace = runner.cwds[0]
    repo = Path(__file__).resolve().parents[3]
    assert repo not in workspace.parents
    assert workspace != repo


def test_cwd_is_empty_at_call_time() -> None:
    runner = CwdReadingRunner()
    GrokCLIBackend(runner).complete(REQ)
    assert runner.listings[0] == []


def test_cwd_is_rebuilt_for_every_call() -> None:
    runner = CwdReadingRunner()
    backend = GrokCLIBackend(runner)
    backend.complete(REQ)
    backend.complete(REQ)
    assert runner.cwds[0] != runner.cwds[1]


def test_build_backend_routes_grok() -> None:
    runner = CwdReadingRunner()
    backend = build_backend("grok", runner, Settings(swil_url="https://example.test"))
    assert isinstance(backend, GrokCLIBackend)
    backend.complete(REQ)
    assert runner.argvs[0][0] == "grok"
