import os
import sys
import threading
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.dream.round import dream_step
from swil_agent.llm.backends import build_backend
from swil_agent.llm.backends.claude import CLAUDE_ISOLATION_FLAGS
from swil_agent.llm.errors import BackendBinaryMissingError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest, SubprocessRunner
from tests.unit._runners import (
    FakeResources,
    RecordingRunner,
    RunnerCall,
    assert_isolated_cwd,
    make_persona,
)


def _settings() -> Settings:
    return Settings(swil_url="https://example.test")


def test_claude_puts_user_prompt_on_stdin() -> None:
    runner = RecordingRunner("hello")
    backend = build_backend("claude", runner, _settings())
    out = backend.complete(CompletionRequest(system="SYS", user="USR", model="haiku"))
    assert out == "hello"
    call = runner.calls[0]
    assert call.stdin == "USR"
    argv = call.argv
    assert isinstance(argv, list)
    assert argv[:2] == ["claude", "-p"]
    assert "--model" in argv and "haiku" in argv
    assert "--system-prompt" in argv and "SYS" in argv


def test_claude_omits_model_flag_when_model_is_none() -> None:
    runner = RecordingRunner("hello")
    build_backend("claude", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert "--model" not in argv


def test_codex_uses_exec_and_reads_an_output_file(tmp_path: Path) -> None:
    class CodexRunner(RecordingRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
            cwd: str | None = None,
        ) -> str:
            super().run(argv, stdin, env, timeout, cwd)
            out_index = argv.index("-o") + 1
            Path(argv[out_index]).write_text("codex said this", encoding="utf-8")
            return ""

    runner = CodexRunner()
    out = build_backend("codex", runner, _settings()).complete(
        CompletionRequest(system="SYS", user="USR", model=None)
    )
    assert out == "codex said this"
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[:2] == ["codex", "exec"]
    for flag in ("--ephemeral", "--skip-git-repo-check", "--color", "-o"):
        assert flag in argv
    prompt = argv[-1]
    assert prompt.startswith("System:\nSYS")
    assert prompt.endswith("USR")
    assert "-m" not in argv


def test_codex_passes_declared_model_as_dash_m() -> None:
    """Without this, a human on `codex:gpt-5.6-luna` would record Luna and
    actually run whatever the CLI default is."""

    class CodexRunner(RecordingRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
            cwd: str | None = None,
        ) -> str:
            super().run(argv, stdin, env, timeout, cwd)
            Path(argv[argv.index("-o") + 1]).write_text("luna", encoding="utf-8")
            return ""

    runner = CodexRunner()
    out = build_backend("codex", runner, _settings()).complete(
        CompletionRequest(system="SYS", user="USR", model="gpt-5.6-luna")
    )
    assert out == "luna"
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[argv.index("-m") + 1] == "gpt-5.6-luna"


def test_codex_concurrent_calls_never_collide_on_the_same_output_file() -> None:
    """Regression guard: concurrent image posts must not collide on one fixed
    filename, which would let one call's output silently clobber the other's.

    Genuinely concurrent (real OS threads, synchronized on a barrier so they
    enter `complete()` — and therefore `tempfile.NamedTemporaryFile` — at
    essentially the same instant), not five sequential calls: a sequential
    loop can never observe a collision even against the old buggy fixed-name
    template, so it would not have caught the original bug."""
    n = 8
    barrier = threading.Barrier(n)
    seen_paths: list[str] = []
    paths_lock = threading.Lock()

    class ConcurrentCodexRunner(RecordingRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
            cwd: str | None = None,
        ) -> str:
            out_path = argv[argv.index("-o") + 1]
            with paths_lock:
                seen_paths.append(out_path)
            Path(out_path).write_text(f"result-for-{out_path}", encoding="utf-8")
            return ""

    backend = build_backend("codex", ConcurrentCodexRunner(), _settings())
    results: list[str] = [""] * n
    errors: list[BaseException] = []

    def worker(i: int) -> None:
        barrier.wait()  # force all n threads into complete() at (near) the same instant
        try:
            results[i] = backend.complete(CompletionRequest(system="S", user="U", model=None))
        except Exception as exc:  # surfaced via `errors` below, never swallowed
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(seen_paths) == n
    assert len(seen_paths) == len(set(seen_paths)), "two concurrent codex calls collided on a path"
    assert len(results) == len(set(results)), "a call read back another call's output"


def test_deepseek_defaults_the_model_and_sets_env() -> None:
    """The deepseek key is injected directly here rather than read from
    `~/.claude/.deepseek-key`, so this test has no dependency on the machine
    it runs on — see `build_backend`'s `deepseek_api_key` parameter."""
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="test-deepseek-key").complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    call = runner.calls[0]
    argv = call.argv
    env = call.env
    assert isinstance(argv, list)
    assert isinstance(env, dict)
    assert "deepseek-v4-flash" in argv
    assert env.get("ANTHROPIC_BASE_URL") == "https://api.deepseek.com/anthropic"
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "test-deepseek-key"


