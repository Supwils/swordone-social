"""Tests for `swil_agent.cli` (task 13) -- the `swil-agent` entrypoints that
compose every layer built by Tasks 1-12 into `act`/`dream`/`version`
commands.

`cli.py` is the ONLY composition root in the package (module docstring), so
these tests exercise it two ways:

  * through `typer.testing.CliRunner`, with every network/subprocess-facing
    builder (`_resources_for`, `_backend_for`, `_embedder_for`, `_guard_for`,
    `_health_check`) monkeypatched to an in-memory fake -- a CLI test must
    never dial a real socket or spawn a real `claude`/`codex`/`bash` process;
  * directly, for the builder helpers themselves (`_resources_for` with a
    real `ApiClient` over `httpx.MockTransport`, `_health_check` the same
    way, `_probe_embedder` against a fake `EmbedderClient`), so the
    composition helpers are not only ever exercised through a monkeypatched
    substitute of themselves.

No test in this file ever calls the real `load_settings()` against
`agent/.env` -- that file is deliberately absent from this worktree (see
CLAUDE.md's "Manual deploys only" / the task-13 brief), and every test here
builds its own `Settings(agent_root=tmp_path, ...)` instead.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import re
import time
from collections.abc import Callable, Iterator
from datetime import datetime as _real_datetime
from datetime import timedelta
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.api.auth import PasswordAuth
from swil_agent.api.client import ApiError
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import EmbedderGuard
from swil_agent.llm.base import (
    BackendBinaryMissingError,
    BackendUnavailableError,
    SubprocessRunner,
)
from swil_agent.locks import act_lock_path
from swil_agent.models import Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import (
    FakeResources,
    RecordingRunner,
    ScriptedBackend,
    StubBackend,
    make_persona,
)

runner = CliRunner()

_ERA_START = "2000-01-01T00:00:00Z"


@pytest.fixture(autouse=True)
def _era_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """`act`/`cycle`/`doctor` refuse to run without ERA_START. Every
    `Settings(...)` built in this file reads it from the env; a date this far
    back keeps every fake post inside the era. Tests about the unset case
    `delenv` it again."""
    monkeypatch.setenv("ERA_START", _ERA_START)


def _personality(username: str, *, model: str = "claude:opus") -> str:
    """A valid Era 3 persona file for `username` (the loader requires the
    directory name to match it)."""
    return f"""---
username: {username}
display_name: 测试
bio: 一句话简介
model: {model}
board: ai
topics: [alpha, beta]
era: 3
---
# 测试用人格

一个测试用的账号。

## 最近
- 一件旧事
"""


ZENITH_PERSONALITY = _personality("zenith")

# The dream's reply: a new 最近 list, and one that parses as nothing at all.
DREAM_REPLY = '{"recent": ["改写后的近况"]}'
BAD_DREAM_REPLY = "我今天什么也不想写。"

_INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

_POST_PLAN = '{"plan":[{"action":"post","text":"hello from zenith"}]}'
_EMPTY_PLAN = '{"plan":[]}'

# One `/posts/search` result for the follow-topics world-context block. The
# marker is in the TEXT, not the id, because that is the field the rendered
# line truncates -- an assertion on the id would survive a renderer that
# dropped the body.
_SEARCH_HIT = {
    "id": "s" * 24,
    "text": "SEARCH-HIT-2208",
    "createdAt": "2026-09-26T08:00:00.000Z",
    "author": {"username": "someone", "displayName": "某人"},
}


def _write_zenith(tmp_path: Path, *, personality: str = ZENITH_PERSONALITY) -> Path:
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    return directory


class _FakeEmbedderClient:
    """A minimal `EmbedderClient` double: `.embed()` for the `Embedder`
    protocol `run_dream` needs, `.health()` for the R10 probe -- the real
    `EmbedderClient` is the only production type that carries both, so this
    stands in for the whole thing rather than composing two separate fakes.
    """

    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy
        self.health_calls = 0

    def health(self) -> dict[str, object]:
        self.health_calls += 1
        if not self.healthy:
            raise EmbedderUnavailable("embedder down (test)")
        return {"ok": True}

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] for _ in texts]


class _FakeGuard:
    """A no-op `EmbedderGuard` double -- the real one shells out to
    `bash embedder-guard.sh up/down`, which a unit test must never do."""

    def __init__(self) -> None:
        self.up_calls = 0
        self.down_calls = 0

    def up(self) -> None:
        self.up_calls += 1

    def down(self) -> None:
        self.down_calls += 1


def _memory_unchanged(tmp_agent: Path) -> bool:
    path = tmp_agent / "agents" / "zenith" / "memory.md"
    return path.read_text(encoding="utf-8") == _INITIAL_MEMORY


def _hold_lock(tmp_agent: Path, name: str) -> None:
    """A FRESH lock file (mtime "now") -- FileLock treats it as actively
    held, not stale, so `run_act` must raise `LockBusy` rather than steal
    it."""
    path = act_lock_path(tmp_agent, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("999999\n", encoding="utf-8")


def _set_last_dream(tmp_agent: Path, name: str, *, hours_ago: float) -> None:
    """Writes the `last_dream_<name>` marker `FilesystemDreamState` reads. The
    fixture's memory lines are all dated before it, so the new-memories
    override never fires and the account stays blocked."""
    state_dir = tmp_agent / ".agent-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    at = int(time.time() - hours_ago * 3600)
    (state_dir / f"last_dream_{name}").write_text(str(at), encoding="utf-8")


@pytest.fixture
def tmp_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A one-account roster (`zenith`) under `tmp_path`, wired so `act`/
    `dream` never touch a real network, subprocess, or `agent/.env`.

    Every builder monkeypatch below can be overridden again inside an
    individual test (the `monkeypatch` fixture is shared, so a later
    `setattr` for the same name simply wins for that test).
    """
    _write_zenith(tmp_path)
    # `behavior_post_limit` and `post_duplicate_window` both default to 12
    # (also `Resources.user_posts`' own default), so each gets a distinct
    # non-default value: the field each command actually reads is then
    # observable at the wire. `post_probability=100` and a high ceiling make
    # the unseeded rhythm roll always MUST_POST, so a planned post is never
    # vetoed by chance or by an earlier test command's post.
    settings = Settings(
        agent_root=tmp_path,
        behavior_post_limit=7,
        post_duplicate_window=9,
        post_probability=100,
        post_ceiling_per_day=10,
    )

    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_POST_PLAN))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)
    return tmp_path


# ── act ──────────────────────────────────────────────────────────────────


def test_act_dry_run_executes_nothing_and_writes_nothing(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "would execute" in result.stdout
    assert _memory_unchanged(tmp_agent)


def test_act_reports_the_outcome_name(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert "planner_empty" in result.stdout or "landed" in result.stdout


def test_act_hands_run_act_an_embedder_and_the_configured_window(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The duplicate guard's self-similarity sample reaches the wire from THIS
    command, not only from `cycle`.

    `embedder=None` here would leave every `swil-agent act` round unguarded
    while the whole suite stayed green. The window is 9, the fixture's
    `post_duplicate_window`: neither the default (12) nor the behaviour
    sampler's (7), so reading the wrong `Settings` field is visible here.

    Two prior posts, because `MIN_COMPARISON_CORPUS` is 2 -- a shorter corpus
    would take the skip path and never call the embedder, which would pass
    this test for the wrong reason.
    """
    resources = FakeResources()
    resources.user_post_items = [{"text": "第一条"}, {"text": "第二条"}]
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 0
    assert resources.user_posts_calls == [("zenith", 9)]
    measured = [e for e in resources.lab_events if e.summary.startswith("act self-similarity")]
    assert [e.outcome for e in measured] == ["success"]
    assert measured[0].metrics["comparedAgainst"] == 2


def test_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "nosuchagent"])
    assert result.exit_code == 66


def _close_the_era(monkeypatch: pytest.MonkeyPatch) -> None:
    unset = cli.load_settings().model_copy(update={"era_start": None})
    monkeypatch.setattr(cli, "load_settings", lambda: unset)


def test_act_without_era_start_exits_75_with_the_remedy_and_writes_nothing(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _close_the_era(monkeypatch)
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 75
    assert cli.ERA_START_REMEDY in result.output
    assert _memory_unchanged(tmp_agent)


def test_act_without_era_start_still_reports_an_unknown_account_as_66(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _close_the_era(monkeypatch)
    result = runner.invoke(cli.app, ["act", "nosuchagent"])
    assert result.exit_code == 66


def test_a_held_lock_exits_75(tmp_agent: Path) -> None:
    _hold_lock(tmp_agent, "zenith")
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 75


def test_a_real_act_run_lands_the_plan_and_exits_0(tmp_agent: Path) -> None:
    """Not `--dry-run`: the fake `Resources.create_post` really "lands", so
    the outcome is `landed_all` and a memory.md line IS appended -- the
    positive-path sibling of the dry-run inertness test above, proving
    `--dry-run`'s inertness is a real branch and not just the only path this
    suite exercises.

    `/100` pins the rhythm settings' forwarding: the fixture sets
    `post_probability=100`, and a `run_act` left on its own default would
    roll against 60 (and veto the post on most rolls)."""
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0
    assert "landed_all" in result.stdout
    assert "policy=must_post" in result.stdout
    assert "/100" in result.stdout
    assert not _memory_unchanged(tmp_agent)


def test_act_dry_run_with_an_empty_plan_reports_nothing_and_planner_empty(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_EMPTY_PLAN))
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "(nothing)" in result.stdout
    assert "planner_empty" in result.stdout


def test_act_reports_vetoed_actions(tmp_agent: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A DM to someone not in contacts is stripped by the guardrail and
    lands in `result.vetoed`, exercising the CLI's veto-reporting line.
    Codex is no longer allow-listed (loop-engine spec §7); this veto is
    independent of backend."""
    dm_plan = '{"plan":[{"action":"dm","username":"vex","text":"hi"}]}'
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(dm_plan))

    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert "vetoed" in result.stdout


def test_act_with_no_credentials_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No `api_key.txt` at all and no `SWIL_PASS` -- `resolve_auth` raises
    `ValueError`, which used to escape `act` as a raw traceback and exit 1,
    a code neither `cycle-one.sh` nor the heartbeat knows how to interpret.
    `_resources_for` runs for REAL here (unlike every other test in this
    file, which monkeypatches it away) -- this test exists specifically to
    prove the exception this function can actually raise is caught, not a
    stand-in's."""
    _write_zenith(tmp_path)  # no api_key.txt written
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "register" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout
    assert result.exception is None or isinstance(result.exception, SystemExit)


def test_act_with_a_blank_api_key_file_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of spec §15.1 row 3: a PRESENT but blank `api_key.txt`
    raises `ValueError` from `ApiKeyAuth.from_file`, not `FileNotFoundError`
    -- `resolve_auth` already catches both shapes correctly (api/auth.py),
    so this must reach the exact same SKIP/exit-75 path as the missing-file
    case above, not a different, uncaught one."""
    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("   \n", encoding="utf-8")
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "register" in result.stdout
    assert "Traceback" not in result.stdout


class _FailingPasswordAuth(PasswordAuth):
    """A `PasswordAuth` whose `login()` fails deterministically, with no
    network involved -- `isinstance(auth, PasswordAuth)` is a real subclass
    check inside `_resources_for`, so this is the only way to force that
    branch's `login()` call to raise without a `transport=` seam (the full
    `CliRunner` path never threads one through)."""

    def login(self, client: object) -> None:
        raise RuntimeError("login succeeded but no sid cookie was returned")


def test_act_with_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`load_persona` raises `ValueError` (not `FileNotFoundError`) for a
    personality.md that EXISTS but is not a valid Era 3 file (no
    frontmatter). That is a different failure than "no such account" -- the
    file is right there -- so it must land on exit 75 with a remedy naming
    the frontmatter, not exit 66 or a raw traceback."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "frontmatter" in result.stdout
    assert "Traceback" not in result.stdout


def test_act_with_a_dead_deepseek_key_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_backend_for` runs for REAL here -- only `get_backend` (the factory it
    calls internally) is faked, deterministically, to raise the exact
    `BackendUnavailableError` a missing `~/.claude/.deepseek-key` produces in
    production, without this test ever touching that real file (whose
    presence/absence would otherwise make the test machine-dependent)."""
    directory = _write_zenith(tmp_path)
    (directory / "personality.md").write_text(
        ZENITH_PERSONALITY.replace("- **AI Backend:** claude", "- **AI Backend:** deepseek"),
        encoding="utf-8",
    )
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)

    def _dead_key(
        choice: object,
        runner: object,
        settings: Settings,
        *,
        deepseek_api_key: str | None = None,
        transport: object | None = None,
    ) -> object:
        raise BackendUnavailableError("deepseek key not found at /fake/.claude/.deepseek-key")

    monkeypatch.setattr(cli, "get_backend", _dead_key)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert ".deepseek-key" in result.stdout
    assert "Traceback" not in result.stdout


def test_act_with_a_failed_login_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `SWIL_PASS`-fallback sibling of the credentials tests above: this
    account HAS a working fallback (`SWIL_PASS` is set), but the login
    itself fails -- the coordinator's ranking of this as the most likely of
    the three escape paths to fire in real use, since it can trip on every
    invocation of a `SWIL_PASS` account, not only once at setup."""
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="wrongpass")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)
    monkeypatch.setattr(
        cli,
        "resolve_auth",
        lambda directory, *, username, password: _FailingPasswordAuth(username, password),
    )

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout


class _InjectedBugError(Exception):
    """A stand-in for a genuine programming error -- deliberately NOT an
    `AccountSetupError` or `LockBusy`, so it cannot be misclassified as a
    known setup failure. Injected directly into the composition root
    (`_resources_for`), per the coordinator's instruction, rather than by
    contriving a real dependency to break."""


def test_act_an_unexpected_composition_failure_exits_75_and_logs_unexpected(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def _boom(persona: Persona, settings: Settings) -> FakeResources:
        raise _InjectedBugError("boom -- not a setup failure")

    monkeypatch.setattr(cli, "_resources_for", _boom)

    with caplog.at_level("DEBUG"):
        result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED _InjectedBugError" in result.stdout
    assert "boom -- not a setup failure" in result.stdout
    assert "Traceback" not in result.stdout
    debug_records = [r for r in caplog.records if r.levelname == "DEBUG"]
    assert len(debug_records) == 1
    assert debug_records[0].exc_info is not None
    assert debug_records[0].exc_info[0] is _InjectedBugError


def test_act_seed_makes_the_rhythm_roll_reproducible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--seed` makes the uniform rhythm roll (a `random.Random` draw against
    `POST_PROBABILITY`, made before the LLM is called, `persona/rhythm.py`)
    reproducible. Two dry runs with the SAME seed must print the identical
    rhythm decision and plan."""
    _write_zenith(tmp_path, personality=ZENITH_PERSONALITY)
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_POST_PLAN))
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)

    first = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "7"])
    second = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "7"])

    assert first.exit_code == 0
    assert first.stdout == second.stdout


