"""Persona-call isolation from the operator's configuration (2026-10-15),
and the runner's process-group timeout.

`--tools ""` (pinned in `test_backends.py`) closes the built-in tools. These
pin the other half: every persona-facing CLI call runs in a fresh empty temp
directory outside the repository, removed afterwards, with each CLI's flags
for ignoring user/project config. Measured from the repo root, a
`claude -p --tools ""` call carried 64 MCP tools (Gmail send, Blender
execute), ~66k tokens of hook context and both CLAUDE.md files.
"""

from __future__ import annotations

import importlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.llm import runner as runner_module
from swil_agent.llm.backends import build_backend
from swil_agent.llm.backends.codex import CodexCLIBackend
from swil_agent.llm.backends.cursor import CursorCLIBackend
from swil_agent.llm.backends.grok import (
    GROK_DISALLOWED_TOOLS,
    GROK_ISOLATION_ENV,
    GrokCLIBackend,
)
from swil_agent.llm.errors import BackendBinaryMissingError
from swil_agent.llm.isolation import PREFIX, isolated_cwd
from swil_agent.llm.runner import CompletionRequest, RunResult, SubprocessRunner
from tests.unit._runners import RecordingRunner, assert_isolated_cwd

_REQ = CompletionRequest(system="SYS", user="USR", model="claude-haiku-5-5")
_ISOLATION = [
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
]


def _settings() -> Settings:
    return Settings(swil_url="https://example.test")


class _CodexRunner(RecordingRunner):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        super().run(argv, stdin, env, timeout, cwd)
        Path(argv[argv.index("-o") + 1]).write_text("out", encoding="utf-8")
        return ""


# ── the helper ─────────────────────────────────────────────────────────────


def test_isolated_cwd_is_a_fresh_empty_dir_removed_afterwards() -> None:
    with isolated_cwd() as first, isolated_cwd() as second:
        assert first != second
        for path in (first, second):
            assert Path(path).name.startswith(PREFIX)
            assert list(Path(path).iterdir()) == []
        # Whatever a CLI leaves behind goes with the directory.
        (Path(first) / ".remember").mkdir()
        (Path(first) / ".remember" / "log").write_text("x", encoding="utf-8")
    assert not Path(first).exists()
    assert not Path(second).exists()


def test_isolated_cwd_is_removed_when_the_call_raises() -> None:
    with pytest.raises(RuntimeError), isolated_cwd() as path:
        raise RuntimeError("boom")
    assert not Path(path).exists()


# ── claude: the exact argv, per arm ────────────────────────────────────────


@pytest.mark.parametrize(
    ("model", "effort"),
    [("claude-haiku-5-5", "xhigh"), ("claude-opus-5-5", "high"), ("sonnet", "xhigh")],
)
def test_claude_persona_argv_is_tool_less_isolated_and_effort_pinned(
    model: str, effort: str
) -> None:
    """Flag order is part of the pin: `--tools ""` first, the four isolation
    flags, `--effort` (the value ~/.claude/settings.json used to supply),
    then the model and the prompt. The prompt bytes are unchanged."""
    runner = RecordingRunner("hello")
    out = build_backend("claude", runner, _settings()).complete(
        _REQ.model_copy(update={"model": model})
    )
    assert out == "hello"
    call = runner.calls[0]
    assert call.argv == [
        "claude",
        "-p",
        "--tools",
        "",
        *_ISOLATION,
        "--effort",
        effort,
        "--model",
        model,
        "--system-prompt",
        "SYS",
        "--output-format",
        "text",
    ]
    assert (call.stdin, call.env) == ("USR", None)
    assert_isolated_cwd(call)


def test_claude_without_a_model_still_pins_the_default_effort() -> None:
    runner = RecordingRunner("hello")
    build_backend("claude", runner, _settings()).complete(_REQ.model_copy(update={"model": None}))
    argv = runner.calls[0].argv
    assert "--model" not in argv
    assert argv[argv.index("--effort") + 1] == "xhigh"


def test_deepseek_is_isolated_and_keeps_its_env_effort() -> None:
    """`CLAUDE_CODE_EFFORT_LEVEL=medium` in its env is DeepSeek's effort pin,
    so it gets no `--effort` flag."""
    runner = RecordingRunner("hello")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="k").complete(
        _REQ.model_copy(update={"model": None})
    )
    call = runner.calls[0]
    assert call.argv == [
        "claude",
        "-p",
        "--tools",
        "",
        *_ISOLATION,
        "--model",
        "deepseek-v4-flash",
        "--system-prompt",
        "SYS",
        "--output-format",
        "text",
    ]
    assert call.env is not None and call.env["CLAUDE_CODE_EFFORT_LEVEL"] == "medium"
    assert_isolated_cwd(call)