def test_deepseek_strips_any_inherited_anthropic_api_key() -> None:
    """`ANTHROPIC_API_KEY` takes precedence over `ANTHROPIC_AUTH_TOKEN` in the
    claude CLI's own resolution (see `deepseek-env.sh`'s comment). If a
    developer's shell exports their real Anthropic key, it must not leak into
    a DeepSeek-endpoint call and silently authenticate with the wrong
    provider's credential."""
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="k").complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_API_KEY") == ""


def test_deepseek_reads_the_key_from_home_when_nothing_is_injected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Production default: no injected key ⇒ resolve `~/.claude/.deepseek-key`.
    Redirects HOME to an isolated tmp dir so this never touches the real
    machine's key file."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("  from-disk-key  \n", encoding="utf-8")

    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "from-disk-key"


def test_deepseek_raises_when_key_file_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings())


def test_deepseek_raises_when_key_file_on_disk_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Distinct from "file missing" (no `.deepseek-key` at all) and "injected
    empty" (caller explicitly passed `""`): here the file exists but contains
    only whitespace, which must still count as no usable key."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("   \n\t  \n", encoding="utf-8")
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings())


def test_deepseek_raises_when_injected_key_is_empty() -> None:
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings(), deepseek_api_key="")


def test_deepseek_key_strips_all_whitespace_not_just_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Matches `deepseek-env.sh`'s `tr -d '[:space:]'`, which removes
    whitespace anywhere in the file, not just leading/trailing. `.strip()`
    alone would leave an internal newline or space in the key untouched and
    silently hand the CLI a broken token."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("abc \n def\tghi\n", encoding="utf-8")
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "abcdefghi"


def test_empty_output_raises_backend_unavailable() -> None:
    backend = build_backend("claude", RecordingRunner(""), _settings())
    with pytest.raises(BackendUnavailableError):
        backend.complete(CompletionRequest(system="S", user="U", model=None))


def test_unknown_backend_name_falls_back_to_claude() -> None:
    """`build_backend` takes a resolved wire name -- an unknown spelling is
    refused upstream (loader, `resolve_backend_choice`) -- and its last branch
    is the claude path."""
    runner = RecordingRunner("ok")
    backend = build_backend("haiku", runner, _settings())
    backend.complete(CompletionRequest(system="S", user="U", model="haiku"))
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[0] == "claude"


def test_subprocess_runner_env_empty_string_deletes_inherited_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`DeepSeekCLIBackend._env()` relies on `SubprocessRunner` treating an
    empty-string env override as "delete this key from the child's
    environment", not "set it to empty" — the only lever Python's subprocess
    `env=` gives us to reproduce `deepseek-env.sh`'s `unset ANTHROPIC_API_KEY`.

    `RecordingRunner`-based tests (e.g. `test_deepseek_strips_any_inherited_...`)
    only prove the backend HANDS `SubprocessRunner` the `""` sentinel — they
    never exercise the merge itself. If `SubprocessRunner.run()` regressed to
    `merged[key] = value`, that other test would still pass while a real
    inherited `ANTHROPIC_API_KEY` silently hijacked every DeepSeek call. This
    test drives an actual child process to prove the merge, not just the
    sentinel being passed."""
    monkeypatch.setenv("SWIL_TEST_STRIP_ME", "leaked-real-key")
    runner = SubprocessRunner()
    out = runner.run(
        [
            sys.executable,
            "-c",
            "import os; print('PRESENT' if 'SWIL_TEST_STRIP_ME' in os.environ else 'ABSENT')",
        ],
        env={"SWIL_TEST_STRIP_ME": ""},
    )
    assert out.strip() == "ABSENT"
    # The parent test process's own environment must be untouched by the merge.
    assert os.environ["SWIL_TEST_STRIP_ME"] == "leaked-real-key"


def test_subprocess_runner_run_result_keeps_the_exit_status_and_run_does_not_change() -> None:
    """The opt-in status call the bench judge uses (S3 §12.19). `run` stays
    exactly `run_result(...).stdout`, so every round caller is unchanged."""
    from swil_agent.llm.runner import RunResult

    runner = SubprocessRunner()
    argv = [sys.executable, "-c", "import sys; print('resets at 3pm'); sys.exit(3)"]
    assert runner.run_result(argv) == RunResult(stdout="resets at 3pm\n", returncode=3)
    assert runner.run(argv) == "resets at 3pm\n"
    ok = [sys.executable, "-c", "print('fine')"]
    assert runner.run_result(ok) == RunResult(stdout="fine\n", returncode=0)


def test_subprocess_runner_run_result_reports_a_timeout() -> None:
    from swil_agent.llm.runner import RunResult

    slow = [sys.executable, "-c", "import time; time.sleep(5)"]
    result = SubprocessRunner().run_result(slow, timeout=0.2)
    assert result == RunResult(stdout="", returncode=None, timed_out=True)
    assert SubprocessRunner().run(slow, timeout=0.2) == ""


def test_subprocess_runner_env_normal_override_is_visible_to_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Companion to the deletion test above: a normal, non-empty override
    must still reach the child — proving the empty-string sentinel is a
    special case, not evidence that `env=` overrides are broken wholesale."""
    monkeypatch.delenv("SWIL_TEST_OVERRIDE_ME", raising=False)
    runner = SubprocessRunner()
    out = runner.run(
        [
            sys.executable,
            "-c",
            "import os; print(os.environ.get('SWIL_TEST_OVERRIDE_ME', 'MISSING'))",
        ],
        env={"SWIL_TEST_OVERRIDE_ME": "override-value"},
    )
    assert out.strip() == "override-value"
    assert "SWIL_TEST_OVERRIDE_ME" not in os.environ