# ── dream ────────────────────────────────────────────────────────────────


def test_dream_honours_auto_cooldown(tmp_agent: Path) -> None:
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)
    result = runner.invoke(cli.app, ["dream", "zenith", "--auto"])
    assert "cooldown" in result.stdout
    assert result.exit_code == 75


def test_dream_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["dream", "nosuchagent"])
    assert result.exit_code == 66


def test_dream_a_held_lock_exits_75(tmp_agent: Path) -> None:
    from swil_agent.locks import dream_lock_path

    path = dream_lock_path(tmp_agent, "zenith")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("999999\n", encoding="utf-8")

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 75


def test_dream_with_no_credentials_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dream`'s sibling of the `act` credentials test above: `_resources_for`
    is built inside `_do_dream`, reached only after `_embedder_for`/
    `_guard_for` -- those two are faked here (never the point of this test)
    so the only real thing running is auth resolution against a REAL,
    credential-less `tmp_path` roster. The guard must still bracket cleanly
    (`up()` then `down()`, exactly once each) even on this failure path."""
    _write_zenith(tmp_path)  # no api_key.txt written
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "register" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_with_a_blank_api_key_file_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The blank-file half of spec §15.1 row 3, for `dream` -- see the `act`
    sibling test above for why both shapes need their own coverage."""
    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("   \n", encoding="utf-8")
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "register" in result.stdout
    assert "Traceback" not in result.stdout


def test_dream_with_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dream`'s sibling of the `act` unparseable-persona test -- this one
    also proves the embedder guard is never started at all when persona
    loading fails, since that failure is caught in `dream`'s FIRST try
    block, before `guard.up()` is ever reached."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    settings = Settings(agent_root=tmp_path)
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "frontmatter" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 0
    assert guard.down_calls == 0


def test_dream_an_unexpected_composition_failure_exits_75_logs_unexpected_and_stops_the_guard(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The `dream` sibling of the `act` UNEXPECTED test -- this one also
    proves the SECOND try block's `finally: guard.down()` still runs on an
    unexpected exception, not only on the known ones the other guard-bracket
    test exercises."""
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    def _boom(settings: Settings) -> EmbedderClient:
        raise _InjectedBugError("boom -- not a setup failure")

    monkeypatch.setattr(cli, "_embedder_for", _boom)

    with caplog.at_level("DEBUG"):
        result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED _InjectedBugError" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_guard_brackets_the_whole_call_up_then_down(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R10 (progress.md task 2/12 forward requirement): the CLI, not
    `run_dream`, owns the embedder guard bracket -- `run_dream`'s own
    docstring documents this explicitly. Proves `up()` runs before `down()`
    and both run exactly once for a single `dream` invocation."""
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    _set_last_dream(tmp_agent, "zenith", hours_ago=1)  # cheapest path: cooldown SKIP
    runner.invoke(cli.app, ["dream", "zenith", "--auto"])

    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_logs_loudly_once_when_embedder_is_down_after_guard_up(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """R10: `EmbedderGuard.up()` cannot fail loudly (`embedder-guard.sh`
    always exits 0), so a dead embedder must be surfaced by an explicit
    post-`up()` health probe, logged at ERROR -- once per CLI invocation,
    not once per dream (that per-dream granularity is the snapshot upload's
    own WARN, which is deliberately a different, quieter signal). Blocking
    the account on cooldown keeps this test from needing a working
    backend/runner -- the probe fires before the cooldown check either way."""
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient(healthy=False))
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)

    with caplog.at_level("ERROR"):
        runner.invoke(cli.app, ["dream", "zenith", "--auto"])

    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert len(errors) == 1
    assert "embedder" in errors[0].getMessage().lower()


def test_dream_force_mode_writes_and_reports_the_new_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force mode (no `--auto`) always proceeds past cooldown -- a real,
    end-to-end dream that rewrites 最近, not just the cooldown-SKIP path the
    other dream tests use to stay cheap."""
    directory = _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(DREAM_REPLY))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0
    assert "zenith: dream written -- 最近 updated (1 items)" in result.stdout
    assert "改写后的近况" in (directory / "personality.md").read_text(encoding="utf-8")


def test_dream_force_mode_reports_an_unparseable_reply_as_a_failed_dream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`proceeded=True, accepted=False` -- the LLM ran but its reply held no
    usable list, so nothing was written. Exit code is still 0 ("something
    ran"), matching `act`'s own "attempted, whether it landed or not"
    shape."""
    directory = _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(BAD_DREAM_REPLY))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0
    assert "zenith: dream failed -- unparseable dream output" in result.stdout
    assert (directory / "personality.md").read_text(encoding="utf-8") == ZENITH_PERSONALITY


def test_dream_does_not_log_when_embedder_is_healthy(
    tmp_agent: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)
    with caplog.at_level("ERROR"):
        runner.invoke(cli.app, ["dream", "zenith", "--auto"])
    assert [r for r in caplog.records if r.levelname == "ERROR"] == []


# ── cycle ────────────────────────────────────────────────────────────────


def _cycle_backend() -> ScriptedBackend:
    """One backend object for a whole cycle: the plan, then the dream's new
    list -- in the order `run_cycle` spends them."""
    return ScriptedBackend(_POST_PLAN, DREAM_REPLY)