# ── codex ──────────────────────────────────────────────────────────────────


def test_codex_argv_ignores_user_config_and_pins_the_arm_settings() -> None:
    runner = _CodexRunner()
    out = CodexCLIBackend(runner).complete(_REQ.model_copy(update={"model": "gpt-5.6-luna"}))
    assert out == "out"
    call = runner.calls[0]
    argv = call.argv
    out_path = argv[argv.index("-o") + 1]
    assert argv == [
        "codex",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        call.cwd,
        "-c",
        "model_reasoning_effort=high",
        "-c",
        "service_tier=priority",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "-c",
        "web_search=disabled",
        "-s",
        "read-only",
        "--color",
        "never",
        "-m",
        "gpt-5.6-luna",
        "-o",
        out_path,
        "System:\nSYS\n\n---\n\nUSR",
    ]
    assert_isolated_cwd(call)
    # The `-o` file is the CLI's, not the model's: it lives outside the
    # model's working root and is gone after the call too.
    assert not Path(out_path).is_relative_to(Path(str(call.cwd)))
    assert not Path(out_path).exists()


def test_codex_personality_and_mcp_are_never_pinned_back_in() -> None:
    runner = _CodexRunner()
    CodexCLIBackend(runner).complete(_REQ)
    joined = " ".join(runner.calls[0].argv)
    for dropped in ("personality", "mcp_servers", "notify", "--full-auto"):
        assert dropped not in joined


# ── cursor and grok: the process starts in the temp workspace too ─────────


def test_cursor_process_starts_in_its_temp_workspace() -> None:
    runner = RecordingRunner("ok")
    CursorCLIBackend(runner).complete(_REQ.model_copy(update={"model": "gemini-3.7-flash-high"}))
    call = runner.calls[0]
    assert call.cwd == call.argv[call.argv.index("--workspace") + 1]
    # The deny config is the only thing in it.
    assert_isolated_cwd(call, expected=(".cursor",))


def test_grok_is_isolated_by_env_denied_its_built_ins_and_starts_in_its_cwd() -> None:
    runner = RecordingRunner("ok")
    GrokCLIBackend(runner).complete(_REQ.model_copy(update={"model": "grok-4.6"}))
    call = runner.calls[0]
    argv = call.argv
    assert call.cwd == argv[argv.index("--cwd") + 1]
    assert_isolated_cwd(call)
    assert call.env == GROK_ISOLATION_ENV
    assert all(value in {"false", "0"} for value in GROK_ISOLATION_ENV.values())
    tools = argv.index("--tools")
    assert argv[tools : tools + 4] == [
        "--tools",
        "",
        "--disallowed-tools",
        ",".join(GROK_DISALLOWED_TOOLS),
    ]
    # Measured on grok 1.0.52: the read, shell and write built-ins, and the
    # MCP meta-tools that reach configured servers.
    for tool in ("run_terminal_command", "read_file", "write", "search_tool", "use_tool"):
        assert tool in GROK_DISALLOWED_TOOLS


# ── SubprocessRunner: cwd and the process-group timeout ────────────────────


def test_subprocess_runner_starts_the_child_in_cwd(tmp_path: Path) -> None:
    out = SubprocessRunner().run(
        [sys.executable, "-c", "import os; print(os.getcwd())"], cwd=str(tmp_path)
    )
    assert Path(out.strip()).resolve() == tmp_path.resolve()


def test_subprocess_runner_sends_stdin_and_starts_a_new_session() -> None:
    script = "import os, sys; print(sys.stdin.read(), os.getsid(0) == os.getpid())"
    out = SubprocessRunner().run([sys.executable, "-c", script], stdin="hi")
    assert out.split() == ["hi", "True"]


def test_a_missing_cwd_is_not_reported_as_a_missing_binary(tmp_path: Path) -> None:
    gone = tmp_path / "gone"
    with pytest.raises(FileNotFoundError) as caught:
        SubprocessRunner().run([sys.executable, "-c", "pass"], cwd=str(gone))
    assert not isinstance(caught.value, BackendBinaryMissingError)
    with pytest.raises(BackendBinaryMissingError):
        SubprocessRunner().run(["swil-no-such-binary-xyz"], cwd=str(tmp_path))


