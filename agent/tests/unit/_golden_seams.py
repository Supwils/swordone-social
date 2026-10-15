"""The ONE list of seams a CLI-driven cycle test patches.

`_patch_cycle_seams` used to live in `test_cli.py`. It moved here (S3 Task 1)
so the golden equivalence test (`test_golden_runs.py`) and `test_cli.py`
patch exactly the same names: two copies of a seam list are two things a
refactor has to retarget, and the one it forgets makes a test silently dial a
real socket or spawn a real `claude`.

**This module is the only piece of the golden harness a later task may
retarget** (S3 spec §12.1). When a seam moves -- `cli.py` splitting into a
package, say -- the `monkeypatch.setattr` targets below follow the code that
looks the name up at call time (§12.15), and nothing else in the golden test
changes. Every override parameter exists so the golden test never has to
reach past this function to patch a seam itself.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.cli import compose
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.models import Persona

from ._runners import FakeResources, RecordingRunner, ScriptedBackend

# The dream's reply: a new 最近 list.
DREAM_REPLY = '{"recent": ["改写后的近况"]}'

_POST_PLAN = '{"plan":[{"action":"post","text":"hello from zenith"}]}'


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


def _cycle_backend() -> ScriptedBackend:
    """One backend object for a whole cycle: the plan, then the dream's new
    list -- in the order `run_cycle` spends them."""
    return ScriptedBackend(_POST_PLAN, DREAM_REPLY)


def _patch_cycle_seams(
    monkeypatch: pytest.MonkeyPatch,
    agent_root: Path,
    *,
    settings: Settings | None = None,
    resources: Callable[[Persona, Settings], Any] | None = None,
    backend: Callable[[Persona, Settings], Any] | None = None,
    embedder: Callable[[Settings], Any] | None = None,
    guard: Callable[[Settings], Any] | None = None,
    health_check: Callable[[Settings], bool] | None = None,
    runner: Callable[[Settings], Any] | None = None,
    clock: type[datetime] | None = None,
) -> None:
    """Every network-, subprocess- and clock-facing seam a cycle reaches.

    `runner_for` is patched too: the world-context renderers shell out
    through it, and a unit test must never spawn a real process.

    Every target is `swil_agent.cli.compose`, the module whose builders and
    commands look these names up at call time (S3 §12.15).

    Called with no overrides this is exactly the seam set `test_cli.py` has
    always used. Each keyword replaces one seam's default factory; `clock`,
    when given, replaces `compose.now` with the clock class's `now` (left
    alone by default, so the real clock runs).
    """
    # The rhythm roll always lets the planned post through, even after an
    # earlier command in the same test already posted today.
    resolved = (
        settings
        if settings is not None
        else Settings(agent_root=agent_root, post_probability=100, post_ceiling_per_day=10)
    )
    monkeypatch.setattr(compose, "load_settings", lambda: resolved)
    monkeypatch.setattr(
        compose,
        "resources_for",
        resources if resources is not None else (lambda persona, settings: FakeResources()),
    )
    monkeypatch.setattr(
        compose,
        "backend_for",
        backend if backend is not None else (lambda persona, settings: _cycle_backend()),
    )
    monkeypatch.setattr(
        compose,
        "embedder_for",
        embedder if embedder is not None else (lambda settings: _FakeEmbedderClient()),
    )
    monkeypatch.setattr(
        compose, "guard_for", guard if guard is not None else (lambda settings: _FakeGuard())
    )
    monkeypatch.setattr(
        compose,
        "health_check",
        health_check if health_check is not None else (lambda settings: True),
    )
    monkeypatch.setattr(
        compose,
        "runner_for",
        runner if runner is not None else (lambda settings: RecordingRunner()),
    )
    if clock is not None:
        # Every clock read the commands take goes through `compose.now`
        # (S3 §12.13), so the clock class's own `now` stands in for it.
        monkeypatch.setattr(compose, "now", clock.now)
