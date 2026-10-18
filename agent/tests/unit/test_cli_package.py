"""The `swil_agent.cli` package's shape (S3 §6, §12.12-§12.16).

`test_cli.py` drives the commands; this file pins what the package split must
not change: the command list `--help` prints, the logger names the round logs
route by, which file a record from each lands in, and the layering of the
modules the business logic moved to.
"""

from __future__ import annotations

import ast
import logging
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.cli import compose, errors, logs, run, stores
from swil_agent.config import Settings

from ._golden_seams import _patch_cycle_seams

PACKAGE = Path(__file__).resolve().parents[2] / "swil_agent"

runner = CliRunner()

# What `swil-agent --help` lists, in order (`prompt-ab` added 2026-10-17).
_COMMANDS = [
    "act",
    "dream",
    "cycle",
    "behavior-snapshot",
    "backfill-post-vectors",
    "population-metric",
    "intervention",
    "summary",
    "version",
    "doctor",
    "register",
    "measure-status",
    "prompt-ab",
]


_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _listed_commands(help_text: str) -> list[str]:
    """Command names from the rich `Commands` panel: the first word of every
    row whose first cell is not a continuation line. ANSI styling is stripped
    first: rich forces it on under GitHub Actions."""
    panel = _ANSI.sub("", help_text).split("Commands", 1)[1]
    names: list[str] = []
    for line in panel.splitlines():
        match = re.match(r"^│ (\S+)\s{2,}", line)
        if match:
            names.append(match.group(1))
    return names


def test_help_lists_exactly_the_commands_it_listed_before_the_split() -> None:
    """Plus the one group S3 §8 adds, last: `bench` (the Persona Bench)."""
    result = runner.invoke(cli.app, ["--help"], env={"COLUMNS": "160"}, terminal_width=160)
    assert result.exit_code == 0, result.output
    assert _listed_commands(result.stdout) == [*_COMMANDS, "bench"]


def test_the_registered_commands_are_the_same_list() -> None:
    """The same pin without the renderer: Typer's own registration order
    (an unnamed command takes its callback's name, `_` read as `-`)."""
    names = []
    for command in cli.app.registered_commands:
        assert command.callback is not None
        names.append(command.name or command.callback.__name__.replace("_", "-"))
    assert names == _COMMANDS


def test_the_bench_group_is_bench_app_registered_as_bench() -> None:
    """S3 §12.13: the Typer group is bound to `bench_app`; the package
    attribute `bench` stays the `swil_agent.cli.bench` module."""
    import swil_agent.cli.bench as bench_module

    (group,) = cli.app.registered_groups
    assert group.name == "bench"
    assert group.typer_instance is bench_module.bench_app
    names = [command.name for command in bench_module.bench_app.registered_commands]
    assert names == ["run", "all"]


def test_the_package_re_exports_the_three_round_commands_with_their_docstrings() -> None:
    assert cli.act is run.act
    assert cli.dream is run.dream
    assert cli.cycle is run.cycle
    for command in (cli.act, cli.dream, cli.cycle):
        assert command.__doc__ and "LangGraph run" in command.__doc__


def test_the_entry_point_object_is_the_typer_app() -> None:
    pyproject = (PACKAGE.parent / "pyproject.toml").read_text(encoding="utf-8")
    assert 'swil-agent = "swil_agent.cli:app"' in pyproject
    assert cli.app.info.help == "Swil Social agent runtime"


def test_nothing_named_bench_is_bound_on_the_cli_package() -> None:
    """`cli/bench.py` exists since Task 6, so the import system binds the
    package attribute `bench` to that module; any other `bench` binding here
    would shadow it (S3 §12.13 -- the Typer group is `bench_app`)."""
    import swil_agent.cli.bench as bench_module

    assert vars(cli)["bench"] is bench_module


# ── logger names (S3 §12.16) ──────────────────────────────────────────────


def test_every_cli_module_keeps_the_pre_split_logger_names() -> None:
    assert compose.logger.name == "swil_agent.cli"
    assert compose.dream_logger.name == "swil_agent.cli.dream"
    assert run.logger.name == "swil_agent.cli"
    assert errors.logger.name == "swil_agent.cli"
    assert logs.logger.name == "swil_agent.cli"