def _wait_gone(pid: int, within: float = 3.0) -> bool:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


# `sh`, not `python -c`: it starts in milliseconds, so the 0.3 s timeouts
# below never fire before the grandchild exists. Each script writes
# "<leader pid> <grandchild pid>" to $1, then waits.
_SPAWN = 'sleep 60 & echo "$$ $!" > "$1"; wait'
# `trap '' TERM` is inherited by the backgrounded `sleep`: only SIGKILL ends either.
_SPAWN_IGNORING_TERM = "trap '' TERM; " + _SPAWN
# A grandchild in its own session (perl's setsid), outside killpg's reach,
# still holding the stdout/stderr pipes.
_SPAWN_ESCAPED = 'perl -MPOSIX -e \'POSIX::setsid(); sleep 60\' & echo "$$ $!" > "$1"; wait'


def _argv(script: str, pid_file: Path) -> list[str]:
    return ["sh", "-c", script, "sh", str(pid_file)]


def _read_pids(pid_file: Path) -> tuple[int, int]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        parts = pid_file.read_text(encoding="utf-8").split() if pid_file.exists() else []
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
        time.sleep(0.02)
    raise AssertionError("the child never reported its pids")


def test_a_timeout_kills_the_whole_process_group_grandchild_included(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`subprocess.run`'s timeout SIGKILLed only the direct child; a CLI's
    helper process survived it and kept the stdout pipe open."""
    monkeypatch.setattr(runner_module, "KILL_GRACE_SECONDS", 0.5)
    pid_file = tmp_path / "pid"
    started = time.monotonic()
    result = SubprocessRunner().run_result(_argv(_SPAWN, pid_file), timeout=0.3)
    assert result == RunResult(stdout="", returncode=None, timed_out=True)
    assert time.monotonic() - started < 3
    leader, grandchild = _read_pids(pid_file)
    assert _wait_gone(leader)
    assert _wait_gone(grandchild), "the grandchild outlived the timeout"


def test_a_child_that_ignores_sigterm_is_sigkilled_after_the_grace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    grace = 0.3
    monkeypatch.setattr(runner_module, "KILL_GRACE_SECONDS", grace)
    pid_file = tmp_path / "pid"
    started = time.monotonic()
    result = SubprocessRunner().run_result(_argv(_SPAWN_IGNORING_TERM, pid_file), timeout=0.3)
    elapsed = time.monotonic() - started
    assert result.timed_out
    # TERM was ignored, so the group lived through the whole grace before KILL.
    assert elapsed >= 0.3 + grace
    leader, grandchild = _read_pids(pid_file)
    assert _wait_gone(leader), "the TERM-ignoring leader was never killed"
    assert _wait_gone(grandchild)


def test_a_grandchild_that_left_the_group_cannot_wedge_the_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A descendant in its own session is outside `killpg`'s reach and still
    holds the pipes; the runner stops reading instead of blocking on it, and
    says a descendant survived."""
    monkeypatch.setattr(runner_module, "KILL_GRACE_SECONDS", 0.3)
    pid_file = tmp_path / "pid"
    started = time.monotonic()
    with caplog.at_level("WARNING", logger="swil_agent.llm.base"):
        result = SubprocessRunner().run_result(_argv(_SPAWN_ESCAPED, pid_file), timeout=0.3)
    leader, escaped = _read_pids(pid_file)
    try:
        assert result.timed_out
        assert time.monotonic() - started < 3
        assert _wait_gone(leader)
        assert f"pid {leader}: a descendant outside its process group survived" in caplog.text
    finally:
        os.kill(escaped, signal.SIGKILL)


def test_any_exception_during_the_read_kills_and_reaps_the_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """KeyboardInterrupt (or the CLI's SIGTERM -> SystemExit) mid-call: the
    child is in its own session, so if the runner does not kill it nobody
    will. The exception still propagates."""
    monkeypatch.setattr(runner_module, "KILL_GRACE_SECONDS", 0.5)
    pid_file = tmp_path / "pid"
    real = subprocess.Popen.communicate
    calls = {"n": 0}

    def interrupted(self: subprocess.Popen[str], *args: object, **kwargs: object) -> object:
        calls["n"] += 1
        if calls["n"] == 1:
            _read_pids(pid_file)  # the group exists before the interrupt
            raise KeyboardInterrupt
        return real(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess.Popen, "communicate", interrupted)
    with pytest.raises(KeyboardInterrupt):
        SubprocessRunner().run_result(_argv(_SPAWN, pid_file), timeout=30)
    leader, grandchild = _read_pids(pid_file)
    assert _wait_gone(leader)
    assert _wait_gone(grandchild)


# ── the CLI turns SIGTERM into an unwinding exit ───────────────────────────


def test_the_cli_callback_installs_the_sigterm_handler() -> None:
    from typer.testing import CliRunner

    from swil_agent import cli

    app_module = importlib.import_module("swil_agent.cli.app")  # `cli.app` is the Typer

    assert CliRunner().invoke(cli.app, ["version"]).exit_code == 0
    handler = signal.getsignal(signal.SIGTERM)
    assert handler is app_module._exit_on_sigterm
    try:
        with pytest.raises(SystemExit) as caught:
            app_module._exit_on_sigterm(signal.SIGTERM, None)
        assert caught.value.code == 143
        # One-shot: a second TERM during the unwind is ignored.
        assert signal.getsignal(signal.SIGTERM) is signal.SIG_IGN
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)


