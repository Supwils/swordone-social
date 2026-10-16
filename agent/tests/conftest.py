"""Suite-wide fixtures."""

from __future__ import annotations

import gc
import signal
from collections.abc import Iterator

import pytest

from swil_agent.config import Settings
from tests.unit._sqlite import close_tracked

# A full gc.collect() costs ~15 ms with langgraph loaded, which tripled the
# suite when run after all ~2000 tests. Cyclic garbage that owns a sqlite
# connection can only come from modules that touch the graph, the leases or
# sqlite itself, so only those pay for it.
_GC_MODULE_PREFIXES = ("test_graph_", "test_locks_", "test_cycle_", "test_cli")


def _may_leak_connections(request: pytest.FixtureRequest) -> bool:
    module = request.module
    if module.__name__.rsplit(".", 1)[-1].startswith(_GC_MODULE_PREFIXES):
        return True
    return any(getattr(value, "__name__", None) == "sqlite3" for value in vars(module).values())


@pytest.fixture(autouse=True)
def _collect_garbage_after_test(request: pytest.FixtureRequest) -> Iterator[None]:
    """Close tracked connections, then GC, so a leaked resource held in a
    reference cycle is finalized (and its ResourceWarning raised) in the test
    that leaked it, not in an arbitrary later test or at session end."""
    yield
    close_tracked()
    if _may_leak_connections(request):
        gc.collect()


@pytest.fixture(autouse=True)
def _restore_sigterm_disposition() -> Iterator[None]:
    """Every `runner.invoke(cli.app, ...)` runs the app callback, which
    installs the CLI's SIGTERM -> SystemExit handler in THIS process. Put the
    disposition back so no test inherits another test's handler."""
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


# Every env name `Settings` reads, derived from the model so it cannot drift.
_SETTINGS_ENV = tuple(name.upper() for name in Settings.model_fields)


@pytest.fixture(autouse=True)
def _isolate_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The process env outranks `agent/.env`, so a developer's exported
    `SWIL_URL` / `SWIL_PASS` would reach every `Settings()` a test builds --
    breaking assertions, or letting a "no credentials" test log in to
    production. Each test starts with none of them; a test that needs one sets
    it itself (`SWIL_ROUND_ID` included)."""
    for name in _SETTINGS_ENV:
        monkeypatch.delenv(name, raising=False)