@pytest.fixture
def tmp_cycle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`tmp_agent`'s sibling for the `cycle` command.

    Separate rather than a parameter on `tmp_agent` because a cycle needs a
    backend that answers TWO different prompts in order (`StubBackend`
    answers every prompt identically, which would feed the plan JSON to the
    dream).
    """
    _write_zenith(tmp_path)
    _patch_cycle_seams(monkeypatch, tmp_path)
    return tmp_path


def _patch_cycle_seams(monkeypatch: pytest.MonkeyPatch, agent_root: Path) -> None:
    """Every network-, subprocess- and clock-facing seam a cycle reaches.

    `_runner_for` is patched too: the world-context renderers shell out
    through it, and a unit test must never spawn a real process.
    """
    # The rhythm roll always lets the planned post through, even after an
    # earlier command in the same test already posted today.
    settings = Settings(agent_root=agent_root, post_probability=100, post_ceiling_per_day=10)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: _cycle_backend())
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)
    monkeypatch.setattr(cli, "_runner_for", lambda settings: RecordingRunner())


def test_cycle_runs_the_act_and_the_dream_in_one_process_and_exits_0(tmp_cycle: Path) -> None:
    """The whole point of the command: `cycle-one.sh`'s two processes become
    one graph run. Asserted on EFFECTS -- the act's memory line and the
    dream's rewritten `personality.md` -- because both halves reporting
    "success" on stdout is exactly what a cycle that silently skipped its
    dream would also print."""
    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 0
    assert "landed_all" in result.stdout
    assert "dream written" in result.stdout
    assert not _memory_unchanged(tmp_cycle)
    personality = (tmp_cycle / "agents" / "zenith" / "personality.md").read_text(encoding="utf-8")
    assert "改写后的近况" in personality
    assert (tmp_cycle / "agents" / "zenith" / "personality.archive.md").exists()


def test_cycle_an_unknown_account_exits_66(tmp_cycle: Path) -> None:
    """66 keeps meaning exactly one thing across all three commands --
    `cycle-one.sh` and the heartbeat branch on the code, not on the text."""
    result = runner.invoke(cli.app, ["cycle", "nosuchagent"])
    assert result.exit_code == 66
    assert "no such account: nosuchagent" in result.output


def test_cycle_without_era_start_exits_75_with_the_remedy_and_never_runs(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _close_the_era(monkeypatch)

    def _never(**_kwargs: object) -> object:
        raise AssertionError("run_cycle must not start without ERA_START")

    monkeypatch.setattr(cli, "run_cycle", _never)
    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])
    assert result.exit_code == 75
    assert cli.ERA_START_REMEDY in result.output


def test_cycle_exits_75_when_the_platform_is_unreachable(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """0-vs-75 is `ActResult.grants_dream` over the final outcome -- the same
    decision `act` exits on. `OFFLINE` is one of the two outcomes that deny
    the round, so `cycle-one.sh`'s "act did not land, skip the dream" branch
    sees the code it expects."""
    monkeypatch.setattr(cli, "_health_check", lambda settings: False)
    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 75
    assert "offline" in result.stdout


def test_cycle_a_busy_lease_skips_with_a_cause_and_a_remedy_and_exits_75(
    tmp_cycle: Path,
) -> None:
    """`LeaseBusy` is a `RuntimeError` and not in `_KNOWN_SETUP_FAILURES`, so
    without `_lease_busy_guard` a locked account reads as `UNEXPECTED
    LeaseBusy` -- a programming error -- when it is the most ordinary thing
    that happens to a parallel round.

    The remedy is the one this project has actually needed: an accepted Bash
    dream exits 141 after "snapshot uploaded" and orphans its lock, so "held"
    and "orphaned" look identical until someone checks the pid.
    """
    _hold_lock(tmp_cycle, "zenith")
    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 75
    assert "SKIP zenith" in result.stdout
    assert "lease busy" in result.stdout
    assert "pid" in result.stdout
    assert "UNEXPECTED" not in result.stdout
    assert "Traceback" not in result.stdout


def test_cycle_with_no_credentials_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The composition-failure path, with `_resources_for` running for REAL
    against a credential-less roster -- and the guard bracketed cleanly."""
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 75
    assert "register" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_cycle_an_unexpected_failure_exits_75_and_logs_unexpected(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Exit 1 is a fourth code neither `cycle-one.sh` nor the heartbeat can
    read, so even a genuine bug leaves through the 0/66/75 contract -- named
    `UNEXPECTED` so it is never mistaken for something `register`
    fixes."""

    def _boom(persona: Persona, settings: Settings) -> FakeResources:
        raise _InjectedBugError("boom -- not a setup failure")

    monkeypatch.setattr(cli, "_resources_for", _boom)
    with caplog.at_level("DEBUG"):
        result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED _InjectedBugError" in result.stdout
    assert "Traceback" not in result.stdout


def test_cycle_leaves_no_lock_file_or_lease_row_behind(tmp_cycle: Path) -> None:
    """The orphan-lock class: a cycle that exits without releasing costs the
    account every round for the next 30 minutes, in BOTH runtimes."""
    from swil_agent.locks import dream_lock_path

    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 0
    assert not act_lock_path(tmp_cycle, "zenith").exists()
    assert not dream_lock_path(tmp_cycle, "zenith").exists()


def test_cycle_stores_opens_the_lease_db_with_wal_and_a_tuned_busy_timeout(tmp_path: Path) -> None:
    """`_cycle_stores` is the only production call site that opens
    `run_leases.sqlite` for real. If it regressed to a bare
    `sqlite3.connect(...)` instead of `open_lease_db(...)`, the WAL and
    `busy_timeout` pragmas (spec §15.1 row 23) would never reach the
    connection a live cycle's `RunLease` actually uses, and stage 4's 3-5
    concurrent Python cycles would be back to an immediate `database is
    locked` under contention. Queried on the connection this function hands
    back, not inferred from which helper it happened to call.
    """
    settings = Settings(agent_root=tmp_path)
    with cli._cycle_stores(settings, dry_run=False) as stores:
        journal_mode = stores.lease_db.execute("PRAGMA journal_mode").fetchone()[0]
        busy_timeout = stores.lease_db.execute("PRAGMA busy_timeout").fetchone()[0]
    assert str(journal_mode).lower() == "wal"
    assert int(busy_timeout) == 8000


def test_cycle_stores_dry_run_lease_db_is_in_memory_but_still_tunes_busy_timeout(
    tmp_path: Path,
) -> None:
    """The dry-run branch swaps the target path for `:memory:` (so a shadow
    round leaves no file on disk, spec §10 stage 3) but still goes through
    `open_lease_db` rather than a raw `sqlite3.connect` -- `busy_timeout` is
    harmless to set on a private in-memory connection nothing else can ever
    contend for; only WAL is the one pragma `:memory:` cannot honour."""
    settings = Settings(agent_root=tmp_path)
    with cli._cycle_stores(settings, dry_run=True) as stores:
        busy_timeout = stores.lease_db.execute("PRAGMA busy_timeout").fetchone()[0]
    assert int(busy_timeout) == 8000


class _LockWatchingProbe:
    """A `_health_check` stand-in that records what `.agent-state/` looked
    like at the moment the FIRST node ran -- i.e. with any lease held."""

    def __init__(self, agent_root: Path) -> None:
        self._root = agent_root
        self.lock_files: list[str] = []

    def __call__(self, settings: Settings) -> bool:
        state_dir = self._root / ".agent-state"
        self.lock_files = sorted(path.name for path in state_dir.glob("*lock_*"))
        return True


def test_cycle_dry_run_takes_no_lease_and_writes_nothing(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """F4, and design spec §9.4's whole premise.

    A dry run executes nothing and writes nothing, so it needs no mutual
    exclusion -- and taking the lock costs a concurrent real Bash round its
    entire turn (`auto-run.sh`'s `acquire_lock` failure path returns 75 and
    skips the account). The lock has to be observed DURING the run: a cycle
    that took and released it leaves exactly the same empty directory behind
    as one that never took it.

    "Writes nothing" is asserted on four surfaces, because each is a
    different way for a shadow round to leave a mark: `memory.md`,
    `personality.md`, and the two SQLite databases -- `sqlite3.connect(path)`
    creates its file whether or not anything is ever written through it.
    """
    probe = _LockWatchingProbe(tmp_cycle)
    monkeypatch.setattr(cli, "_health_check", probe)

    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])

    assert result.exit_code == 0
    assert probe.lock_files == []
    assert _memory_unchanged(tmp_cycle)
    assert (tmp_cycle / "agents" / "zenith" / "personality.md").read_text(
        encoding="utf-8"
    ) == ZENITH_PERSONALITY
    assert not (tmp_cycle / ".agent-state" / cli.LEASE_DB_NAME).exists()
    assert not (tmp_cycle / ".agent-state" / cli.CHECKPOINT_DB_NAME).exists()


def test_cycle_dry_run_still_reports_the_plan_it_would_have_executed(tmp_cycle: Path) -> None:
    """The other half: §9.4 compares the rhythm policy, the guardrail
    verdicts and the veto lists, so a dry run that produced no plan would
    make the shadow round measure nothing."""
    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "would execute: post" in result.stdout


def test_cycle_dry_run_does_not_dream(tmp_cycle: Path) -> None:
    """A shadow round "executes nothing and **writes nothing**" -- and the
    dream phase's two write steps take no `dry_run` to be inert under, so a
    dry cycle that entered it would rewrite 23 real `personality.md` files
    during the round whose exit criterion is "Python never wrote".

    Asserted on the REPORT as well as on disk: no dream line at all, because
    the phase did not run -- which is a different thing from a dream that ran
    and was rejected.
    """
    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])
    assert "dream" not in result.stdout
    # NOT a `SKIP zenith -- ` line either. `_report_dream_result` renders a
    # dream that never proceeded as `SKIP <name> -- <reason>`, and with an
    # absent reason that is a bare `SKIP zenith -- ` for every shadow round on
    # the roster: 23 spurious SKIP lines in the very output stage 3 exists to
    # read (standing constraint §9).
    assert "SKIP zenith" not in result.stdout
    assert not (tmp_cycle / "agents" / "zenith" / "personality.archive.md").exists()


# ── cycle: the two round logs ─────────────────────────────────────────────


def test_a_cycle_splits_its_act_and_dream_lines_across_the_two_log_files(
    tmp_cycle: Path, round_log_level: None
) -> None:
    """`auto-run.sh:34` and `dream.sh:40` write to two different files, and a
    cycle produces BOTH phases in one process -- so the destination cannot be
    chosen per command the way `act`'s and `dream`'s are. Plan 2 shipped a
    version that sent both to `auto-run.log` and no test caught it.

    Both directions are asserted, because either one alone lets a mutation
    through: an act line in `dream.log` is as wrong as a dream line in
    `auto-run.log`, and a filter that simply sent everything to one file
    passes any single-direction check.
    """
    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 0

    act_lines = _round_log_lines(tmp_cycle, "auto-run.log")
    dream_lines = _round_log_lines(tmp_cycle, "dream.log")

    assert any("DONE zenith posted" in line for line in act_lines), act_lines
    assert not any("dreamed" in line for line in act_lines), act_lines

    assert any("dreamed" in line for line in dream_lines), dream_lines
    assert any("snapshot uploaded" in line for line in dream_lines), dream_lines
    assert not any("posted" in line for line in dream_lines), dream_lines


def test_a_cycles_logout_record_lands_in_the_act_log(
    tmp_cycle: Path, round_log_level: None
) -> None:
    """§7.6's terminal record is the only line that says a cycle reached its
    end rather than dying somewhere in the middle, and it belongs where
    Bash's own `=== auto-run complete ===` is. It comes from
    `swil_agent.graph.nodes`, the ONE module that emits both phases -- the
    dream node's deadline FAIL is a child logger for exactly this reason, so
    routing by module alone would put one of the two in the wrong file."""
    runner.invoke(cli.app, ["cycle", "zenith"])
    assert any("logout zenith" in line for line in _round_log_lines(tmp_cycle, "auto-run.log"))
    assert not any("logout zenith" in line for line in _round_log_lines(tmp_cycle, "dream.log"))


def test_a_cycles_analysis_samplers_land_in_the_act_log(
    tmp_cycle: Path, round_log_level: None
) -> None:
    """`behavior_snapshot` measures the ACT phase, so its records belong with
    it. Asserted in both directions: a `swil_agent.analysis` prefix added to
    `_DREAM_LOG_SOURCES` would move the line into the file an operator greps
    for dreams, and only this test would say so.
    """
    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 0

    act_lines = _round_log_lines(tmp_cycle, "auto-run.log")
    dream_lines = _round_log_lines(tmp_cycle, "dream.log")
    assert any("behavior-snapshot:" in line for line in act_lines), act_lines
    assert not any("behavior-snapshot:" in line for line in dream_lines), dream_lines


def test_a_cycles_dream_deadline_fail_lands_in_the_dream_log(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch, round_log_level: None
) -> None:
    """`swil_agent.graph.nodes` is the ONE module that emits records from both
    phases: the logout record (the cycle's own terminal line, act log) and the
    dream node's deadline `FAIL` (dream log). Routing by module alone puts one
    of the two in the wrong file, which is why the deadline line goes through
    a child logger.

    Nothing else in the suite exercises this: without it, deleting
    `"swil_agent.graph.nodes.dream"` from `_DREAM_LOG_SOURCES` leaves the
    whole suite green and quietly moves every deadline FAIL into
    `auto-run.log`, where a dream-log grep will never find it.

    The deadline is squeezed to zero through `_cycle_deps_for`'s own return
    value rather than by patching the module constant -- `CycleDeps` captures
    that constant as a dataclass DEFAULT at class-definition time, so patching
    it afterwards changes nothing.
    """
    from dataclasses import replace

    real_deps = cli._cycle_deps_for

    def _no_time_at_all(*args: object, **kwargs: object) -> object:
        return replace(real_deps(*args, **kwargs), dream_deadline_seconds=0.0)  # type: ignore[arg-type]

    monkeypatch.setattr(cli, "_cycle_deps_for", _no_time_at_all)
    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 0

    dream_lines = _round_log_lines(tmp_cycle, "dream.log")
    assert any("deadline" in line for line in dream_lines), dream_lines
    assert not any("deadline" in line for line in _round_log_lines(tmp_cycle, "auto-run.log"))


def test_a_cycles_embedder_probe_stays_in_the_dream_log(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch, round_log_level: None
) -> None:
    """The round-level embedder-down ERROR is about the dream's snapshot
    upload, and `swil-agent dream` already writes it to `dream.log`. A probe that changed
    file depending on which command ran it is the kind of inconsistency
    nobody notices until they grep for it during an outage."""
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient(healthy=False))
    runner.invoke(cli.app, ["cycle", "zenith"])

    assert any("embedder unreachable" in line for line in _round_log_lines(tmp_cycle, "dream.log"))
    assert not any(
        "embedder unreachable" in line for line in _round_log_lines(tmp_cycle, "auto-run.log")
    )


def test_switching_between_act_and_cycle_does_not_double_any_line(
    tmp_cycle: Path, round_log_level: None
) -> None:
    """`act` attaches ONE unfiltered handler to `auto-run.log`; `cycle`
    attaches a FILTERED one to the same path plus a second on `dream.log`.
    Both include a handler on `auto-run.log`, so an idempotency check keyed on
    the path alone would treat the second attachment as a no-op and leave the
    unfiltered handler in place -- every act line written twice, and every
    dream line leaking into the act log."""
    runner.invoke(cli.app, ["act", "zenith"])
    after_act = _round_log_lines(tmp_cycle, "auto-run.log")
    runner.invoke(cli.app, ["cycle", "zenith"])
    after_cycle = _round_log_lines(tmp_cycle, "auto-run.log")

    added = after_cycle[len(after_act) :]
    posted = [line for line in added if "DONE zenith posted" in line]
    assert len(posted) == 1, added
    assert not any("dreamed" in line for line in added), added


# ── cycle: --resume ───────────────────────────────────────────────────────


def test_cycle_resume_continues_the_interrupted_run_without_re_acting(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--resume` reuses the `thread_id`, and the proof is an EFFECT the
    return value cannot show: the act phase does not run again.

    A `--resume` that recomputed the round id from the clock would build a
    different thread, start a brand-new cycle, and re-post -- passing any
    test that only checks "the second invocation exited 0".

    The interruption is injected at the `write` node, which is past the whole
    act phase and before any dream write, so the checkpoint the resume
    continues from is one where a post has already landed.
    """
    from swil_agent.graph import nodes as nodes_module

    posts: list[FakeResources] = []

    def _recording_resources(persona: Persona, settings: Settings) -> FakeResources:
        resources = FakeResources()
        posts.append(resources)
        return resources

    monkeypatch.setattr(cli, "_resources_for", _recording_resources)

    def _explode(**_kwargs: object) -> object:
        raise _InjectedBugError("interrupted mid-cycle")

    monkeypatch.setattr(nodes_module, "write_step", _explode)
    first = runner.invoke(cli.app, ["cycle", "zenith"])
    assert first.exit_code == 75
    assert len(posts[0].created_posts) == 1

    # `undo()` reverts EVERY patch this shared `monkeypatch` made, the
    # fixture's included -- so the seams have to be reinstalled, not just the
    # exploding write removed. Left un-reinstalled, the second invocation would
    # call the real `load_settings()`, the real `/health` probe and a real
    # `claude` subprocess.
    monkeypatch.undo()
    monkeypatch.setenv("ERA_START", _ERA_START)
    _patch_cycle_seams(monkeypatch, tmp_cycle)
    monkeypatch.setattr(cli, "_resources_for", _recording_resources)

    second = runner.invoke(cli.app, ["cycle", "zenith", "--resume"])

    assert second.exit_code == 0
    # The resumed process re-plans nothing and re-posts nothing: the act
    # phase's nodes are already past in the checkpoint.
    assert posts[1].created_posts == []
    assert len(posts[0].created_posts) == 1


def test_cycle_resume_without_a_previous_cycle_skips_with_a_remedy(tmp_cycle: Path) -> None:
    """No checkpoint means nothing to continue. Reported as a KNOWN,
    remediable setup problem naming the command that creates one -- not as
    `UNEXPECTED EmptyInputError`, which is what langgraph raises if the
    request reaches it."""
    result = runner.invoke(cli.app, ["cycle", "zenith", "--resume"])

    assert result.exit_code == 75
    assert "SKIP zenith" in result.stdout
    assert "no checkpointed cycle to resume" in result.stdout
    assert "UNEXPECTED" not in result.stdout


def test_cycle_resume_and_dry_run_are_mutually_exclusive(tmp_cycle: Path) -> None:
    """A shadow round writes no checkpoint (that is the point), so there can
    never be one of its own to resume. Refused with a reason rather than
    silently resuming some earlier REAL cycle under a `--dry-run` flag the
    dream phase would then not be protected by."""
    runner.invoke(cli.app, ["cycle", "zenith"])  # leaves a real checkpoint behind
    result = runner.invoke(cli.app, ["cycle", "zenith", "--resume", "--dry-run"])

    assert result.exit_code == 75
    assert "mutually exclusive" in result.stdout


def test_cycle_auto_honours_the_dream_cooldown_and_force_does_not(
    tmp_cycle: Path,
) -> None:
    """`--auto` is spelled and defaulted exactly like `swil-agent dream`'s, so
    the CLI has ONE meaning for the flag -- and the operator path
    (`cycle-one.sh`) passes it explicitly.

    Both halves are asserted: without the force half, hard-coding `auto=True`
    survives, and without the `--auto` half, hard-coding `auto=False` does.
    The act phase runs identically either way -- only the dream differs.
    """
    _set_last_dream(tmp_cycle, "zenith", hours_ago=1)

    throttled = runner.invoke(cli.app, ["cycle", "zenith", "--auto"])
    assert throttled.exit_code == 0
    assert "SKIP zenith" in throttled.stdout
    assert "cooldown" in throttled.stdout
    assert not (tmp_cycle / "agents" / "zenith" / "personality.archive.md").exists()

    forced = runner.invoke(cli.app, ["cycle", "zenith"])
    assert forced.exit_code == 0
    assert "dream written" in forced.stdout
    assert (tmp_cycle / "agents" / "zenith" / "personality.archive.md").exists()


def test_cycle_seeds_the_rhythm_roll_from_the_seed_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--seed` makes a shadow round's rhythm verdict reproducible -- the
    roll happens before the LLM is ever called.

    Pinned on the EXACT roll rather than on "two runs with the same seed
    agree": `random.Random(7).randint(1, 100)` is 42 and `random.Random(11)`
    is 58, both fixed forever.
    """
    _write_zenith(tmp_path, personality=ZENITH_PERSONALITY)
    _patch_cycle_seams(monkeypatch, tmp_path)

    seven = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run", "--seed", "7"])
    eleven = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run", "--seed", "11"])

    assert "roll=42/100" in seven.stdout, seven.stdout
    assert "roll=58/100" in eleven.stdout, eleven.stdout


class _WorldContextClock(_real_datetime):
    """A clock far from every date that could be a stale artifact.

    2026-09-27 is neither the frozen `now.md` header (2026-08-19 05:30) nor
    `_FixedClock`'s pair of dates, so a rendered date line carrying it can
    only have come from HERE -- not from a file, not from another fixture,
    and not from a constant somebody left in the renderer.
    """

    @classmethod
    def now(cls, tz: object = None) -> _real_datetime:  # type: ignore[override]
        if tz is None:
            return _real_datetime(2026, 9, 27, 14, 3, 0)
        return _real_datetime(2026, 9, 27, 6, 3, 0, tzinfo=tz)  # type: ignore[arg-type]


def _advancing_clock() -> type[_real_datetime]:
    """A clock where **every reading is a different day**.

    `_WorldContextClock` above returns a constant, which makes a whole class
    of mutation invisible (STANDING-CONSTRAINTS §4): `act` and
    `_cycle_deps_for` deliberately hoist ONE `now` and thread it into the
    world-context render, the follow-topics render and the round itself, and
    with a constant clock a call site that ignored the hoisted value and took
    a fresh `datetime.now()` produced byte-identical output. The comment at
    both call sites claims those blocks "cannot disagree"; nothing measured
    it.

    Each class gets its own counter, so tests do not inherit each other's
    position in the sequence.
    """
    ticks = itertools.count()
    base = _real_datetime(2026, 9, 27, 14, 3, 0)

    class _Advancing(_real_datetime):
        @classmethod
        def now(cls, tz: object = None) -> _real_datetime:  # type: ignore[override]
            reading = base + timedelta(days=next(ticks), minutes=7)
            if tz is None:
                return reading
            return reading.replace(tzinfo=tz)  # type: ignore[arg-type]

    return _Advancing


def _assert_prompt_carries_one_clock_reading(prompt: str) -> None:
    """The three dated lines of a planner prompt describe ONE instant.

    They arrive by three different routes -- `render_now_context`'s header,
    `render_follow_topics_feed`'s title, and `ActContext.today` -- and under
    `_advancing_clock` any route that re-reads the clock lands a different
    DAY, not a different microsecond. The expected value is derived from the
    prompt rather than hardcoded, so this holds wherever in the clock's
    sequence the round happens to start.
    """
    lines = prompt.splitlines()
    stamped = [line for line in lines if line.startswith("**今日日期：** ")]
    assert len(stamped) == 1, prompt
    reading = _real_datetime.strptime(
        stamped[0].removeprefix("**今日日期：** "), "%Y年%m月%d日 %H:%M"
    )
    assert f"# 关联话题动态 ({reading:%Y-%m-%d %H:%M})" in lines, prompt
    assert any(line.startswith(f"- 今天（{reading:%Y-%m-%d}）已发帖次数：") for line in lines), (
        prompt
    )


def test_cycle_feeds_the_planner_a_freshly_rendered_world_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The world context reaches the planner RENDERED, not read off disk.

    Stale `context/now.md` and `context/feed_for_<username>.md` files (which
    nothing writes any more) are planted here and both must be absent from
    the prompt.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(ZENITH_PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "now.md").write_text("NOW-MARKER-9137", encoding="utf-8")
    (tmp_path / "context" / "feed_for_zenith.md").write_text("FEED-MARKER-4471", encoding="utf-8")

    backends: list[ScriptedBackend] = []

    def _recording_backend(persona: Persona, settings: Settings) -> ScriptedBackend:
        backend = _cycle_backend()
        backends.append(backend)
        return backend

    resources = FakeResources()
    # `alpha` is the fixture persona's first `Follow Topics` entry.
    resources.search_results = {"alpha": [_SEARCH_HIT]}

    _patch_cycle_seams(monkeypatch, tmp_path)
    monkeypatch.setattr(cli, "_backend_for", _recording_backend)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(cli, "datetime", _WorldContextClock)

    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])

    assert result.exit_code == 0
    plan_prompt = backends[0].calls[0].user
    assert "NOW-MARKER-9137" not in plan_prompt
    assert "FEED-MARKER-4471" not in plan_prompt
    assert "**今日日期：** 2026年09月27日 14:03" in plan_prompt
    assert "**当前 Agent：** zenith" in plan_prompt.splitlines()
    assert "## #alpha" in plan_prompt
    assert "SEARCH-HIT-2208" in plan_prompt
    assert resources.search_calls == [("alpha", 12), ("beta", 12)]


def test_cycle_dates_every_block_of_the_prompt_from_one_clock_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_cycle_deps_for` hoists ONE `now` and threads it three ways.

    Its own comment says the hoist exists so the world-context block and the
    round cannot disagree, and until this test only the now-context half was
    pinned: the test above uses a CONSTANT clock, so a call site that took a
    fresh `datetime.now()` instead of the hoisted value rendered byte-
    identical text. Under `_advancing_clock` it lands a different day.

    In production the gap is microseconds and matters only across a minute
    boundary -- but "the property the comment asserts" and "the property a
    test measures" were two different things, which is the shape §4 is about.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(ZENITH_PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")

    backends: list[ScriptedBackend] = []

    def _recording_backend(persona: Persona, settings: Settings) -> ScriptedBackend:
        backend = _cycle_backend()
        backends.append(backend)
        return backend

    resources = FakeResources()
    resources.search_results = {"alpha": [_SEARCH_HIT]}

    _patch_cycle_seams(monkeypatch, tmp_path)
    monkeypatch.setattr(cli, "_backend_for", _recording_backend)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(cli, "datetime", _advancing_clock())

    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])

    assert result.exit_code == 0
    _assert_prompt_carries_one_clock_reading(backends[0].calls[0].user)


