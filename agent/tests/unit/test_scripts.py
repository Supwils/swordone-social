"""Shell scripts under `agent/scripts/`: syntax and the Era 3 roster rule."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
RETIRED = (
    "auto-run.sh",
    "dream.sh",
    "heartbeat.sh",
    "rotate-memory.sh",
    "rule-check.sh",
    "behavior-snapshot.sh",
    "snapshot.sh",
    "population-metric.sh",
    "agent-summary.sh",
    "backfill-behavior.sh",
    "backfill-rule-check.sh",
    "backfill-snapshots.sh",
    "setup-humans.sh",
    "setup-agents.sh",
    "swil.sh",
    # The Persona Bench, ported to `swil-agent bench` in S3 (`bench/`).
    "llm.sh",
    "deepseek-env.sh",
    "benchmark-run.sh",
    "benchmark-all.sh",
    "llm-smoke.sh",
)


def _shell_scripts() -> list[Path]:
    return sorted(p for p in SCRIPTS.rglob("*.sh") if ".venv" not in p.parts)


@pytest.mark.parametrize("script", _shell_scripts(), ids=lambda p: str(p.relative_to(SCRIPTS)))
def test_every_shell_script_parses(script: Path) -> None:
    result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_retired_bash_runtime_is_gone() -> None:
    assert [name for name in RETIRED if (SCRIPTS / name).exists()] == []


def _agent_tree(tmp_path: Path) -> Path:
    """A copy of the scripts dir under a throwaway `agent/` with a mixed roster."""
    root = tmp_path / "agent"
    root.mkdir()
    (root / "scripts").symlink_to(SCRIPTS)
    for name, body in {
        "era3": "---\nusername: era3\nera: 3\n---\n# x\n",
        "era3crlf": "---\r\nusername: era3crlf\r\nera: 3\r\n---\r\n# x\r\n",
        "era2": "# x\n\n- **Username:** era2\n",
        "era30": "---\nera: 30\n---\n# x\n",
    }.items():
        (root / "agents" / name).mkdir(parents=True)
        (root / "agents" / name / "personality.md").write_bytes(body.encode())
    (root / "agents" / "empty").mkdir()
    (root / "humans" / "h").mkdir(parents=True)
    (root / "humans" / "h" / "personality.md").write_text("---\nera: 3\n---\n", encoding="utf-8")
    return root


def test_status_counts_only_era_3_agents(tmp_path: Path) -> None:
    root = _agent_tree(tmp_path)
    result = subprocess.run(
        ["bash", str(root / "scripts" / "opportunistic-round.sh"), "--status"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "roster     : 2 runnable account(s)" in result.stdout


_COMMIT_SECTION = "# ── 9. commit the round's output"
_ARCHIVE_GUARD = "git ls-files --error-unmatch agent/archive/era-2/boundary.json"
_SKIP_LINE = 'log "auto-commit skipped: Era 2 archive not committed yet"'


def test_auto_commit_is_guarded_by_the_committed_era_2_archive() -> None:
    """`git add agent/agents` must never run before the archive is tracked,
    or history records the Era 2 roster as deleted."""
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    section = text[text.index(_COMMIT_SECTION) :]
    assert _ARCHIVE_GUARD in section
    assert _SKIP_LINE in section
    assert section.index(_ARCHIVE_GUARD) < section.index("\n    git add agent/agents\n")


def test_auto_commit_skips_and_stages_nothing_while_the_archive_is_untracked(
    tmp_path: Path,
) -> None:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    section = text[text.index(_COMMIT_SECTION) :]
    repo = tmp_path / "repo"
    (repo / "agent" / "agents" / "a").mkdir(parents=True)
    (repo / "agent" / "agents" / "a" / "memory.md").write_text("x\n", encoding="utf-8")
    (repo / "agent" / "archive" / "era-2").mkdir(parents=True)
    (repo / "agent" / "archive" / "era-2" / "boundary.json").write_text("{}\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    prelude = 'log() { echo "$*"; }\nAUTO_COMMIT=1\nok=1; bad=0; timedout=0\n'
    result = subprocess.run(
        ["bash", "-c", prelude + section],
        capture_output=True,
        text=True,
        timeout=30,
        env={"REPO_DIR": str(repo), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
    )
    assert result.returncode == 0, result.stderr
    assert "auto-commit skipped: Era 2 archive not committed yet" in result.stdout
    staged = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--name-only"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert staged.stdout == ""


# ── prune-checkpoints.py: keeps the NEWEST rounds per account ──────────────


def _checkpoint_db(path: Path, threads: list[str]) -> None:
    import sqlite3

    con = sqlite3.connect(path)
    con.execute("CREATE TABLE checkpoints (thread_id TEXT)")
    con.execute("CREATE TABLE writes (thread_id TEXT)")
    con.executemany("INSERT INTO checkpoints VALUES (?)", [(t,) for t in threads])
    con.executemany("INSERT INTO writes VALUES (?)", [(t,) for t in threads])
    con.commit()
    con.close()


def _remaining(path: Path) -> list[str]:
    import sqlite3

    con = sqlite3.connect(path)
    try:
        return sorted(r[0] for r in con.execute("SELECT DISTINCT thread_id FROM checkpoints"))
    finally:
        con.close()


def test_prune_keeps_the_newest_of_mixed_sweep_manual_and_era_2_rounds(tmp_path: Path) -> None:
    """S2 ids lead with the UTC stamp, so `-r`/`-m` order by time; Era 2's
    suffixless keys rank below every S2 id, so they are pruned first even
    when their stamp is later."""
    db = tmp_path / "cycle.sqlite"
    _checkpoint_db(
        db,
        [
            "builtin:zenith:20991231T235959",
            "builtin:zenith:20261014T091500Z-r",
            "builtin:zenith:20261016T080000Z-m",
            "builtin:zenith:20261015T120000Z-r",
            "builtin:other:20261001T000000Z-r",
        ],
    )
    result = subprocess.run(
        ["python3", str(SCRIPTS / "prune-checkpoints.py"), "--db", str(db), "--keep", "2"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert _remaining(db) == [
        "builtin:other:20261001T000000Z-r",
        "builtin:zenith:20261015T120000Z-r",
        "builtin:zenith:20261016T080000Z-m",
    ]


def test_prunes_copy_of_the_round_id_regex_matches_the_package() -> None:
    from swil_agent.round_id import ROUND_ID_RE

    text = (SCRIPTS / "prune-checkpoints.py").read_text(encoding="utf-8")
    assert f'ROUND_ID_RE = re.compile(r"{ROUND_ID_RE.pattern}", re.ASCII)' in text


def test_prunes_regex_rejects_arabic_indic_digits() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "prune_checkpoints", SCRIPTS / "prune-checkpoints.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    arabic = (
        "\u0662\u0660\u0662\u0666\u0661\u0660\u0661\u0664T\u0660\u0669\u0661\u0665\u0660\u0660Z-r"
    )
    assert module.ROUND_ID_RE.fullmatch(arabic) is None
    assert module.ROUND_ID_RE.fullmatch("20261014T091500Z-r") is not None


# ── opportunistic-round.sh: one round id per sweep, shuffled order ─────────

_ROUND_HELPERS_START = "# ── round id and sweep order"
_ROUND_HELPERS_END = "# ── 1. interval gate"
_EXPORT_LINE = 'export SWIL_ROUND_ID="$(date -u +%Y%m%dT%H%M%SZ)-r"'


def _round_helpers() -> str:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    return text[text.index(_ROUND_HELPERS_START) : text.index(_ROUND_HELPERS_END)]


def _bash(snippet: str) -> str:
    result = subprocess.run(
        ["bash", "-c", _round_helpers() + snippet],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


_NAMES = [f"a{i:02d}" for i in range(20)]


def test_the_sweep_exports_one_round_id_before_any_worker_starts() -> None:
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    assert text.count("export SWIL_ROUND_ID=") == 1
    assert _EXPORT_LINE in text
    # Minted before the first worker is launched, and the order is logged.
    assert text.index(_EXPORT_LINE) < text.index('run_one "$name" &')
    assert 'log "round $SWIL_ROUND_ID' in text


def test_the_seed_is_derived_from_the_round_id() -> None:
    first = _bash('round_seed "20261014T091500Z-r"').strip()
    again = _bash('round_seed "20261014T091500Z-r"').strip()
    other = _bash('round_seed "20261016T091500Z-r"').strip()
    assert first.isdigit()
    assert first == again
    assert first != other


def test_the_shuffle_is_a_deterministic_permutation_per_seed() -> None:
    import random

    names = " ".join(_NAMES)
    first = _bash(f"shuffle_roster 12345 {names}").split()
    again = _bash(f"shuffle_roster 12345 {names}").split()
    other = _bash(f"shuffle_roster 54321 {names}").split()

    assert sorted(first) == _NAMES
    assert first == again
    assert first != other
    assert first != _NAMES
    # Reproducible from the logged seed alone, outside the script.
    expected = sorted(_NAMES)
    random.Random(12345).shuffle(expected)
    assert first == expected


def test_the_shuffle_ignores_input_order() -> None:
    forward = _bash(f"shuffle_roster 7 {' '.join(_NAMES)}").split()
    backward = _bash(f"shuffle_roster 7 {' '.join(reversed(_NAMES))}").split()
    assert forward == backward


def test_the_embedder_down_warning_names_era_3_consequences() -> None:
    """Era 3 has no drift gate. With the embedder down the duplicate guard
    fails open and post vectors go unfiled -- the log line says so and names
    the recovery command."""
    text = (SCRIPTS / "opportunistic-round.sh").read_text(encoding="utf-8")
    assert "drift gate" not in text
    assert (
        'log "WARN embedder would not start — the duplicate guard fails open and post '
        "vectors will be missing this round; recover them afterwards with: "
        'uv run --project agent swil-agent backfill-post-vectors"'
    ) in text
    # No backticks inside that double-quoted string: bash would RUN them.
    line = next(x for x in text.splitlines() if "embedder would not start" in x)
    assert "`" not in line


# ── shell entry points name real CLI commands and flags ────────────────────

_INVOCATION_RE = re.compile(r"swil-agent((?:[ \t]+[^\s|&;>]+)+)")


def _cli_tokens(text: str) -> list[tuple[str, list[str]]]:
    """(command, flags) for every `swil-agent <command> … --flag` in script text.

    Comment lines and prose mentions are skipped: only lines whose first
    word is `exec` / `uv` / `swil-agent` count as invocations.
    """
    found: list[tuple[str, list[str]]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#") or not re.match(r"(exec\s+)?(uv\s+run\b|swil-agent\b)", line):
            continue
        for match in _INVOCATION_RE.finditer(line):
            words = match.group(1).split()
            command = next((w for w in words if not w.startswith("-")), None)
            if command is None:
                continue
            found.append((command, [w for w in words if w.startswith("--")]))
    return found


def _unknown_cli_names(text: str) -> list[str]:
    import typer.main

    from swil_agent import cli

    root = typer.main.get_command(cli.app)
    commands = getattr(root, "commands", {})
    bad: list[str] = []
    for command, flags in _cli_tokens(text):
        sub = commands.get(command)
        if sub is None:
            bad.append(command)
            continue
        known = {opt for param in sub.params for opt in (*param.opts, *param.secondary_opts)}
        bad.extend(flag for flag in flags if flag not in known)
    return bad


@pytest.mark.parametrize("name", ["cycle-one.sh", "opportunistic-round.sh"])
def test_shell_entry_points_name_real_cli_commands_and_flags(name: str) -> None:
    text = (SCRIPTS / name).read_text(encoding="utf-8")
    assert _unknown_cli_names(text) == []


def test_cycle_one_actually_invokes_cycle_with_auto() -> None:
    text = (SCRIPTS / "cycle-one.sh").read_text(encoding="utf-8")
    assert ("cycle", ["--auto"]) in _cli_tokens(text)


def test_cli_name_check_rejects_a_bogus_command_or_flag() -> None:
    assert _unknown_cli_names("exec uv run --project x swil-agent cycl NAME --auto") == ["cycl"]
    assert _unknown_cli_names("exec uv run --project x swil-agent cycle NAME --bogus") == [
        "--bogus"
    ]