def test_install_sigterm_exit_is_a_no_op_off_the_main_thread() -> None:
    import threading

    app_module = importlib.import_module("swil_agent.cli.app")  # `cli.app` is the Typer

    before = signal.getsignal(signal.SIGTERM)
    worker = threading.Thread(target=app_module.install_sigterm_exit)
    worker.start()
    worker.join()
    assert signal.getsignal(signal.SIGTERM) is before


_TERMINATED_WORKER = """
import sys
from pathlib import Path
from swil_agent.cli.app import install_sigterm_exit
from swil_agent.llm.isolation import isolated_cwd
from swil_agent.llm.runner import SubprocessRunner

install_sigterm_exit()
with isolated_cwd() as cwd:
    Path(sys.argv[2]).write_text(cwd)
    SubprocessRunner().run(["sh", "-c", sys.argv[3], "sh", sys.argv[1]], cwd=cwd, timeout=60)
"""


def test_a_sigtermed_worker_kills_its_cli_group_and_removes_the_temp_cwd(tmp_path: Path) -> None:
    """The round's per-account `kill -TERM -<pgid>` reaches the Python worker
    but not the CLI (its own session). The handler makes the TERM unwind:
    the runner kills the CLI's group, `isolated_cwd` removes its directory,
    and the worker exits 143."""
    pid_file, cwd_file = tmp_path / "pid", tmp_path / "cwd"
    worker = subprocess.Popen(
        [sys.executable, "-c", _TERMINATED_WORKER, str(pid_file), str(cwd_file), _SPAWN]
    )
    try:
        leader, grandchild = _read_pids(pid_file)
        worker.send_signal(signal.SIGTERM)
        assert worker.wait(timeout=10) == 143
    finally:
        if worker.poll() is None:
            worker.kill()
    assert _wait_gone(leader)
    assert _wait_gone(grandchild)
    assert not Path(cwd_file.read_text(encoding="utf-8")).exists()


def test_a_second_sigterm_during_the_unwind_does_not_abort_the_cleanup(tmp_path: Path) -> None:
    """The round's group TERM reaches the worker twice (`uv run` forwards its
    own copy). The CLI here ignores TERM, so the runner's cleanup spends its
    whole KILL grace with the worker mid-`finally` -- exactly when the second
    TERM lands. It must be ignored: the CLI group still dies, the temp cwd is
    still removed, and the exit is still 143."""
    pid_file, cwd_file = tmp_path / "pid", tmp_path / "cwd"
    worker = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _TERMINATED_WORKER,
            str(pid_file),
            str(cwd_file),
            _SPAWN_IGNORING_TERM,
        ]
    )
    try:
        leader, grandchild = _read_pids(pid_file)
        worker.send_signal(signal.SIGTERM)
        time.sleep(0.5)  # inside `_kill_group`'s 2 s grace
        worker.send_signal(signal.SIGTERM)
        assert worker.wait(timeout=10) == 143
    finally:
        if worker.poll() is None:
            worker.kill()
    assert _wait_gone(leader)
    assert _wait_gone(grandchild)
    assert not Path(cwd_file.read_text(encoding="utf-8")).exists()


def test_codex_with_no_output_file_is_unavailable_and_still_cleans_up() -> None:
    from swil_agent.llm.errors import BackendUnavailableError

    runner = RecordingRunner("progress noise only")
    with pytest.raises(BackendUnavailableError):
        CodexCLIBackend(runner).complete(_REQ)
    assert_isolated_cwd(runner.calls[0])