def test_cycle_writes_no_now_md_of_its_own(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ruling R26: render in memory, write no file.

    `context/now.md` is ONE file carrying a per-account `当前 Agent` line, so
    five parallel `cycle-one.sh` processes raced on it -- which is visibly
    what happened, since the frozen copy named exactly one of the 23. It
    stays a Bash-only artifact so the `SWIL_RUNTIME=bash` rollback keeps
    working, and this pins that Python neither creates it nor overwrites it.
    """
    _write_zenith(tmp_path)
    _patch_cycle_seams(monkeypatch, tmp_path)

    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])

    assert result.exit_code == 0
    assert not (tmp_path / "context" / "now.md").exists()
    assert not (tmp_path / "context" / "feed_for_zenith.md").exists()


def test_cycle_budget_caps_what_the_guardrails_let_through(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--budget` is `apply_guardrails`' action cap, and it reaches the
    guardrail node only by being threaded through `CycleDeps`. Hard-coding
    the default there would silently restore a 5-action round on a canary
    invocation asking for one."""
    three_likes = (
        '{"plan":[{"action":"like","postId":"' + "a" * 24 + '"},'
        '{"action":"like","postId":"' + "b" * 24 + '"},'
        '{"action":"like","postId":"' + "c" * 24 + '"}]}'
    )
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: ScriptedBackend(three_likes, DREAM_REPLY),
    )

    capped = runner.invoke(cli.app, ["cycle", "zenith", "--budget", "1"])
    assert capped.exit_code == 0
    assert "landed=1/1" in capped.stdout, capped.stdout


def test_cycle_carries_the_unsplash_key_down_to_the_executor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`access_key` is a CREDENTIAL, so it comes from the composition root
    rather than being resolved deeper down -- which means the only thing
    stopping every image post from silently degrading to text-only is this
    one argument being threaded.

    `execute_action`'s image fetcher is a DEFAULT parameter bound at
    definition time, so it cannot be swapped through `execute_step`; the spy
    goes on `act/round.py`'s module global instead (standing constraint §6 --
    `execute_step` resolves that name at call time).
    """
    from swil_agent.act import round as act_round
    from swil_agent.models import ActionResult

    _write_zenith(tmp_path)
    _patch_cycle_seams(monkeypatch, tmp_path)
    monkeypatch.setattr(
        cli,
        "load_settings",
        lambda: Settings(agent_root=tmp_path, unsplash_access_key="KEY-4471", post_probability=100),
    )

    seen: list[str] = []

    def _spy(resources: object, action: object, **kwargs: object) -> ActionResult:
        seen.append(str(kwargs["access_key"]))
        return ActionResult(action=action, landed=True, resource_id="p" * 24)  # type: ignore[arg-type]

    monkeypatch.setattr(act_round, "execute_action", _spy)
    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 0
    assert seen == ["KEY-4471"]


def test_cycle_reports_a_partial_round_as_landed_over_attempted(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`landed=N/M` is what a post-round QA pass greps, and every other cycle
    test here lands everything it attempts -- so the two numbers coincide and
    a report that swapped them reads identically.

    Two likes, both failing at the wire: `landed=0/2`, which a swap turns into
    the impossible `landed=2/0`.
    """
    two_likes = (
        '{"plan":[{"action":"like","postId":"'
        + "a" * 24
        + '"},{"action":"like","postId":"'
        + "b" * 24
        + '"}]}'
    )
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: ScriptedBackend(two_likes, DREAM_REPLY),
    )
    monkeypatch.setattr(
        cli,
        "_resources_for",
        lambda persona, settings: FakeResources(like_raises=ApiError(500, "boom", None)),
    )

    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 0
    assert "landed=0/2" in result.stdout, result.stdout


# ── cycle: the two reporting projections ──────────────────────────────────


def test_the_dream_report_follows_the_write() -> None:
    """`accepted` answers "did `personality.md` actually change", which is
    `written` -- a claim about the FILE -- never `proceeded` or the presence
    of a parsed list. The write node's dry-run guard returns `written=False`
    with a list in hand, and a refused write does the same."""
    state = {
        "proceeded": True,
        "recent": ["一件新事"],
        "written": False,
        "dream_reason": "file too large",
    }
    result = cli._dream_result_of(state)  # type: ignore[arg-type]
    assert result.accepted is False
    assert result.reason == "file too large"
    assert result.recent == ["一件新事"]


def test_a_cycle_with_no_outcome_yet_is_not_reported_as_a_failed_round() -> None:
    """`run_cycle` returns the ACCUMULATED state, and a resumed thread with
    nothing left to run carries whatever the interrupted run had already
    recorded -- which may be nothing at all. Treating "not decided" as
    "denied" would exit 75 on a cycle that simply had no work left, and
    `cycle-one.sh` reads that as "the act did not land"."""
    from swil_agent.models import ActOutcome

    assert cli._cycle_granted_dream({}) is True
    assert cli._cycle_granted_dream({"outcome": ActOutcome.OFFLINE}) is False
    assert cli._cycle_granted_dream({"outcome": ActOutcome.LANDED_PARTIAL}) is True
    assert cli._act_result_of({}) is None


def test_cycle_dry_run_never_starts_or_probes_the_embedder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A shadow round is routed away from the dream phase, so it needs no
    vectors.

    Two costs, both real. `EmbedderGuard.up()` shells out to
    `embedder-guard.sh`, which writes `.agent-state/embedder_guard/*` and
    `logs/embedder.log` and `nohup`s the bge-m3 daemon (up to 150s of startup)
    if nothing is serving -- during a round that is supposed to write
    nothing. And the post-`up()` health probe logs ONE ERROR per invocation
    into `dream.log`, about dreams that never happen.

    The guard is a REAL `_FakeGuard` here rather than the fixture's, so
    "never started" is observed rather than assumed -- `_patch_cycle_seams`
    fakes `_guard_for` away, which is why nothing caught this.
    """
    _write_zenith(tmp_path)
    _patch_cycle_seams(monkeypatch, tmp_path)
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient(healthy=False))

    with caplog.at_level("ERROR"):
        result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])

    assert result.exit_code == 0
    assert guard.up_calls == 0
    assert guard.down_calls == 0
    assert [record for record in caplog.records if record.levelname == "ERROR"] == []


def test_a_real_cycle_still_brackets_the_embedder_guard(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The complement: a non-dry cycle DOES reach the dream phase, so it
    keeps the `up`/`down` bracket exactly once each. Without this,
    skipping the guard unconditionally passes the dry-run test above."""
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 0
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_cycle_with_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `cycle` sibling of `act`'s and `dream`'s own version. Two `try`
    blocks, not one, so exit 66 can only ever mean "this account directory
    does not exist": a personality.md that EXISTS but will not parse is a
    setup problem (75, with the frontmatter named), not a missing account."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))

    result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 75
    assert "frontmatter" in result.stdout
    assert "Traceback" not in result.stdout


def test_a_round_log_that_cannot_be_opened_does_not_kill_the_round(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A round must not die because a log file could not be opened.

    `agent/logs` is a FILE here, so `path.parent.mkdir` raises `NotADirectory
    Error` (an `OSError`) for BOTH of the cycle's two handlers. The command
    still runs and still exits 0; all that is lost is the file mirror.
    """
    _write_zenith(tmp_path)
    (tmp_path / "logs").write_text("not a directory\n", encoding="utf-8")
    _patch_cycle_seams(monkeypatch, tmp_path)

    with caplog.at_level("WARNING"):
        result = runner.invoke(cli.app, ["cycle", "zenith"])

    assert result.exit_code == 0
    assert sum("could not open" in record.getMessage() for record in caplog.records) == 2


def test_cycle_writes_its_two_databases_into_the_agent_state_directory(
    tmp_cycle: Path,
) -> None:
    """One directory for the Python runtime's local per-account state, next to
    `lock_<name>` and the dream cooldown markers -- the same place
    `FilesystemDreamState` already uses. A second top-level directory per
    feature is how `.agent-state` stops being the one place to look during an
    incident."""
    result = runner.invoke(cli.app, ["cycle", "zenith"])
    assert result.exit_code == 0
    assert (tmp_cycle / ".agent-state" / cli.CHECKPOINT_DB_NAME).is_file()
    assert (tmp_cycle / ".agent-state" / cli.LEASE_DB_NAME).is_file()


# ── version ──────────────────────────────────────────────────────────────


def test_version_prints_the_package_version() -> None:
    from swil_agent import __version__

    result = runner.invoke(cli.app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


# ── composition helpers, exercised directly (not only via a monkeypatch) ──


def test_resources_for_prefers_the_api_key_and_never_logs_in(tmp_path: Path) -> None:
    from swil_agent.persona.loader import load_persona

    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("secret-key\n", encoding="utf-8")
    persona = load_persona(directory)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        raise AssertionError(f"unexpected request to {request.url.path}")

    resources = cli._resources_for(persona, settings, transport=httpx.MockTransport(handler))
    assert seen_paths == []  # no login call for a bearer-token account
    assert resources is not None


def test_resources_for_logs_in_when_falling_back_to_password_auth(tmp_path: Path) -> None:
    from swil_agent.persona.loader import load_persona

    directory = _write_zenith(tmp_path)  # no api_key.txt written
    persona = load_persona(directory)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="hunter2")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/login"
        return httpx.Response(200, json={"data": {}}, headers={"set-cookie": "sid=abc123; Path=/"})

    cli._resources_for(persona, settings, transport=httpx.MockTransport(handler))


def test_health_check_true_on_200(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is True


def test_health_check_false_on_non_200(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is False


def test_health_check_false_on_transport_error(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is False


def test_act_plans_against_todays_date_not_a_file_on_disk(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `act` command's own half of the fix -- `cycle` is pinned above.

    The two commands compose the world context independently (`run_act`'s
    call site and `_cycle_deps_for`), so fixing one and not the other is a
    live possibility: `swil-agent act` is what `heartbeat.sh` reaches, and it
    would have gone on planning against 2026-08-19 while `cycle` was fresh.

    Replaces two tests that asserted the OLD behaviour: that `_context_now_for`
    read `context/now.md`, and that it degraded to `"(no context file)"` when
    that file was absent. Both are now wrong by design -- there is no file to
    read and nothing to be absent -- and the renderers' own degradation is
    pinned in `test_world_context.py`.
    """
    (tmp_agent / "context").mkdir()
    (tmp_agent / "context" / "now.md").write_text("NOW-MARKER-5510", encoding="utf-8")
    backend = StubBackend(_POST_PLAN)
    built: list[Persona] = []

    def _counting_resources(persona: Persona, settings: Settings) -> FakeResources:
        built.append(persona)
        return resources

    resources = FakeResources()
    resources.search_results = {"alpha": [_SEARCH_HIT]}
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: backend)
    monkeypatch.setattr(cli, "_resources_for", _counting_resources)
    monkeypatch.setattr(cli, "datetime", _WorldContextClock)

    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])

    assert result.exit_code == 0
    assert backend.last is not None
    assert "NOW-MARKER-5510" not in backend.last.user
    assert "**今日日期：** 2026年09月27日 14:03" in backend.last.user
    assert "**当前 Agent：** zenith" in backend.last.user.splitlines()
    # The follow-topics block reaches THIS command's prompt too. `act` and
    # `cycle` compose the world context independently, so a fix applied to
    # one and not the other is a live possibility -- and it would be silent.
    assert "## #alpha" in backend.last.user
    assert "SEARCH-HIT-2208" in backend.last.user
    assert resources.search_calls == [("alpha", 12), ("beta", 12)]
    assert not (tmp_agent / "context" / "feed_for_zenith.md").exists()
    # ONE `Resources` for the whole round. The world-context render happens
    # beside `run_act`'s own arguments, so building a second one there is the
    # available mistake -- and for an account on the `SWIL_PASS` fallback it
    # would mean a second `POST /auth/login` per round, silently, 23 times.
    assert len(built) == 1


