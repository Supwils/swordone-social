"""Behavioural coverage for the model-neutral ruler (`llm/neutral.py`).

`distill_neutral` is the function this task is named after and the one
carrying the experiment's core invariant — nothing was exercising it before
this file existed. `test_architecture.py` proves the *isolation* (it cannot
import a concrete backend); this file proves the *behaviour* (it builds the
right argv, never accepts an env override, and fails/collapses like every
other backend).
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import pytest

from swil_agent.llm.base import BackendUnavailableError, CompletionRequest, SubprocessRunner
from swil_agent.llm.neutral import distill_neutral


class FakeRunner:
    """Records argv/stdin/env and returns a scripted stdout."""

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.calls: list[dict[str, object]] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append({"argv": argv, "stdin": stdin, "env": env, "timeout": timeout})
        return self.output


def test_distill_neutral_pins_the_given_model_and_puts_prompt_on_stdin() -> None:
    runner = FakeRunner("distilled")
    out = distill_neutral(CompletionRequest(system="SYS", user="USR"), runner, "haiku")
    assert out == "distilled"
    call = runner.calls[0]
    argv = call["argv"]
    assert isinstance(argv, list)
    assert argv[:2] == ["claude", "-p"]
    # The ruler must not be able to touch what it measures. Adjacent-pair
    # assertion, not membership: `--tools` with a non-empty neighbour still
    # contains the flag and still re-enables the tool set. See
    # `test_backends.py`'s sandbox block for the incident.
    assert argv[argv.index("--tools") : argv.index("--tools") + 2] == ["--tools", ""]
    assert "--model" in argv
    assert argv[argv.index("--model") + 1] == "haiku"
    assert "--system-prompt" in argv and "SYS" in argv
    assert call["stdin"] == "USR"


def test_distill_neutral_clears_the_anthropic_redirect_env_vars() -> None:
    """The core invariant: nothing in the ambient environment may redirect
    the ruler at another endpoint. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
    and `ANTHROPIC_MODEL` are exactly the three keys `DeepSeekCLIBackend` sets
    for its own subprocess — if a DeepSeek-backed account's drift were ever
    measured through a DeepSeek call, its numbers would not be comparable to
    a Claude-backed account's.

    Asserting `env is None` (the previous version of this test) named the
    invariant but pinned exactly the value that PERMITTED the leak:
    `SubprocessRunner.run` builds `merged = dict(os.environ)` when given
    `env=None`, so `env=None` means "inherit everything from the parent
    process", not "isolated". The empty-string values below are the
    "delete this key" sentinel `SubprocessRunner` implements — this test
    asserts distill_neutral actually sends that sentinel for all three keys,
    not merely that it sends *some* env dict."""
    runner = FakeRunner("distilled")
    distill_neutral(CompletionRequest(system="S", user="U"), runner, "haiku")
    env = runner.calls[0]["env"]
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_BASE_URL") == ""
    assert env.get("ANTHROPIC_AUTH_TOKEN") == ""
    assert env.get("ANTHROPIC_MODEL") == ""


def test_distill_neutral_real_subprocess_does_not_leak_a_parent_anthropic_base_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end proof against a REAL `SubprocessRunner` and a real child
    process, not a mock — the same pattern `test_backends.py` uses to prove
    `SubprocessRunner`'s env-merge semantics rather than just the sentinel
    being passed. A fake `claude` executable placed first on PATH stands in
    for the real CLI, so this needs no network access and no real Anthropic
    credential; it reports whether `ANTHROPIC_BASE_URL` reached it.

    `ANTHROPIC_BASE_URL` is set here to exactly the value
    `DeepSeekCLIBackend` sets for its own subprocess — the real leak this
    round of work closes: a parent process (or a developer's shell) that has
    this exported must not have it reach the neutral ruler's child process."""
    fake_claude = tmp_path / "claude"
    fake_claude.write_text(
        "#!/bin/sh\n"
        'if [ -n "$ANTHROPIC_BASE_URL" ]; then printf CLAUDE_SAW_BASE_URL; '
        "else printf CLAUDE_SAW_NOTHING; fi\n",
        encoding="utf-8",
    )
    fake_claude.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic")

    out = distill_neutral(CompletionRequest(system="S", user="U"), SubprocessRunner(), "haiku")

    assert out == "CLAUDE_SAW_NOTHING"


def test_distill_neutral_raises_on_empty_output() -> None:
    runner = FakeRunner("")
    with pytest.raises(BackendUnavailableError):
        distill_neutral(CompletionRequest(system="S", user="U"), runner, "haiku")


def test_distill_neutral_collapses_doubled_output() -> None:
    body = "x" * 40
    runner = FakeRunner(body + body)
    out = distill_neutral(CompletionRequest(system="S", user="U"), runner, "haiku")
    assert out == body


def test_a_failing_child_puts_its_stderr_and_exit_code_in_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A CLI that exits non-zero writes the reason to STDERR, and `run`
    returned only stdout -- so "Credit balance too low", "not logged in" and
    a rate-limit notice all arrived as `BackendUnavailableError(... produced
    no output)`. That is the "no response from codex" incident class this
    module's own `FileNotFoundError` comment says the project has already
    lost real time to; the reason was on the floor, not missing."""
    runner = SubprocessRunner()

    with caplog.at_level(logging.WARNING):
        script = "import sys; sys.stderr.write('Credit balance too low'); sys.exit(1)"
        out = runner.run([sys.executable, "-c", script])

    assert out == ""
    assert "Credit balance too low" in caplog.text
    assert "1" in caplog.text


def test_a_timed_out_child_says_so_instead_of_looking_like_a_dead_llm(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 300s hang and an instantly-dead backend both returned `""`. One is a
    wedged host, the other a broken install; the operator saw the same
    `outcome=backend_unavailable` for both."""
    runner = SubprocessRunner()

    with caplog.at_level(logging.WARNING):
        out = runner.run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.2)

    assert out == ""
    assert "timed out" in caplog.text.lower()