# ── the exception hierarchy is load-bearing — read before "tidying" it ────


def test_backend_binary_missing_is_deliberately_not_a_subclass_of_backend_unavailable() -> None:
    """DO NOT "tidy" `BackendBinaryMissingError` into a subclass of
    `BackendUnavailableError`. This test exists solely to make that edit fail
    loudly, at the file it would be made in, with the reason attached.

    Both are `RuntimeError`s and they look like an obvious pair, which is why
    the flat hierarchy needs defending. Every "the LLM produced nothing" call
    site catches `BackendUnavailableError` and degrades quietly to `None`/`""`
    -- `act/planner.py`'s `plan_round`, `dream/round.py`'s `dream_step` --
    because that is what Bash does (`llm.sh`'s `_llm_raw`
    ends in `|| true`, so a dead model yields empty output, not an error).

    That degradation is correct for a model that answered with nothing and
    WRONG for a binary that is not installed. As a subclass,
    `BackendBinaryMissingError` would be swallowed by every one of those
    handlers: `swil-agent dream <name>` on a machine with no `codex` would
    report "LLM returned empty" and exit **0**, which is precisely the "a
    whole round silently drops every account on one backend" failure this
    project's history already records (CLAUDE.md: the missing
    `~/.claude/.deepseek-key`, and the "no response from codex" incidents).

    As a sibling it passes through all of them untouched and reaches
    `cli.py`'s `_backend_setup_guard`, the only layer that knows the account
    name and the remedy, which raises `AccountSetupError` and exits 75.
    """
    assert not issubclass(BackendBinaryMissingError, BackendUnavailableError)
    assert issubclass(BackendBinaryMissingError, RuntimeError)
    # ... and the degrade handlers really do let it through: `dream_step`
    # turns a backend that produces nothing into an "LLM returned empty"
    # failure, so a subclass would be swallowed here instead of raising.
    backend = build_backend("claude", _MissingBinaryRunner(), _settings())
    with pytest.raises(BackendBinaryMissingError):
        dream_step(
            persona=make_persona(), resources=FakeResources(), backend=backend, memory_text=""
        )


class _MissingBinaryRunner:
    """A `Runner` that fails the way `SubprocessRunner` does when argv[0] is
    absent from PATH (pinned against the real `subprocess` behaviour by
    `test_subprocess_runner_reports_a_missing_binary_as_its_own_type` in
    `test_cli.py`)."""

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        raise BackendBinaryMissingError(f"executable not found on PATH: {argv[0]!r}")


# ── the persona model must have no channel to disk but its return value ──────
#
# Found by the 2026-08-19 cutover round, not by review. `claude -p` without
# `--tools ""` runs the full Claude Code agent, and from this repo's working
# directory its Write tool needs no permission prompt. Two of that round's
# dreams used it: one overwrote a live `personality.md` with a candidate that
# had passed NO gate -- no archive, no drift check, no structural validators,
# no `/lab` snapshot -- while the runtime logged `LLM returned empty` (empty
# because the model spent its turn on the tool call) and `keeping original`,
# over an original that no longer existed. The other invented
# `agent/humans/fenziys/` for an account that lives under `agents/`.
#
# The constitution layer is a gate only while the model's single output channel
# is the string it returns. These tests are that invariant, per backend.


def test_claude_runs_with_no_tools() -> None:
    runner = RecordingRunner("hello")
    build_backend("claude", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model="haiku")
    )
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    # Asserted as an adjacent pair, not as `"--tools" in argv`: the flag takes
    # a value, and a `--tools` whose neighbour drifted to anything but the
    # empty string re-enables the tool set while still containing the flag.
    assert argv[argv.index("--tools") : argv.index("--tools") + 2] == ["--tools", ""]