def test_act_dates_every_block_of_the_prompt_from_one_clock_reading(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`act`'s half of the same hoist, and the same undefended half.

    The test above pins the now-context date against a CONSTANT clock, which
    cannot distinguish the hoisted `now` from a fresh `datetime.now()` --
    `_feed_context_for(..., now=datetime.now())` survived the whole suite.
    Under `_advancing_clock` the follow-topics title and the round's own
    post-count line drift a day away from the header the moment either one
    re-reads the clock.
    """
    backend = StubBackend(_POST_PLAN)
    resources = FakeResources()
    resources.search_results = {"alpha": [_SEARCH_HIT]}
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: backend)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)
    monkeypatch.setattr(cli, "datetime", _advancing_clock())

    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])

    assert result.exit_code == 0
    assert backend.last is not None
    _assert_prompt_carries_one_clock_reading(backend.last.user)


def test_persona_source_for_returns_a_working_git_persona_source(tmp_path: Path) -> None:
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)
    source = cli._persona_source_for(settings)
    assert isinstance(source, GitPersonaSource)
    assert source.load("zenith").username == "zenith"


def test_backend_for_builds_the_claude_backend_for_a_claude_persona(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path)
    persona = make_persona(username="zenith", directory=tmp_path, backend="claude")
    backend = cli._backend_for(persona, settings)
    assert backend.name == "claude"


def test_embedder_for_builds_a_real_embedder_client(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, embedder_url="http://127.0.0.1:7777")
    embedder = cli._embedder_for(settings)
    assert isinstance(embedder, EmbedderClient)


def test_guard_for_builds_a_real_embedder_guard(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path)
    guard = cli._guard_for(settings)
    assert isinstance(guard, EmbedderGuard)


# ── analysis / QA commands ───────────────────────────────────────────────
#
# All are observability, so the interesting assertions are about what does
# NOT change the exit code: "a measurement outage exits 0, a setup failure
# exits 75, and only a missing account exits 66".

_TAGGED_POST = {"id": "p1", "text": "写完了 #alpha #beta"}

# The loader requires the directory name to match `username`, so the
# sampler account is the fixture's own `agents/zenith`.
_SAMPLER_DIR = "zenith"


def _write_sampler_account(tmp_agent: Path, *, personality: str = ZENITH_PERSONALITY) -> Path:
    directory = tmp_agent / "agents" / _SAMPLER_DIR
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    return directory


def _key(directory: Path, value: str = "k-secret\n") -> Path:
    (directory / "api_key.txt").write_text(value, encoding="utf-8")
    return directory


class _FixedClock(_real_datetime):
    """A clock whose LOCAL and UTC answers are on different DATES.

    `now()` is 2026-08-19 23:30 local; `now(UTC)` is 2026-08-20 06:30. Every
    caller in `cli.py` picks one deliberately -- `summary`'s default date is
    local (`agent-summary.sh:18`), `behavior-snapshot`'s `capturedAt` is UTC
    (`date -u`) -- and a stub where the two coincide makes both choices
    unfalsifiable.
    """

    @classmethod
    def now(cls, tz: object = None) -> _real_datetime:  # type: ignore[override]
        if tz is None:
            return _real_datetime(2026, 8, 19, 23, 30, 0)
        return _real_datetime(2026, 8, 20, 6, 30, 0, tzinfo=tz)  # type: ignore[arg-type]


def _sampling_resources(monkeypatch: pytest.MonkeyPatch, **kwargs: object) -> FakeResources:
    """One CAPTURED `FakeResources`, not a fresh one per call.

    `tmp_agent` installs `lambda persona, settings: FakeResources()`, which
    builds a new instance every time -- so a test asserting on what reached
    the wire would be inspecting an object the command never used.
    """
    resources = FakeResources(**kwargs)  # type: ignore[arg-type]
    resources.user_post_items = [dict(_TAGGED_POST)]
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)
    return resources


def test_behavior_snapshot_ships_the_vector_and_exits_0(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _key(_write_sampler_account(tmp_agent))
    resources = _sampling_resources(monkeypatch)

    result = runner.invoke(cli.app, ["behavior-snapshot", _SAMPLER_DIR])

    assert result.exit_code == 0
    assert "ok id=behavior-1" in result.stdout
    # Fetched and filed under the username. The window is 7
    # (`behavior_post_limit`), not the default 12.
    assert resources.user_posts_calls == [("zenith", 7)]
    assert len(resources.behavior_snapshots) == 1
    username, payload = resources.behavior_snapshots[0]
    assert username == "zenith"
    assert payload["postCount"] == 1
    # The BEHAVIOR endpoint, not the personality one -- two different bodies
    # and two different meanings of "snapshot".
    assert resources.snapshots == []


def test_behavior_snapshot_honours_an_explicit_limit(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--limit` overrides `BEHAVIOR_POST_LIMIT`. 4 is neither the Bash
    default (12) nor `Resources.user_posts`' own."""
    _key(_write_sampler_account(tmp_agent))
    resources = _sampling_resources(monkeypatch)

    result = runner.invoke(cli.app, ["behavior-snapshot", _SAMPLER_DIR, "--limit", "4"])

    assert result.exit_code == 0
    assert resources.user_posts_calls == [("zenith", 4)]


def test_behavior_snapshot_with_a_dead_embedder_fails_open_and_exits_0(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`jq -e '.embeddings[0] | length > 0'` failing is `exit 0` in
    `behavior-snapshot.sh:85-88`. The daemon being down must not turn every
    account's round into a failure -- that is the 2026-08-13 embedder-OOM
    incident's blast radius, and the reason this path is fail-open."""
    _key(tmp_agent / "agents" / "zenith")
    resources = _sampling_resources(monkeypatch)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient(healthy=False))

    class _DeadEmbedder(_FakeEmbedderClient):
        def embed(self, texts: list[str]) -> list[list[float]]:
            raise EmbedderUnavailable("connection refused")

    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _DeadEmbedder())

    result = runner.invoke(cli.app, ["behavior-snapshot", "zenith"])

    assert result.exit_code == 0
    assert "skipped (embedder unreachable)" in result.stdout
    assert resources.behavior_snapshots == []


def test_behavior_snapshot_does_not_start_the_embedder_daemon(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real difference from `dream`: the standalone sampler does not
    bracket the embedder guard, so it samples nothing whenever the daemon
    happens to be down. Said out loud so nobody reads the no-op as a bug."""
    _key(tmp_agent / "agents" / "zenith")
    _sampling_resources(monkeypatch)
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["behavior-snapshot", "zenith"])

    assert result.exit_code == 0
    assert (guard.up_calls, guard.down_calls) == (0, 0)


def test_behavior_snapshot_without_an_api_key_exits_0(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = _sampling_resources(monkeypatch)

    result = runner.invoke(cli.app, ["behavior-snapshot", "zenith"])

    assert result.exit_code == 0
    assert "skipped (no api_key.txt)" in result.stdout
    assert resources.behavior_snapshots == []


def test_behavior_snapshot_on_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["behavior-snapshot", "nosuchagent"])
    assert result.exit_code == 66


# ── intervention ──────────────────────────────────────────────────────────

# A second account, distinct from the `tmp_agent` fixture's own `zenith`, so
# a command that filed the event under the wrong account is visible. The
# loader requires the directory name to match `username`.
INTERVENTION_DIR = "shujupai"
INTERVENTION_USERNAME = "shujupai"


def _write_intervention_account(root: Path) -> Path:
    directory = root / "agents" / INTERVENTION_DIR
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(_personality(INTERVENTION_USERNAME), encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    return directory


@pytest.fixture
def tmp_intervention_agent(tmp_agent: Path) -> Path:
    """`tmp_agent` plus a second account, `shujupai`."""
    _write_intervention_account(tmp_agent)
    return tmp_agent


@pytest.fixture
def pin_local_zone() -> Iterator[Callable[[str], None]]:
    """Pin the PROCESS's local zone, and put it back afterwards.

    `_intervention_instant` resolves a bare stamp with `datetime.astimezone()`,
    which reads the process's local zone -- so a test that builds its own
    expectation the same way is *identical to the mutant* wherever local is
    UTC. That is exactly what `ubuntu-latest` gives the `python` job
    (`.github/workflows/ci.yml`), so the guard was defended on a PDT laptop
    and undefended on every CI run. Pinning the zone here makes the expected
    instant a constant that differs from the "read it as UTC" mutant on any
    machine.

    `time.tzset()` is what makes `TZ` take effect, and it has to run again on
    teardown or every later test in this process inherits the pinned zone.
    """
    previous = os.environ.get("TZ")

    def pin(zone: str) -> None:
        os.environ["TZ"] = zone
        time.tzset()

    try:
        yield pin
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


# Built from a dict rather than sliced out of a positional list: every one of
# these tests varies exactly one option, and index arithmetic over a flat
# argv is how a test silently drops the flag NEXT to the one it meant to
# change and then passes for the wrong reason.
_INTERVENTION_DEFAULTS = {
    "--kind": "personality_rollback",
    "--at": "2026-08-05T01:35:04-07:00",
    "--summary": "hand rollback",
    "--evidence": "personality.archive.md header",
    "--dated-from": "archive-header",
}


def _intervention_args(
    account: str = INTERVENTION_DIR, *flags: str, **overrides: str | None
) -> list[str]:
    options = dict(_INTERVENTION_DEFAULTS)
    for key, value in overrides.items():
        flag = "--" + key.replace("_", "-")
        if value is None:
            options.pop(flag, None)
        else:
            options[flag] = value
    argv = ["intervention", account]
    for flag, value in options.items():
        argv += [flag, value]
    return argv + list(flags)


def _intervention_resources(monkeypatch: pytest.MonkeyPatch, **kwargs: object) -> FakeResources:
    resources = FakeResources(**kwargs)  # type: ignore[arg-type]
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: resources)
    return resources


def _sent_interventions(resources: FakeResources) -> list[tuple[str, dict[str, object]]]:
    return [(username, event.to_wire()) for username, event in resources.interventions]


# One case per `InterventionKind`, and the three derived `metrics` values are
# spelled out rather than looked up from `ARTIFACT_BY_KIND` /
# `GATE_BYPASSED_BY_KIND` -- importing the table the code uses would make this
# assert that the code agrees with itself.
_INTERVENTION_KINDS = [
    ("personality_rollback", "personality.md", True),
    ("personality_edit", "personality.md", True),
    ("memory_edit", "memory.md", False),
    ("other", "", False),
]

# Distinct from every default above, from each other, and from what the
# command could plausibly have passed instead. 08:34:18 -07:00 is 15:34:18
# UTC; 04:39:56 -07:00 is 11:39:56 UTC -- so an offset silently dropped is a
# different number, and `windowStartsAt` echoing `occurredAt` is visible.
_AT = "2026-08-17T08:34:18-07:00"
_AT_ON_THE_WIRE = "2026-08-17T15:34:18+00:00"
_WINDOW_START = "2026-07-25T04:39:56-07:00"
_WINDOW_START_ON_THE_WIRE = "2026-07-25T11:39:56+00:00"
_SUMMARY = "lvchuang personality.md rewritten out of band"
_EVIDENCE = "commit 3e636bc (+26/-20), no archive entry"
_REASON = "attribution unresolved: a hand edit or the Write-tool hole"


@pytest.mark.parametrize(("kind", "artifact", "gate_bypassed"), _INTERVENTION_KINDS)
def test_intervention_puts_every_option_on_the_wire(
    tmp_intervention_agent: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
    artifact: str,
    gate_bypassed: bool,
) -> None:
    """The WHOLE outgoing payload, not one field of it.

    `intervention` is threading code, and for threading code the argument IS
    the behaviour (standing constraint §2): every one of its seven options,
    plus the username derived from the positional folder, has to arrive on
    the wire carrying the operator's value. Asserting the complete body --
    against a fixture where no two of those values coincide -- closes the
    class "a field was never checked", where one assertion per field only
    closes the instances somebody thought to enumerate.

    Parametrised over the closed kind set because `--kind` drives three
    derived `metrics` values, `gateBypassed` among them -- the single most
    load-bearing fact for anyone reading the drift series, and the one a
    hardcoded kind would assert for an intervention that never touched
    `personality.md`.
    """
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(
        cli.app,
        _intervention_args(
            kind=kind,
            at=_AT,
            summary=_SUMMARY,
            evidence=_EVIDENCE,
            dated_from="commit",
            reason=_REASON,
            window_start=_WINDOW_START,
        ),
    )

    assert result.exit_code == 0
    # The pre-write echo carries `kind` too, and it is the operator's last
    # chance to catch a wrong one before the write. Asserted HERE rather than
    # beside the timestamp test because only this test sweeps the whole kind
    # set: against a single-kind test, hardcoding the echo's kind to that same
    # value is an equivalent mutation and cannot be killed.
    assert f"-- @{INTERVENTION_USERNAME} {kind} at " in result.stdout
    assert _sent_interventions(resources) == [
        (
            INTERVENTION_USERNAME,
            {
                "type": "anomaly",
                "phase": "anomaly",
                "outcome": "flagged",
                "summary": _SUMMARY,
                "reason": _REASON,
                "occurredAt": _AT_ON_THE_WIRE,
                "metrics": {
                    "intervention": kind,
                    "artifact": artifact,
                    "gateBypassed": gate_bypassed,
                    "datedFrom": "commit",
                    "evidence": _EVIDENCE,
                    "windowStartsAt": _WINDOW_START_ON_THE_WIRE,
                },
            },
        )
    ]


def test_intervention_omits_the_two_optional_fields_when_neither_is_given(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same whole-payload assertion with only the required options.

    `reason` and `windowStartsAt` must be ABSENT, not present-and-empty:
    `/lab` counts keys, and "we know when" has to stay distinguishable from
    "we know only within a range".
    """
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args())

    assert result.exit_code == 0
    assert _sent_interventions(resources) == [
        (
            INTERVENTION_USERNAME,
            {
                "type": "anomaly",
                "phase": "anomaly",
                "outcome": "flagged",
                "summary": "hand rollback",
                # 01:35:04 -07:00 is 08:35:04 UTC.
                "occurredAt": "2026-08-05T08:35:04+00:00",
                "metrics": {
                    "intervention": "personality_rollback",
                    "artifact": "personality.md",
                    "gateBypassed": True,
                    "datedFrom": "archive-header",
                    "evidence": "personality.archive.md header",
                },
            },
        )
    ]


def test_intervention_records_the_event_against_the_username_bullet(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`POST /agents/{username}/events` requires the actor to BE that account,
    so the persona's username decides where the record lands. The fixture's
    other account (`zenith`) must not receive it."""
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args())

    assert result.exit_code == 0
    assert "recorded id=evt-1" in result.stdout
    assert [username for username, _ in resources.interventions] == [INTERVENTION_USERNAME]
    assert resources.calls == ["record_intervention"]


def test_intervention_sends_the_instant_it_is_about_not_now(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of the command. 01:35:04 PDT is 08:35:04 UTC -- an
    offset silently dropped would be a different number, and `now()` would be
    a different day."""
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args())

    assert result.exit_code == 0
    wire = resources.interventions[0][1].to_wire()
    assert wire["occurredAt"] == "2026-08-05T08:35:04+00:00"
    assert wire["type"] == "anomaly"
    assert wire["metrics"]["gateBypassed"] is True


