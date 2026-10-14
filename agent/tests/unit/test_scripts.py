"""Shell scripts under `agent/scripts/`: syntax and the Era 3 roster rule."""

from __future__ import annotations

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


_V2_PERSONA = (
    "---\nusername: aa\ndisplay_name: 阿甲\nmodel: claude:claude-opus-5-5\n"
    "board: making\nera: 3\n---\n# 阿甲\n\n一段人设。\n\n## 最近\n- 一条\n"
)


@pytest.mark.parametrize(
    "raw",
    [
        _V2_PERSONA.encode(),
        _V2_PERSONA.replace("\n", "\r\n").encode(),
        b"\xef\xbb\xbf" + _V2_PERSONA.encode(),
    ],
    ids=["lf", "crlf", "bom"],
)
def test_benchmark_system_prompt_carries_no_frontmatter(tmp_path: Path, raw: bytes) -> None:
    """The bench's SYS must never name the model under test."""
    text = (SCRIPTS / "benchmark-run.sh").read_text(encoding="utf-8")
    block = text[text.index('PTEXT="') : text.index('SYS="$PBODY"') + len('SYS="$PBODY"')]
    persona = tmp_path / "personality.md"
    persona.write_bytes(raw)
    result = subprocess.run(
        ["bash", "-c", block + '\nprintf "%s\\n===\\n%s" "$DISPLAY" "$SYS"'],
        capture_output=True,
        text=True,
        timeout=30,
        env={"PFILE": str(persona), "PATH": "/usr/bin:/bin"},
    )
    assert result.returncode == 0, result.stderr
    display, system = result.stdout.split("\n===\n")
    assert display == "阿甲"
    assert system.startswith("# 阿甲")
    for leak in ("---", "model:", "claude-opus", "username:", "\r", "﻿"):
        assert leak not in system
    assert "## 最近\n- 一条" in system