def test_no_cli_module_names_its_logger_after_itself() -> None:
    """`getLogger(__name__)` in `cli/compose.py` would be
    `swil_agent.cli.compose`: it still routes to `auto-run.log`, but it is a
    new name for a record every grep and every `caplog` filter knows as
    `swil_agent.cli`. Every logger in the package is named explicitly."""
    offenders = [
        str(path.relative_to(PACKAGE))
        for path in (PACKAGE / "cli").glob("*.py")
        if "getLogger(__name__)" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


# Every logger the round logs must route, and the file each one's records
# land in under `cycle`'s filtered pair.
_ROUTES = [
    ("swil_agent.cli", logs.ACT_LOG_FILENAME),
    ("swil_agent.cli.dream", logs.DREAM_LOG_FILENAME),
    ("swil_agent.graph.nodes", logs.ACT_LOG_FILENAME),
    ("swil_agent.graph.cycle", logs.ACT_LOG_FILENAME),
    ("swil_agent.act.round", logs.ACT_LOG_FILENAME),
    ("swil_agent.act.executor", logs.ACT_LOG_FILENAME),
    ("swil_agent.round_id", logs.ACT_LOG_FILENAME),
    ("swil_agent.analysis.behavior_snapshot", logs.ACT_LOG_FILENAME),
    ("swil_agent.analysis.population_metric", logs.ACT_LOG_FILENAME),
    ("swil_agent.dream.round", logs.DREAM_LOG_FILENAME),
    ("swil_agent.dream.candidate", logs.DREAM_LOG_FILENAME),
    ("swil_agent.embedder.guard", logs.DREAM_LOG_FILENAME),
]


@pytest.fixture
def cycle_logs(tmp_path: Path) -> Path:
    handlers = logs.attach_cycle_logs(Settings(agent_root=tmp_path))
    assert len(handlers) == 2
    yield tmp_path / "logs"
    # Detach so the next test's attachment starts clean.
    logs._attach_round_logs(Settings(agent_root=tmp_path / "detached"), ())


@pytest.mark.parametrize(("logger_name", "filename"), _ROUTES)
def test_one_record_per_logger_lands_in_its_phase_file(
    cycle_logs: Path, logger_name: str, filename: str
) -> None:
    marker = f"ROUTE-{logger_name}"
    logging.getLogger(logger_name).warning(marker)
    for handler in logging.getLogger("swil_agent").handlers:
        handler.flush()
    other = logs.DREAM_LOG_FILENAME if filename == logs.ACT_LOG_FILENAME else logs.ACT_LOG_FILENAME
    assert marker in (cycle_logs / filename).read_text(encoding="utf-8")
    other_path = cycle_logs / other
    assert not other_path.exists() or marker not in other_path.read_text(encoding="utf-8")


def _log_lines(agent_root: Path, filename: str) -> list[str]:
    path = agent_root / "logs" / filename
    return path.read_text(encoding="utf-8").splitlines() if path.is_file() else []


_PERSONA = """---
username: zenith
display_name: 测试
model: claude:opus
board: ai
topics: [alpha]
era: 3
---
# 测试

一个测试用的账号。

## 最近
- 一件旧事
"""


@pytest.fixture
def agent_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture):
    monkeypatch.setenv("ERA_START", "2000-01-01T00:00:00Z")
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(_PERSONA, encoding="utf-8")
    (directory / "memory.md").write_text("2026-08-01 | act | did a thing\n", encoding="utf-8")
    _patch_cycle_seams(monkeypatch, tmp_path)
    # A real process runs at INFO (see test_cli.py's `round_log_level`).
    caplog.set_level(logging.INFO)
    return tmp_path


def test_a_record_from_run_act_reaches_auto_run_log(agent_root: Path) -> None:
    """`run.act` logs `<name> — round <id>` on `swil_agent.cli`; `act`
    attaches one unfiltered `auto-run.log`."""
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "0"])
    assert result.exit_code == 0, result.output
    assert any("zenith — round " in line for line in _log_lines(agent_root, "auto-run.log"))
    assert _log_lines(agent_root, "dream.log") == []


def test_a_record_from_run_dream_reaches_dream_log(
    agent_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dream`'s embedder-down ERROR is `compose.dream_logger`'s
    (`swil_agent.cli.dream`); `dream` attaches one unfiltered `dream.log`."""
    from ._golden_seams import _FakeEmbedderClient

    monkeypatch.setattr(
        compose, "embedder_for", lambda settings: _FakeEmbedderClient(healthy=False)
    )
    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0, result.output
    assert any("embedder unreachable" in line for line in _log_lines(agent_root, "dream.log"))
    assert _log_lines(agent_root, "auto-run.log") == []


def test_a_cycles_round_line_from_run_stays_in_auto_run_log(agent_root: Path) -> None:
    """Under `cycle`'s filtered pair the same `swil_agent.cli` round line is
    an act-phase record, never a dream one."""
    result = runner.invoke(cli.app, ["cycle", "zenith", "--dry-run", "--seed", "0"])
    assert result.exit_code == 0, result.output
    assert any("zenith — round " in line for line in _log_lines(agent_root, "auto-run.log"))
    assert not any("— round " in line for line in _log_lines(agent_root, "dream.log"))


# ── layering (S3 §12.14) ──────────────────────────────────────────────────


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            found.update(f"{node.module}.{alias.name}" for alias in node.names)
    return found


@pytest.mark.parametrize(
    "module",
    ["policy.py", "round_id.py", "doctor.py", "analysis/measure_status.py", "llm/remedy.py"],
)
def test_the_moved_business_logic_imports_neither_typer_nor_the_cli(module: str) -> None:
    imported = _imports(PACKAGE / module)
    assert not any(name == "typer" or name.startswith("typer.") for name in imported), imported
    assert not any(name.startswith("swil_agent.cli") for name in imported), imported


def test_round_id_stays_pure() -> None:
    """Callables and `now` are passed in: no checkpoint layer, no graph."""
    imported = _imports(PACKAGE / "round_id.py")
    assert not any(name.startswith(("swil_agent.graph", "sqlite3")) for name in imported)


def test_the_stores_module_owns_no_filenames_of_its_own() -> None:
    from swil_agent.graph.checkpoint import CHECKPOINT_DB_NAME
    from swil_agent.locks.lease import LEASE_DB_NAME

    assert stores.LEASE_DB_NAME == LEASE_DB_NAME == "run_leases.sqlite"
    assert stores.CHECKPOINT_DB_NAME == CHECKPOINT_DB_NAME == "cycle_checkpoints.sqlite"