@pytest.mark.parametrize(
    ("zone", "expected", "local"),
    [
        # 01:35:04 in a -07:00 zone is 08:35:04 UTC; in a +08:00 zone it is
        # 17:35:04 UTC the PREVIOUS day. Two zones with opposite-signed
        # offsets, so a resolution that ignored the local zone -- or that
        # hardcoded one offset -- fails at least one row on every machine.
        ("America/Los_Angeles", "2026-08-05T08:35:04+00:00", "2026-08-05T01:35:04-07:00"),
        ("Asia/Shanghai", "2026-08-04T17:35:04+00:00", "2026-08-05T01:35:04+08:00"),
    ],
)
def test_intervention_resolves_a_bare_local_timestamp_and_echoes_it(
    tmp_intervention_agent: Path,
    monkeypatch: pytest.MonkeyPatch,
    pin_local_zone: Callable[[str], None],
    zone: str,
    expected: str,
    local: str,
) -> None:
    """Every source an operator copies from is written in LOCAL time --
    `dream.sh`'s archive header, `memory.md`'s note lines, `git log`'s default
    -- so a bare stamp is resolved as local rather than as UTC.

    The resolved instant is echoed BEFORE the write, because a timestamp that
    parsed successfully into the wrong instant is the one 2am mistake nothing
    else can catch.

    The zone is PINNED rather than inherited. Deriving the expectation from
    this machine's own zone (`datetime(...).astimezone(UTC)`) is portable but
    vacuous: wherever local is UTC -- which is what CI runs on -- it computes
    exactly what a "read a bare stamp as UTC" regression would, so the guard
    was green on the laptop and unguarded in CI.
    """
    pin_local_zone(zone)
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(at="2026-08-05 01:35:04"))

    assert result.exit_code == 0
    assert resources.interventions[0][1].to_wire()["occurredAt"] == expected
    # The WHOLE line, not a fragment of it. Asserting only `wire {expected}`
    # pinned the UTC half and left the other three fields free: the username,
    # the kind, and -- the sharp one -- the LOCAL half, which is the half the
    # operator actually compares against the archive header they copied from.
    # A regression that echoed UTC in both positions would have looked correct
    # to the substring check and silently removed the only cross-check there is.
    assert (
        f"intervention {INTERVENTION_DIR} -- @{INTERVENTION_USERNAME} personality_rollback "
        f"at {local} (wire {expected})"
    ) in result.stdout


def test_intervention_dry_run_sends_nothing_and_prints_the_wire_body(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(INTERVENTION_DIR, "--dry-run"))

    assert result.exit_code == 0
    assert resources.interventions == []
    assert "dry run, nothing sent" in result.stdout
    assert "'type': 'anomaly'" in result.stdout


def test_intervention_refuses_a_future_instant_and_exits_75(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """There is no legitimate future intervention, and the typo that produces
    one (a year or a month off) otherwise files a marker that sorts to the top
    of every timeline forever."""
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(at="2099-01-01"))

    assert result.exit_code == 75
    assert "future instant" in result.stdout + result.stderr
    assert resources.interventions == []


def test_intervention_refuses_an_unparseable_timestamp_and_exits_75(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(at="yesterday"))

    assert result.exit_code == 75
    assert "--at" in result.stdout + result.stderr
    assert resources.interventions == []


def test_intervention_refuses_a_window_that_runs_backwards(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--window-start` is the EARLIEST possible instant for a bounded date.
    One later than `--at` is a transposition, and it would publish a window
    that cannot contain the event it bounds."""
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(window_start="2026-08-06T00:00:00-07:00"))

    assert result.exit_code == 75
    assert "backwards" in result.stdout + result.stderr
    assert resources.interventions == []


def test_intervention_records_a_window_when_the_date_is_only_a_bound(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A commit date is an UPPER bound on an edit made at some unknown earlier
    moment, so the marker carries the range as well as the instant -- and the
    two are different values, which is what makes an implementation that
    echoed `occurredAt` into `windowStartsAt` visible."""
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(
        cli.app,
        _intervention_args(at=_AT, dated_from="commit", window_start=_WINDOW_START),
    )

    assert result.exit_code == 0
    metrics = resources.interventions[0][1].to_wire()["metrics"]
    assert metrics["windowStartsAt"] == _WINDOW_START_ON_THE_WIRE
    assert metrics["datedFrom"] == "commit"


def test_intervention_refuses_an_over_length_summary_before_the_wire(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resources = _intervention_resources(monkeypatch)

    result = runner.invoke(cli.app, _intervention_args(summary="x" * 501))

    assert result.exit_code == 75
    assert "500" in result.stdout + result.stderr
    assert resources.interventions == []


def test_intervention_exits_75_when_the_server_rejects_it(
    tmp_intervention_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The failure `Resources.lab_event` would have swallowed. A 403 is the
    realistic one -- the server requires the actor to BE that account -- and a
    fire-and-forget write would have printed a success line."""
    resources = _intervention_resources(
        monkeypatch, intervention_raises=ApiError(403, "forbidden", None)
    )

    result = runner.invoke(cli.app, _intervention_args())

    assert result.exit_code == 75
    output = result.stdout + result.stderr
    assert "server rejected" in output
    assert "forbidden" in output
    assert resources.calls == ["record_intervention"]


def test_intervention_on_an_unknown_account_exits_66(tmp_intervention_agent: Path) -> None:
    result = runner.invoke(cli.app, _intervention_args("nosuchagent"))
    assert result.exit_code == 66


def test_intervention_rejects_a_kind_outside_the_closed_set(tmp_intervention_agent: Path) -> None:
    """A closed enum, because an open one is how a series gets annotated with
    a label nobody can query for later. Typer rejects it at parse time (exit
    2), before any account or credential is touched."""
    result = runner.invoke(cli.app, _intervention_args(kind="vibes"))
    assert result.exit_code == 2


@pytest.mark.parametrize("missing", ["at", "summary", "evidence", "dated_from"])
def test_intervention_requires_every_option_that_makes_the_record_readable(
    tmp_intervention_agent: Path, missing: str
) -> None:
    """None of the four has a default, and each absent default is a failure
    that has already happened: an `--at` defaulting to now would file the
    marker at the far end of the series from the stretch it annotates, and a
    record with no `--evidence` or no `--dated-from` cannot be checked or
    weighted by anyone reading it later."""
    result = runner.invoke(cli.app, _intervention_args(**{missing: None}))
    assert result.exit_code == 2


def test_intervention_without_any_credential_exits_75_with_a_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ "A missing `api_key.txt` fails silently with a curl" is one of the
    three reasons this command exists, and nothing named that failure at this
    call site -- it was carried entirely by inherited helper behaviour.

    The precondition is NOT "no `api_key.txt`". It is no `api_key.txt` **and**
    no usable `SWIL_PASS`: `_resources_for` falls back to `PasswordAuth` when
    only the key is missing (see the sibling test below), so a test that wrote
    no key but left a password set would be measuring the wrong branch.
    `_resources_for` runs for REAL here -- this is the one exception in the
    intervention block, which monkeypatches it away everywhere else.
    """
    _write_intervention_account(tmp_path)  # no api_key.txt, and swil_pass is None
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))

    result = runner.invoke(cli.app, _intervention_args())

    output = result.stdout + result.stderr
    assert result.exit_code == 75
    assert f"SKIP {INTERVENTION_DIR}" in output
    assert INTERVENTION_USERNAME in output
    assert "register" in output
    assert "SWIL_PASS" in output
    assert "Traceback" not in output


def test_intervention_with_a_password_and_no_api_key_still_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of the precondition above, over a real `ApiClient`.

    A missing key alone is not a failure, and this is also the only pin on
    the username reaching the ROUTE rather than a fake's argument list: the
    POST has to land on `/agents/shujupai/events`, never on the folder name.
    """
    _write_intervention_account(tmp_path)  # no api_key.txt -- PasswordAuth takes over
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="hunter2")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    build_resources = cli._resources_for  # captured before the monkeypatch below
    posted: list[tuple[str, object]] = []
    logins: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            logins.append(request.url.path)
            return httpx.Response(
                200, json={"data": {}}, headers={"set-cookie": "sid=abc123; Path=/"}
            )
        posted.append((request.url.path, json.loads(request.content)))
        return httpx.Response(201, json={"data": {"event": {"id": "evt-9"}}})

    monkeypatch.setattr(
        cli,
        "_resources_for",
        lambda persona, settings: build_resources(
            persona, settings, transport=httpx.MockTransport(handler)
        ),
    )

    result = runner.invoke(cli.app, _intervention_args())

    assert result.exit_code == 0
    assert "recorded id=evt-9" in result.stdout
    # The cookie fallback is empty until `login()` runs, so a builder that
    # skipped it would 401 every write on this path in production while a
    # handler that ignores auth stayed green.
    assert logins == ["/api/v1/auth/login"]
    assert [path for path, _ in posted] == [f"/api/v1/agents/{INTERVENTION_USERNAME}/events"]


def _metric_resources(monkeypatch: pytest.MonkeyPatch, **kwargs: object) -> FakeResources:
    resources = FakeResources(**kwargs)  # type: ignore[arg-type]
    monkeypatch.setattr(cli, "_resources_for_key", lambda directory, settings: resources)
    return resources


def test_population_metric_reports_the_sample_and_exits_0(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _key(tmp_agent / "agents" / "zenith")
    resources = _metric_resources(monkeypatch)

    result = runner.invoke(cli.app, ["population-metric", "zenith"])

    assert result.exit_code == 0
    assert "personaCohesion=0.71" in result.stdout
    assert "n=23" in result.stdout
    assert resources.calls == ["record_population_metric"]


def test_population_metric_without_a_name_uses_the_first_keyed_account(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The route is global, so the argument picks a CREDENTIAL, not a
    subject. Only `agents/` is searched: a leftover keyed `humans/aardvark`
    (which sorts first) must never be picked."""
    _key(tmp_agent / "agents" / "zenith")
    human = tmp_agent / "humans" / "aardvark"
    human.mkdir(parents=True)
    _key(human)
    chosen: list[str] = []
    monkeypatch.setattr(
        cli,
        "_resources_for_key",
        lambda directory, settings: chosen.append(directory.name) or FakeResources(),
    )

    result = runner.invoke(cli.app, ["population-metric"])

    assert result.exit_code == 0
    assert chosen == ["zenith"]


def test_population_metric_on_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    """`population-metric.sh` exits 1 for BOTH "no such account" and "that
    account has no key" -- it only ever tests `-f .../api_key.txt`. The two
    have different fixes, so this CLI separates them."""
    result = runner.invoke(cli.app, ["population-metric", "nosuchagent"])
    assert result.exit_code == 66


def test_population_metric_on_a_keyless_account_exits_75_with_a_remedy(
    tmp_agent: Path,
) -> None:
    result = runner.invoke(cli.app, ["population-metric", "zenith"])
    assert result.exit_code == 75
    assert "register" in result.stdout


def test_an_empty_name_is_a_name_not_an_absent_one(tmp_agent: Path) -> None:
    """`$# -ge 1` in bash: `population-metric ""` looks for
    `agents//api_key.txt` and finds nothing. Falling through to the scan
    instead would authenticate as an arbitrary account -- silently, and with
    a key the caller did not choose."""
    _key(tmp_agent / "agents" / "zenith")
    result = runner.invoke(cli.app, ["population-metric", ""])
    assert result.exit_code == 66


def test_population_metric_reports_a_server_rejection_as_75(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bash exits 1 here (`population-metric.sh:69-70`). Nothing was
    recorded, so this CLI's equivalent is 75 -- and it is NOT 0, because
    unlike the two cycle-wired samplers this command is a standalone daily
    job whose whole output is the sample."""
    _key(tmp_agent / "agents" / "zenith")
    _metric_resources(monkeypatch, population_metric_raises=ApiError(503, "unavailable", None))

    result = runner.invoke(cli.app, ["population-metric", "zenith"])

    assert result.exit_code == 75
    assert "server rejected" in result.stdout + result.stderr


def test_resources_for_key_names_a_blank_api_key_file(tmp_path: Path) -> None:
    """Spec §15.1 row 3: a present-but-BLANK `api_key.txt` raises
    `ValueError`, not `FileNotFoundError`. Bash's `-f` test passes on it and
    sends `Authorization: Bearer `, so the failure surfaces as a 401 the
    operator has to trace back to a file. Named here instead."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    _key(directory, "   \n")

    with pytest.raises(cli.AccountSetupError) as caught:
        cli._resources_for_key(directory, Settings(agent_root=tmp_path))

    assert "no usable api_key.txt" in str(caught.value)


def test_resources_for_key_never_falls_back_to_the_session_cookie(tmp_path: Path) -> None:
    """`resolve_auth` would fall back to `PasswordAuth` here; this builder
    must not.

    The fixture is what makes that visible: a BLANK `api_key.txt` (which
    `ApiKeyAuth.from_file` rejects with `ValueError`) AND a `SWIL_PASS` in
    settings. With both present, `resolve_auth` returns a working
    `PasswordAuth` and the call succeeds as SOMEBODY -- just not the account
    `population-metric` was told to use. `population-metric.sh` has no such
    fallback, and inheriting one silently would make "which account
    authorised this sample" unanswerable.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    _key(directory, "   \n")
    settings = Settings(agent_root=tmp_path, swil_pass="hunter2")

    with pytest.raises(cli.AccountSetupError):
        cli._resources_for_key(directory, settings)


def test_summary_prints_the_dashboard_and_exits_0(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The requested date is 2026-07-04 and the clock says 2026-08-19, on
    purpose: an explicit date that happens to BE today makes "the argument
    was used" indistinguishable from "the default was used" -- which is
    exactly the coincidence standing constraint §4 is about, and it left a
    live mutation alive until the two were pulled apart."""
    monkeypatch.setattr(cli, "datetime", _FixedClock)
    (tmp_agent / "agents" / "zenith" / "memory.md").write_text(
        "2026-07-04 | post | 你好\n2026-07-04 | like | ok\n2026-08-19 | post | 今天\n",
        encoding="utf-8",
    )
    result = runner.invoke(cli.app, ["summary", "2026-07-04"])

    assert result.exit_code == 0
    assert "zenith" in result.stdout
    assert "Date: 2026-07-04" in result.stdout
    assert "Date: 2026-08-19" not in result.stdout


def test_summary_adds_no_second_newline(tmp_agent: Path) -> None:
    """`run_summary`'s string already ends in a newline, so the command uses
    `nl=False`. A `print()` here would shift every diff against
    `agent-summary.sh`'s own stdout by one blank line -- the format is read
    by a human and documented in CLAUDE.md."""
    result = runner.invoke(cli.app, ["summary", "2026-07-04"])
    assert result.exit_code == 0
    assert not result.stdout.endswith("\n\n")


def test_summary_defaults_to_today_in_local_time(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`agent-summary.sh:18` is `date '+%Y-%m-%d'` -- LOCAL, not UTC. The two
    disagree for several hours of every day, and the counting is a prefix
    match on `memory.md` lines, so a UTC default silently reports yesterday's
    activity for anyone west of Greenwich in the evening.

    `_FixedClock`'s two answers fall on DIFFERENT DATES on purpose (standing
    constraint §4): a stub that returned one instant for both `now()` and
    `now(UTC)` would format identically either way, and the assertion would
    name the right field while proving nothing."""
    monkeypatch.setattr(cli, "datetime", _FixedClock)

    result = runner.invoke(cli.app, ["summary"])

    assert result.exit_code == 0
    assert "Date: 2026-08-19" in result.stdout


def test_summary_needs_no_account_no_server_and_no_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Local only: it reads `memory.md` files and touches no API. An empty
    roster is not an error -- there is no 66 and no 75 on this command."""
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))

    result = runner.invoke(cli.app, ["summary", "2026-07-04"])

    assert result.exit_code == 0
    assert "Date: 2026-07-04" in result.stdout


def test_resources_for_key_sends_the_bearer_token_and_nothing_else(tmp_path: Path) -> None:
    """The happy path of the key-only builder, over a real `ApiClient`.

    Two claims in one, both taken from `population-metric.sh`: the request
    carries the account's key as a Bearer token, and NO login call is made --
    the script never falls back to `SWIL_PASS`, and falling back here would
    authenticate as an account the caller did not pick.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    _key(directory)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="hunter2")
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, json={"data": {"capturedAt": "2026-08-19T00:00:00.000Z"}})

    resources = cli._resources_for_key(directory, settings, transport=httpx.MockTransport(handler))
    resources.record_population_metric()

    assert seen == [("/api/v1/agents/population-metric", "Bearer k-secret")]