def test_deepseek_runs_with_no_tools() -> None:
    """Same CLI, same exposure — and the deepseek branch builds its argv
    separately in Bash, so it has historically drifted from the claude one."""
    runner = RecordingRunner("hello")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="k").complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[argv.index("--tools") : argv.index("--tools") + 2] == ["--tools", ""]


def test_codex_runs_read_only_and_never_full_auto() -> None:
    """`--full-auto` is `-s workspace-write` plus auto-approval: a persona
    model that can edit this repo. `-o` is written by the CLI rather than by
    the model, so read-only still returns output (verified against the real
    binary on 2026-08-19)."""

    class CodexRunner(RecordingRunner):
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

    runner = CodexRunner()
    build_backend("codex", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert "--full-auto" not in argv
    assert argv[argv.index("-s") : argv.index("-s") + 2] == ["-s", "read-only"]


# ── the Persona Bench's call sites carry the same invariant ─────────────────
#
# The bench used to reach the claude and codex CLIs from Bash (`llm.sh`, and
# the judge in `benchmark-run.sh`), pinned here by text searches over those
# scripts. S3 ported it to `swil_agent/bench/`: the model under test goes
# through the same backend classes as the round, and the judge is its own
# argv over the `Runner`. These pin the Python argv of each bench call site.


class _CodexOutRunner(RecordingRunner):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
        cwd: str | None = None,
    ) -> str:
        super().run(argv, stdin, env, timeout, cwd)
        if argv[0] == "codex":
            Path(argv[argv.index("-o") + 1]).write_text("out", encoding="utf-8")
        return "out"


def _bench_call(spec: str) -> RunnerCall:
    from swil_agent.bench.judge import Judge
    from swil_agent.bench.models import resolve_model

    runner = _CodexOutRunner()
    if spec == "judge":
        Judge(runner, "sonnet").score("R", "O")
    else:
        model = resolve_model(spec, runner, _settings(), deepseek_api_key="k")
        model.backend.complete(CompletionRequest(system="S", user="U", model=model.model))
    return runner.calls[0]


def _bench_argv(spec: str) -> list[str]:
    return _bench_call(spec).argv


@pytest.mark.parametrize("spec", ["judge", "sonnet", "grok", "ds-flash", "claude:claude-opus-5-5"])
def test_every_bench_claude_invocation_disables_tools_and_is_isolated(spec: str) -> None:
    """The judge and every model-under-test spelling that lands on `claude -p`
    (bare aliases, `ds-flash`, the roster form): no built-in tools, none of
    the operator's configuration, and a temp cwd outside the repository."""
    call = _bench_call(spec)
    argv = call.argv
    assert argv[0] == "claude"
    tools = argv.index("--tools")
    assert argv[tools : tools + 2 + len(CLAUDE_ISOLATION_FLAGS)] == [
        "--tools",
        "",
        *CLAUDE_ISOLATION_FLAGS,
    ]
    assert_isolated_cwd(call)


def test_the_bench_grok_roster_form_is_tool_less_and_read_only() -> None:
    from swil_agent.llm.backends.grok import GROK_DISALLOWED_TOOLS, GROK_ISOLATION_ENV

    call = _bench_call("grok:grok-4.6")
    argv = call.argv
    assert argv[0] == "grok"
    assert argv[argv.index("--tools") : argv.index("--tools") + 2] == ["--tools", ""]
    denied = argv[argv.index("--disallowed-tools") + 1]
    assert denied.split(",") == list(GROK_DISALLOWED_TOOLS)
    assert call.env == GROK_ISOLATION_ENV
    assert argv[argv.index("--permission-mode") : argv.index("--permission-mode") + 2] == [
        "--permission-mode",
        "plan",
    ]


def test_the_bench_cursor_roster_form_runs_in_ask_mode() -> None:
    argv = _bench_argv("cursor:gemini-3.7-flash-high")
    assert argv[0] == "cursor-agent"
    assert argv[argv.index("--mode") : argv.index("--mode") + 2] == ["--mode", "ask"]


@pytest.mark.parametrize("spec", ["codex", "codex:gpt-5.6-luna"])
def test_bench_codex_invocation_is_not_full_auto(spec: str) -> None:
    call = _bench_call(spec)
    argv = call.argv
    assert argv[:2] == ["codex", "exec"]
    assert argv[argv.index("--ignore-user-config") : argv.index("--ignore-user-config") + 4] == [
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        call.cwd,
    ]
    assert_isolated_cwd(call)
    assert "--full-auto" not in argv
    assert argv[argv.index("-s") : argv.index("-s") + 2] == ["-s", "read-only"]
