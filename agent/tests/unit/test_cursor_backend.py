"""The Cursor CLI backend, and the three locks that replace `--tools ""`.

`cursor-agent` has no flag that disables its tools -- its own `--help` says
print mode "Has access to all tools, including write and shell." That is the
same exposure `claude -p` had on 2026-08-19, when two dreams wrote
`personality.md` straight to disk and the constitution layer stopped being a
gate. Measured against the real binary on 2026-08-21:

  * unguarded          -> created the file (so the guards below are not vacuous)
  * `--mode ask`       -> refused, in the MODEL's voice          (soft lock)
  * deny config        -> refused, in the RUNTIME's voice, under
                          `--force` and an explicit jailbreak prompt (hard lock)

These tests pin all three, because every one of them is a property of the argv
and the workspace that a future edit could quietly drop.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.llm.backends import build_backend
from swil_agent.llm.backends.cursor import CursorCLIBackend
from swil_agent.llm.errors import BackendConfigurationError, BackendUnavailableError
from swil_agent.llm.runner import CompletionRequest

REQ = CompletionRequest(system="SYS", user="USR", model="cursor-grok-4.6-high")


class WorkspaceReadingRunner:
    """Reads the workspace's permission config AT CALL TIME.

    A test that inspected the directory afterwards would always see nothing --
    the backend removes it in a `finally`. Reading from inside `run` is what
    proves the deny config is on disk *before* the subprocess would have
    started, which is the only moment at which it protects anything.
    """

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.argvs: list[list[str]] = []
        self.configs: list[dict[str, object]] = []
        self.workspaces: list[Path] = []
        self.listings: list[list[str]] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.argvs.append(list(argv))
        workspace = Path(argv[argv.index("--workspace") + 1])
        self.workspaces.append(workspace)
        config = workspace / ".cursor" / "cli.json"
        self.configs.append(json.loads(config.read_text(encoding="utf-8")))
        self.listings.append(sorted(p.name for p in workspace.iterdir()))
        return self.output


def _arg_after(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


# ── lock 1: the argv ──────────────────────────────────────────────────────


def test_ask_mode_is_on_the_argv() -> None:
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    assert _arg_after(argv, "--mode") == "ask"


def test_force_is_never_passed() -> None:
    """`--force` / `--yolo` re-open everything the deny config closes. There is
    no code path here that adds them, and this is what keeps it that way."""
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    for forbidden in ("--force", "-f", "--yolo", "--auto-review", "--approve-mcps"):
        assert forbidden not in argv, f"{forbidden} must never be passed"


def test_argv_shape() -> None:
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    argv = runner.argvs[0]
    assert argv[0] == "cursor-agent"
    assert "-p" in argv
    assert _arg_after(argv, "--output-format") == "text"
    assert _arg_after(argv, "--model") == "cursor-grok-4.6-high"
    assert "--trust" in argv


def test_system_and_user_are_joined_because_there_is_no_system_prompt_flag() -> None:
    """`cursor-agent` has no `--system-prompt`. The persona therefore arrives
    the same way it does for codex -- a known cross-backend confound, recorded
    here rather than discovered later in the data."""
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    prompt = runner.argvs[0][-1]
    assert prompt == "System:\nSYS\n\n---\n\nUSR"


# ── lock 2: the deny config ───────────────────────────────────────────────


def test_the_deny_config_exists_before_the_call_runs() -> None:
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    assert runner.configs[0] == {"permissions": {"allow": [], "deny": ["Shell(*)", "Write(**)"]}}


def test_the_deny_config_carries_no_version_key() -> None:
    """The project-local schema is stricter than `~/.cursor/cli-config.json`'s:
    measured against the real binary, a `"version"` key makes cursor-agent exit
    with `Unrecognized key(s) in object`. Loud rather than fail-open, but it
    kills the round -- so the shape is pinned."""
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    assert "version" not in runner.configs[0]


def test_nothing_is_allowed() -> None:
    """An `allow` entry would take effect for the tool it names; deny wins over
    allow, but an allow-listed tool outside the deny globs would not be caught."""
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    permissions = runner.configs[0]["permissions"]
    assert isinstance(permissions, dict)
    assert permissions["allow"] == []


def test_the_config_is_rebuilt_for_every_call() -> None:
    """The other backends' guarantee lives in the argv and is therefore
    reconstructed from scratch on every call. A config file checked into the
    repo would be ambient state -- editable, deletable, silently permissive
    once it drifts. Writing it per call is what restores that property, and two
    calls landing in two different workspaces is how you can tell."""
    runner = WorkspaceReadingRunner()
    backend = CursorCLIBackend(runner)
    backend.complete(REQ)
    backend.complete(REQ)
    assert runner.workspaces[0] != runner.workspaces[1]
    assert runner.configs[0] == runner.configs[1]


# ── lock 3: the workspace ─────────────────────────────────────────────────


def test_the_workspace_is_never_the_repository() -> None:
    """Containment. If both locks above somehow failed, the blast radius has to
    be a directory with nothing in it."""
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    workspace = runner.workspaces[0]
    repo = Path(__file__).resolve().parents[3]
    assert repo not in workspace.parents
    assert workspace != repo


def test_the_workspace_holds_nothing_but_the_config() -> None:
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    # Read from the listing the runner captured DURING the call. Listing it
    # here instead would raise FileNotFoundError -- the backend removes the
    # directory in a `finally`, so after the call there is nothing to inspect.
    assert runner.listings[0] == [".cursor"]


def test_the_workspace_is_removed_afterwards() -> None:
    runner = WorkspaceReadingRunner()
    CursorCLIBackend(runner).complete(REQ)
    assert not runner.workspaces[0].exists()


def test_the_workspace_is_removed_even_when_the_call_raises() -> None:
    class Exploding(WorkspaceReadingRunner):
        def run(self, argv, stdin=None, env=None, timeout=300.0):  # type: ignore[no-untyped-def]
            super().run(argv, stdin, env, timeout)
            raise RuntimeError("boom")

    runner = Exploding()
    with pytest.raises(RuntimeError):
        CursorCLIBackend(runner).complete(REQ)
    assert not runner.workspaces[0].exists()


# ── model discipline ──────────────────────────────────────────────────────


def test_a_missing_model_is_refused_rather_than_routed_to_auto() -> None:
    """`cursor-agent` with no `--model` uses its `auto` router, which re-picks
    whenever Cursor changes routing -- while `agentBackend` would still read a
    flat `cursor`. The experiment's independent variable must not be able to
    move on someone else's deploy."""
    runner = WorkspaceReadingRunner()
    with pytest.raises(BackendConfigurationError, match="requires an explicit model"):
        CursorCLIBackend(runner).complete(CompletionRequest(system="S", user="U"))
    assert runner.argvs == [], "nothing should have been spawned"


def test_silence_is_reported_like_every_other_backend() -> None:
    runner = WorkspaceReadingRunner(output="")
    with pytest.raises(BackendUnavailableError, match="produced no output"):
        CursorCLIBackend(runner).complete(REQ)


def test_build_backend_knows_the_name() -> None:
    backend = build_backend("cursor", WorkspaceReadingRunner(), Settings(swil_url="https://e.test"))
    assert isinstance(backend, CursorCLIBackend)