@pytest.mark.parametrize("command", ["behavior-snapshot"])
def test_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: str
) -> None:
    """`load_persona` raises `ValueError`, not `FileNotFoundError`, for a
    personality.md that EXISTS but has no frontmatter. The file is right
    there, so this is 75-with-a-remedy and never 66 -- the same distinction
    `act`, `dream` and `cycle` each carry their own test for."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))

    result = runner.invoke(cli.app, [command, "zenith"])

    assert result.exit_code == 75
    assert "frontmatter" in result.stdout
    assert "Traceback" not in result.stdout


def test_an_unexpected_behavior_snapshot_failure_exits_75_not_1(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`run_behavior_snapshot` never raises on any path it knows about, so
    what this guards is the class it does not: a raw traceback and exit 1
    would be a FOURTH exit code neither `cycle-one.sh` nor the heartbeat
    knows how to read. Note the contrast with the same failure INSIDE a
    cycle, where it is swallowed entirely -- there it would cost the account
    its dream; here it is the whole command."""
    _key(tmp_agent / "agents" / "zenith")

    def boom(*_args: object, **_kwargs: object) -> object:
        raise OSError("disk on fire")

    monkeypatch.setattr(cli, "run_behavior_snapshot", boom)

    result = runner.invoke(cli.app, ["behavior-snapshot", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED OSError" in result.stdout


def test_an_unexpected_population_metric_failure_exits_75_not_1(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same invariant, one command over. `run_population_metric` reports a
    rejection rather than raising, so anything that DOES escape it is a bug
    -- and must still leave the 0/66/75 contract intact."""
    _key(tmp_agent / "agents" / "zenith")
    monkeypatch.setattr(cli, "_resources_for_key", lambda directory, settings: FakeResources())

    def boom(*_args: object, **_kwargs: object) -> object:
        raise OSError("disk on fire")

    monkeypatch.setattr(cli, "run_metric", boom)

    result = runner.invoke(cli.app, ["population-metric", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED OSError" in result.stdout


def test_behavior_snapshot_stamps_captured_at_in_utc(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`behavior-snapshot.sh:75` is `date -u`, and `build_behavior_payload`
    formats with a LITERAL `Z` -- so a naive `datetime.now()` produces a
    perfectly well-formed timestamp that is simply wrong by the local UTC
    offset, and every fidelity point lands in the wrong hour bucket. Nothing
    about the string's shape would say so, which is why the clock stub's two
    answers are on different dates."""
    _key(tmp_agent / "agents" / "zenith")
    resources = _sampling_resources(monkeypatch)
    monkeypatch.setattr(cli, "datetime", _FixedClock)

    result = runner.invoke(cli.app, ["behavior-snapshot", "zenith"])

    assert result.exit_code == 0
    assert resources.behavior_snapshots[0][1]["capturedAt"] == "2026-08-20T06:30:00Z"


def test_population_metric_never_borrows_another_accounts_key(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A NAMED account with no key must fail, not silently fall through to
    the scan.

    `population-metric.sh:25-34` looks only where the name says. Falling back
    would authenticate the call as an account the operator did not choose --
    harmless for this global route today, and exactly the habit that is not
    harmless the first time a per-account route reuses the helper.
    """
    other = tmp_agent / "agents" / "aardvark"
    other.mkdir(parents=True)
    _key(other)  # a keyed account exists -- just not the one that was named
    monkeypatch.setattr(cli, "_resources_for_key", lambda directory, settings: FakeResources())

    result = runner.invoke(cli.app, ["population-metric", "zenith"])

    assert result.exit_code == 75
    assert "register" in result.stdout


@pytest.mark.parametrize(("command", "marker"), [("behavior-snapshot", "behavior-snapshot:")])
def test_the_standalone_samplers_write_to_the_act_log(
    tmp_agent: Path,
    monkeypatch: pytest.MonkeyPatch,
    round_log_level: None,
    command: str,
    marker: str,
) -> None:
    """Same destination the cycle gives it, for the same reason: it
    measures the ACT phase's posts. A standalone invocation that logged to
    `dream.log` would split one account's history across two files depending
    on how it happened to be sampled."""
    _sampling_resources(monkeypatch)

    result = runner.invoke(cli.app, [command, "zenith"])

    assert result.exit_code == 0
    assert any(marker in line for line in _round_log_lines(tmp_agent, "auto-run.log"))
    assert not any(marker in line for line in _round_log_lines(tmp_agent, "dream.log"))


# ── F6: agent/logs/auto-run.log (auto-run.sh's `_log`) ────────────────────


_ROUND_LOG_LINE_RE = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (?P<body>.+)$")


def _round_log_lines(agent_root: Path, filename: str = "auto-run.log") -> list[str]:
    """Lines of ONE of the two round logs. `filename` is explicit and has a
    default only because most callers here are act-path tests; the two files
    are genuinely different destinations (`auto-run.sh:34` vs
    `dream.sh:40`), never two names for one."""
    path = agent_root / "logs" / filename
    if not path.is_file():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


@pytest.fixture
def round_log_level(caplog: pytest.LogCaptureFixture) -> None:
    """Restore the level a REAL `swil-agent` process runs at.

    `_main`'s `logging.basicConfig(level=INFO)` passes `force=False`, so in a
    real process (no handlers configured yet) it sets the root level to INFO
    and the round log sees INFO records. Under pytest the logging plugin has
    already installed root handlers, so that `basicConfig` is a no-op and the
    root level stays at WARNING -- an artefact of the harness, not of the
    code. Setting it here makes these tests observe production behaviour;
    it is deliberately NOT done by pinning a level onto the `swil_agent`
    logger in `cli.py`, which would leak across tests and swallow the DEBUG
    traceback `_skip_for_exception` relies on.
    """
    caplog.set_level(logging.INFO)


def test_act_writes_the_executor_log_line_into_auto_run_log(
    tmp_agent: Path, round_log_level: None
) -> None:
    """The 17 `ExecutionOutcome.log_line` values were computed and dropped:
    nothing in the package logged them and nothing wrote a file at all, so a
    Python round left `agent/logs/auto-run.log` untouched -- which reads
    exactly like a round that never happened to the straggler-reconciliation
    and post-run-QA greps every round of this project ends with.

    Mutation this catches, either half: deleting `execute_action`'s
    `logger.log(...)` call, or deleting `_attach_round_log(settings)` from
    the `act` command.
    """
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0

    bodies = [
        m.group("body")
        for line in _round_log_lines(tmp_agent)
        if (m := _ROUND_LOG_LINE_RE.match(line))
    ]
    assert any(b.startswith("DONE zenith posted") for b in bodies), bodies


def test_the_round_log_line_is_in_bash_s_format(tmp_agent: Path, round_log_level: None) -> None:
    """`_log`'s format is `[%Y-%m-%d %H:%M:%S] <message>` -- a bracketed
    timestamp and then the message, with NO level name. Mutation this
    catches: reusing `basicConfig`'s `"%(levelname)s %(message)s"` for the
    file handler, which prefixes every line with `INFO`/`WARNING` and breaks
    a `grep '^\\[.*\\] DONE'` that has worked against this file for months.
    """
    runner.invoke(cli.app, ["act", "zenith"])
    lines = _round_log_lines(tmp_agent)
    assert lines, "no round log written at all"
    for line in lines:
        assert _ROUND_LOG_LINE_RE.match(line), line
        assert not line.startswith("INFO")
        body = _ROUND_LOG_LINE_RE.match(line).group("body")  # type: ignore[union-attr]
        assert not body.startswith(("INFO ", "WARNING ", "DEBUG "))


def test_the_round_log_appends_across_invocations_without_duplicating(
    tmp_agent: Path, round_log_level: None
) -> None:
    """Bash appends (`>>`), so a second round adds to the file rather than
    truncating it. And `_attach_round_log` must stay idempotent: a second
    handler on the same logger would write every line of the SECOND round
    twice, which would silently inflate every count anyone greps out of this
    file. Mutation this catches: dropping the `baseFilename` short-circuit.
    """
    runner.invoke(cli.app, ["act", "zenith"])
    first = _round_log_lines(tmp_agent)
    runner.invoke(cli.app, ["act", "zenith"])
    second = _round_log_lines(tmp_agent)

    assert second[: len(first)] == first  # appended, not truncated
    added = second[len(first) :]
    assert len(added) == len(first)  # exactly one more round's worth, not two


def test_a_dry_run_writes_no_executor_lines(tmp_agent: Path, round_log_level: None) -> None:
    """`--dry-run` executes nothing, so there is no DONE/WARN/SKIP line to
    write. It may still open the file (harmless); what it must not do is
    claim an action landed."""
    runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert not any("DONE zenith posted" in line for line in _round_log_lines(tmp_agent))


# ── F5: a missing backend BINARY is a setup failure (75), never 66 ────────


class _MissingBinaryBackend:
    """A `Backend` whose `complete()` fails the way a real one does when its
    CLI is absent from PATH.

    `SubprocessRunner.run` re-raises `subprocess`'s own `FileNotFoundError`
    as `BackendBinaryMissingError` (`llm/base.py`), so this reproduces what
    `run_act`/`run_dream` actually see -- rather than a hand-written
    `FileNotFoundError`, which would only test the guard's shape and not the
    translation the fix depends on. The translation itself is pinned
    separately by
    `test_subprocess_runner_reports_a_missing_binary_as_its_own_type`.
    """

    name = "codex"

    def complete(self, req: object) -> str:
        raise BackendBinaryMissingError("executable not found on PATH: 'codex'")


def test_act_a_missing_backend_binary_exits_75_with_a_remedy(tmp_agent: Path) -> None:
    """It used to exit 66, "no such account", because `act` wrapped the whole
    round in one `except FileNotFoundError` and `subprocess` raises exactly
    that type for a missing argv[0]. This project has already burned real
    time on "no response from codex" incidents; an exit code naming the
    roster instead of PATH makes the next one worse.

    Mutation this catches, either half: reverting `act` to a single `try`
    with a round-wide `except FileNotFoundError`, or removing
    `SubprocessRunner`'s re-raise so a raw `FileNotFoundError` escapes again.
    """
    monkeypatch_backend = _MissingBinaryBackend()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli, "_backend_for", lambda persona, settings: monkeypatch_backend)
        result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "SKIP zenith" in result.stdout
    assert "executable not found on PATH: 'codex'" in result.stdout
    # A REMEDY, not just a cause -- `AccountSetupError`'s whole contract.
    assert "on PATH and authenticated" in result.stdout
    # And never misclassified as a bug.
    assert "UNEXPECTED" not in result.stdout


def test_dream_a_missing_backend_binary_exits_75_with_a_remedy(tmp_agent: Path) -> None:
    """Same guard on the dream path, where the failure previously read as
    `UNEXPECTED FileNotFoundError` -- exit 75 already, but rendered as a
    programming error rather than a fixable setup problem.

    Mutation this catches: making `BackendBinaryMissingError` a SUBCLASS of
    `BackendUnavailableError`. `dream/round.py`'s `dream_step` catches that
    type and degrades to `""`, so the missing binary would be
    reported as "LLM returned empty" and the command would exit 0 -- the
    "whole round silently drops every account on one backend" shape
    CLAUDE.md already records."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli, "_backend_for", lambda persona, settings: _MissingBinaryBackend())
        result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "executable not found on PATH: 'codex'" in result.stdout
    assert "on PATH and authenticated" in result.stdout
    assert "UNEXPECTED" not in result.stdout


def test_a_genuinely_absent_account_still_exits_66(tmp_agent: Path) -> None:
    """The other side of the F5 change: 66 must keep meaning exactly one
    thing. Mutation this catches: deleting `act`'s first `except
    FileNotFoundError`, which would fold "no such account" into the generic
    75 guard and lose the distinction entirely."""
    result = runner.invoke(cli.app, ["act", "does-not-exist"])
    assert result.exit_code == 66
    assert "no such account: does-not-exist" in result.output


def test_subprocess_runner_reports_a_missing_binary_as_its_own_type() -> None:
    """The translation itself, at the layer that performs it, against a
    genuinely absent binary. `return ""` would have been the tempting
    alternative and is worse: an empty string is indistinguishable from a
    dead LLM, so the diagnosis cost is unchanged."""
    with pytest.raises(BackendBinaryMissingError, match="executable not found on PATH"):
        SubprocessRunner().run(["swil-agent-no-such-binary-xyz"])


# ── R20: the two round logs are two different files ───────────────────────


def test_a_dream_writes_dream_log_and_leaves_auto_run_log_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, round_log_level: None
) -> None:
    """`dream.sh:36-40` sets `LOG_FILE="$LOG_DIR/dream.log"`;
    `auto-run.sh:31-34` sets `LOG_FILE="$LOG_DIR/auto-run.log"`. Two live
    files -- both present and written on the same day in the main checkout
    (auto-run.log 1.0MB, dream.log 234KB) -- not two names for one.

    `_attach_round_log` hardcoded `auto-run.log` for BOTH commands, so Python
    dreams appended dream lines into the act log while `dream.log` stayed
    empty. Nothing caught it: deleting the `dream` command's
    `_attach_round_log` call broke ZERO tests, because the only assertions
    that existed were act-path ones.

    Mutations this catches, all three:
      * passing `ACT_LOG_FILENAME` from `dream` (the original defect) --
        `dream.log` is then empty and `auto-run.log` holds the dream line;
      * deleting `dream`'s `_attach_round_log` call entirely -- `dream.log`
        is never created;
      * swapping the two constants' values.
    """
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: StubBackend(DREAM_REPLY),
    )
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0

    dream_lines = _round_log_lines(tmp_path, "dream.log")
    assert any("dreamed" in line for line in dream_lines), dream_lines
    for line in dream_lines:
        assert _ROUND_LOG_LINE_RE.match(line), line
    # The act log must not exist at all -- a dream never appends to it.
    assert _round_log_lines(tmp_path, "auto-run.log") == []


def test_an_act_writes_auto_run_log_and_leaves_dream_log_alone(
    tmp_agent: Path, round_log_level: None
) -> None:
    """The mirror assertion, so the pair pins the mapping in BOTH directions:
    swapping `ACT_LOG_FILENAME` and `DREAM_LOG_FILENAME` breaks this one as
    well as the dream one, where either test alone would let a swap through
    if the other command were never exercised."""
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0

    assert any("DONE zenith posted" in line for line in _round_log_lines(tmp_agent))
    assert _round_log_lines(tmp_agent, "dream.log") == []


def test_the_two_log_filenames_are_the_ones_the_scripts_use() -> None:
    """Pinned as literals against the scripts, so a rename shows up here
    rather than as a silently-empty file someone greps months later."""
    assert cli.ACT_LOG_FILENAME == "auto-run.log"
    assert cli.DREAM_LOG_FILENAME == "dream.log"


# ── doctor / measure-status / non-prod (spec §11) ──────────────────────────


_PRODUCTION_URL = "https://swil-social-api-production.up.railway.app"


def _doctor_ready(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    url: str = "http://localhost:8899",
) -> None:
    """A doctor invocation whose only variables are the ones the test is
    about: PATH, embedder, heartbeat, and the URL. Lock dir is tmp_path."""
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path, swil_url=url))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_on_path", lambda name: True)
    monkeypatch.setattr(cli, "_heartbeat_launchctl_status", lambda: "not loaded")
    monkeypatch.setattr(cli, "_since_probe", lambda settings: (True, "ok"))


def test_doctor_exits_75_when_url_is_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Spec §11: empty SWIL_URL is not ready."""
    _doctor_ready(monkeypatch, tmp_path, url="")
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 75
    assert "SWIL_URL" in result.stdout


def test_doctor_warns_on_the_production_host_and_still_exits_0_when_otherwise_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The production host is a warning, not a fail. doctor documents
    SWIL_REQUIRE_NON_PROD rather than enforcing it."""
    _doctor_ready(monkeypatch, tmp_path, url=_PRODUCTION_URL)
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    output = result.stdout
    assert "swil-social-api-production.up.railway.app" in output
    assert "WARN" in output
    assert "SWIL_REQUIRE_NON_PROD" in output


def test_doctor_exits_75_when_claude_is_missing_from_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    monkeypatch.setattr(cli, "_on_path", lambda name: name != "claude")
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 75
    assert "claude" in result.stdout


def test_doctor_fails_when_era_start_is_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ERA_START")
    _doctor_ready(monkeypatch, tmp_path)
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 75
    assert "ERA_START: FAIL (unset)" in result.stdout
    assert cli.ERA_START_REMEDY in result.stdout


def test_doctor_warns_when_era_start_is_in_the_future_and_stays_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ERA_START", "2999-01-01T00:00:00")
    _doctor_ready(monkeypatch, tmp_path)
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    assert "ERA_START: 2999-01-01T00:00:00+00:00" in result.stdout
    assert "WARN: ERA_START is in the future" in result.stdout


def test_doctor_reports_a_past_era_start_without_a_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    assert "ERA_START: 2000-01-01T00:00:00+00:00" in result.stdout
    assert "in the future" not in result.stdout


def test_doctor_checks_the_cli_of_every_roster_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    _write_era3(tmp_path, "aa", "codex:gpt-5.6-luna")
    _write_era3(tmp_path, "bb", "grok:grok-4.6")
    _write_era3(tmp_path, "cc", "cursor:gemini-3.7-flash-high")
    _write_era3(tmp_path, "dd", "claude:claude-haiku-5-5")
    _write_era3(tmp_path, "ee", "claude:claude-opus-5-5")
    checked: list[str] = []

    def on_path(name: str) -> bool:
        checked.append(name)
        return name != "cursor-agent"

    monkeypatch.setattr(cli, "_on_path", on_path)
    result = runner.invoke(cli.app, ["doctor"])
    assert checked == ["claude", "uv", "codex", "grok", "cursor-agent"]
    assert "cursor-agent: not on PATH" in result.stdout
    assert result.exit_code == 75


def test_doctor_missing_launchctl_is_not_a_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spec §11: `launchctl list` is best-effort; missing launchctl ≠ fail."""
    _doctor_ready(monkeypatch, tmp_path)
    monkeypatch.setattr(
        cli, "_heartbeat_launchctl_status", lambda: "launchctl missing (not a fail)"
    )
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    assert "launchctl missing" in result.stdout


def test_measure_status_builds_a_summary_from_a_fake_runtime_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spec §11: prints rounds / fail-open / missing samples. Default since
    is the 2026-07-25 design date. Roster is counted from the local tree."""
    _write_zenith(tmp_path)
    monkeypatch.setattr(
        cli, "load_settings", lambda: Settings(agent_root=tmp_path, swil_url="https://example.test")
    )
    payload = {
        "range": "30d",
        "rounds": 13,
        "accountsRun": 3,
        "failOpenGates": 10,
        "missingSamples": 11,
        "landedActions": 18,
        "points": [
            {"date": "2026-07-20", "rounds": 9, "failOpen": 9, "missingSamples": 9, "landed": 9},
            {"date": "2026-08-01", "rounds": 4, "failOpen": 1, "missingSamples": 2, "landed": 9},
        ],
    }
    monkeypatch.setattr(cli, "_fetch_runtime_health", lambda settings, *, since: payload)

    result = runner.invoke(cli.app, ["measure-status"])

    assert result.exit_code == 0
    output = result.stdout
    assert "2026-07-25" in output
    assert "rounds: 4" in output
    assert "fail-open" in output and "1" in output
    assert "missing samples: 2" in output
    # The 2026-07-20 point is before the default since and must not inflate
    # the printed totals (9 would mean the filter never ran).
    assert "rounds: 9" not in output
    assert "roster: 1" in output


def test_measure_status_exits_75_on_api_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        cli, "load_settings", lambda: Settings(agent_root=tmp_path, swil_url="https://example.test")
    )

    def _boom(settings: Settings, *, since: object) -> dict[str, object]:
        raise RuntimeError("connection refused")

    monkeypatch.setattr(cli, "_fetch_runtime_health", _boom)
    result = runner.invoke(cli.app, ["measure-status"])
    assert result.exit_code == 75
    assert (
        "API" in result.stdout
        or "API" in result.stderr
        or "fail" in (result.stdout + result.stderr).lower()
    )


@pytest.mark.parametrize("command", ["rule-check", "echo-calibrate"])
def test_the_retired_era_2_commands_are_gone(tmp_agent: Path, command: str) -> None:
    """The rule check and the echo-chamber calibration measured Era 2's
    persona format; neither has anything to read in Era 3."""
    result = runner.invoke(cli.app, [command, "zenith"])
    assert result.exit_code == 2


def test_require_non_prod_refuses_act_against_the_production_host_without_the_override(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spec §11: SWIL_REQUIRE_NON_PROD=1 + production host → exit 75 unless
    --i-mean-production."""
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", "1")
    monkeypatch.setattr(
        cli,
        "load_settings",
        lambda: Settings(agent_root=tmp_agent, swil_url=_PRODUCTION_URL),
    )
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 75
    output = result.stdout + result.stderr
    assert "swil-social-api-production.up.railway.app" in output
    assert "--i-mean-production" in output
    assert _memory_unchanged(tmp_agent)


def test_require_non_prod_allows_act_with_the_override_flag(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", "1")
    monkeypatch.setattr(
        cli,
        "load_settings",
        lambda: Settings(agent_root=tmp_agent, swil_url=_PRODUCTION_URL),
    )
    result = runner.invoke(cli.app, ["act", "zenith", "--i-mean-production", "--dry-run"])
    assert result.exit_code == 0
    assert "would execute" in result.stdout


def test_require_non_prod_refuses_cycle_against_the_production_host(
    tmp_cycle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", "1")
    monkeypatch.setattr(
        cli,
        "load_settings",
        lambda: Settings(agent_root=tmp_cycle, swil_url=_PRODUCTION_URL),
    )
    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run"])
    assert result.exit_code == 75
    assert "--i-mean-production" in result.stdout + result.stderr


def test_the_roster_count_reads_agents_only(tmp_path: Path) -> None:
    """Era 3 has one cohort; a missing `agents/` is an empty roster and a
    leftover `humans/` tree is not counted."""
    assert cli._roster_count(tmp_path) == 0
    _write_zenith(tmp_path)
    human = tmp_path / "humans" / "aardvark"
    human.mkdir(parents=True)
    (human / "personality.md").write_text(ZENITH_PERSONALITY, encoding="utf-8")
    assert cli._roster_count(tmp_path) == 1


# ── Era 3: since probe, --smoke, register ───────────────────────────────────


def _since_transport(items: list[object], status: int = 200) -> httpx.MockTransport:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={"data": {"items": items}})

    transport = httpx.MockTransport(handler)
    transport.seen = seen  # type: ignore[attr-defined]
    return transport


def test_since_probe_passes_when_server_returns_nothing(tmp_path: Path) -> None:
    transport = _since_transport([])
    ok, _ = cli._since_probe(Settings(agent_root=tmp_path), transport=transport)
    assert ok
    request = transport.seen[0]  # type: ignore[attr-defined]
    assert request.url.params["since"] == "2999-01-01T00:00:00Z"
    assert request.url.params["limit"] == "1"


def test_since_probe_fails_when_server_ignores_since(tmp_path: Path) -> None:
    ok, msg = cli._since_probe(
        Settings(agent_root=tmp_path), transport=_since_transport([{"id": "p1"}])
    )
    assert not ok and "deploy the backend first" in msg


def test_since_probe_fails_on_http_error_and_bad_shape(tmp_path: Path) -> None:
    ok, msg = cli._since_probe(Settings(agent_root=tmp_path), transport=_since_transport([], 500))
    assert not ok and "500" in msg

    def bad(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1])

    ok, msg = cli._since_probe(Settings(agent_root=tmp_path), transport=httpx.MockTransport(bad))
    assert not ok and "shape" in msg


def test_since_probe_fails_when_unreachable(tmp_path: Path) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    ok, msg = cli._since_probe(Settings(agent_root=tmp_path), transport=httpx.MockTransport(boom))
    assert not ok and "unreachable" in msg


def test_doctor_exits_75_when_since_probe_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    monkeypatch.setattr(cli, "_since_probe", lambda settings: (False, "server ignores `since`"))
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 75
    assert "since probe: FAIL" in result.stdout


_ERA3 = """---
username: {name}
display_name: {name}
model: {model}
board: life-science
topics: [health]
era: 3
---
# {name}

一段人设。

## 最近
- 一条
"""


def _write_era3(root: Path, name: str, model: str) -> None:
    directory = root / "agents" / name
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(
        _ERA3.format(name=name, model=model), encoding="utf-8"
    )


def test_smoke_with_no_era3_accounts_is_not_a_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    legacy = tmp_path / "agents" / "old"
    legacy.mkdir(parents=True)
    (legacy / "personality.md").write_text("# old\n- **Username:** old\n", encoding="utf-8")
    result = runner.invoke(cli.app, ["doctor", "--smoke"])
    assert result.exit_code == 0
    assert "no Era 3 accounts" in result.stdout


def test_smoke_reports_each_distinct_arm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    _write_era3(tmp_path, "aa", "claude:claude-haiku-5-5")
    _write_era3(tmp_path, "bb", "claude:claude-haiku-5-5")
    _write_era3(tmp_path, "cc", "codex:gpt-5.6-luna")
    requests: list[object] = []

    class Backend:
        def __init__(self, reply: str) -> None:
            self.reply = reply

        def complete(self, req: object) -> str:
            requests.append(req)
            return self.reply

    def fake_backend(persona: Persona, settings: Settings) -> object:
        if persona.backend == "codex":
            raise RuntimeError("codex missing")
        return Backend("ok")

    monkeypatch.setattr(cli, "_backend_for", fake_backend)
    result = runner.invoke(cli.app, ["doctor", "--smoke"])
    assert "smoke claude:claude-haiku-5-5: OK" in result.stdout
    assert "smoke codex:gpt-5.6-luna: FAIL (codex missing)" in result.stdout
    assert len(requests) == 1  # two claude accounts, one distinct arm
    assert result.exit_code == 75


def test_smoke_empty_reply_is_a_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _doctor_ready(monkeypatch, tmp_path)
    _write_era3(tmp_path, "aa", "claude:claude-haiku-5-5")

    class Silent:
        def complete(self, req: object) -> str:
            return "  "

    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: Silent())
    result = runner.invoke(cli.app, ["doctor", "--smoke"])
    assert "FAIL (empty reply)" in result.stdout
    assert result.exit_code == 75


def test_register_command_dry_run_wires_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_era3(tmp_path, "aa", "claude:claude-haiku-5-5")
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))
    result = runner.invoke(cli.app, ["register", "aa", "--dry-run"])
    assert result.exit_code == 0
    assert "[dry-run] POST /auth/register" in result.stdout


def test_register_command_unknown_account_exits_66(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))
    result = runner.invoke(cli.app, ["register", "ghost", "--dry-run"])
    assert result.exit_code == 66


def test_register_command_failures_exit_75(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())

    def fail(*args: object, **kwargs: object) -> None:
        raise cli.RegisterError("embedder down")

    monkeypatch.setattr(cli, "register_account", fail)
    result = runner.invoke(cli.app, ["register", "aa"])
    assert result.exit_code == 75
    assert "embedder down" in result.stdout


@pytest.mark.parametrize(("argv", "expected"), [([], False), (["--adopt"], True)])
def test_register_command_forwards_adopt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, argv: list[str], expected: bool
) -> None:
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    seen: dict[str, object] = {}

    def record(*args: object, **kwargs: object) -> None:
        seen.update(kwargs)

    monkeypatch.setattr(cli, "register_account", record)
    result = runner.invoke(cli.app, ["register", "aa", *argv])
    assert result.exit_code == 0
    assert seen["adopt"] is expected


def test_register_command_refuses_an_existing_user_without_adopt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(agent_root=tmp_path))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())

    def refuse(*args: object, adopt: bool, **kwargs: object) -> None:
        if not adopt:
            raise cli.RegisterError("@aa already exists on the server. Pass --adopt")

    monkeypatch.setattr(cli, "register_account", refuse)
    result = runner.invoke(cli.app, ["register", "aa"])
    assert result.exit_code == 75
    assert "--adopt" in result.stdout
