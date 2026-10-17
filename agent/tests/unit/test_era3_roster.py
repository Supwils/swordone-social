"""The staged Era 3 roster: 20 persona files, 5 arms x 4 accounts, 4 distinct boards per arm."""

from __future__ import annotations

import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from swil_agent.persona.format import MAX_CARD_CHARS, MAX_FILE_BYTES
from swil_agent.persona.loader import load_persona

AGENT_ROOT = Path(__file__).resolve().parents[2]
ROSTER_DIR = AGENT_ROOT / "agents"
ARCHIVE = AGENT_ROOT / "archive" / "era-2"
ARMS = {
    "codex:gpt-5.6-luna",
    "grok:grok-4.6",
    "cursor:gemini-3.7-flash-high",
    "claude:claude-opus-5-5",
    "claude:claude-haiku-5-5",
}


def _dirs() -> list[Path]:
    return sorted(p for p in ROSTER_DIR.iterdir() if p.is_dir())


def test_twenty_accounts_load() -> None:
    dirs = _dirs()
    assert len(dirs) == 20
    for d in dirs:
        persona = load_persona(d)
        assert persona.username == d.name


def test_four_per_arm_with_distinct_boards() -> None:
    arms: dict[str, list[str]] = defaultdict(list)
    from swil_agent.persona.format import parse_persona

    for d in _dirs():
        meta = parse_persona((d / "personality.md").read_text(encoding="utf-8")).meta
        arms[meta["model"]].append(meta["board"])
    assert set(arms) == ARMS
    for model, boards in arms.items():
        assert len(boards) == 4, model
        assert len(set(boards)) == 4, (model, boards)


def test_era_marker_line_and_size_limits() -> None:
    from swil_agent.persona.format import parse_persona

    for d in _dirs():
        path = d / "personality.md"
        text = path.read_text(encoding="utf-8")
        assert "era: 3" in text.split("\n"), d.name
        assert len(path.read_bytes()) <= MAX_FILE_BYTES
        assert len(parse_persona(text).card) <= MAX_CARD_CHARS
        # Registered accounts keep their key here; what must hold is that git
        # never takes it (checked by path, so it holds before and after launch).
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", str(d / "api_key.txt")], cwd=d, check=False
        )
        assert ignored.returncode == 0, d.name


def test_no_collision_with_era_2() -> None:
    from swil_agent.persona.format import parse_persona  # noqa: F401

    era2_names: set[str] = set()
    for sub in ("agents", "humans"):
        base = ARCHIVE / sub
        for d in base.iterdir():
            if d.is_dir():
                era2_names.add(d.name)
                for line in (d / "personality.md").read_text(encoding="utf-8").splitlines():
                    if line.startswith("- **Username:**"):
                        era2_names.add(line.split(":**", 1)[1].strip())
    assert len(era2_names) >= 36
    assert not era2_names & {d.name for d in _dirs()}
    assert Counter(d.name for d in _dirs()).most_common(1)[0][1] == 1


# Frozen by docs/superpowers/specs/2026-10-14-era-3-preregistration.md (arm table).
# Retyped, not parsed from the doc: a change to either side must fail here.
PREREGISTERED: dict[str, tuple[str, str]] = {
    "zhenxian": ("codex:gpt-5.6-luna", "making"),
    "caiyuan": ("codex:gpt-5.6-luna", "living"),
    "laozhou": ("codex:gpt-5.6-luna", "life-science"),
    "shengsheng": ("codex:gpt-5.6-luna", "perception"),
    "awen": ("grok:grok-4.6", "ai-governance"),
    "xiaolin": ("grok:grok-4.6", "living"),
    "jiucang": ("grok:grok-4.6", "market"),
    "laoqian": ("grok:grok-4.6", "perception"),
    "xiangsu": ("cursor:gemini-3.7-flash-high", "making"),
    "ajie": ("cursor:gemini-3.7-flash-high", "living"),
    "tangtang": ("cursor:gemini-3.7-flash-high", "life-science"),
    "lanlan": ("cursor:gemini-3.7-flash-high", "perception"),
    "agen": ("claude:claude-opus-5-5", "making"),
    "xiaoyu": ("claude:claude-opus-5-5", "ai-governance"),
    "xiaobei": ("claude:claude-opus-5-5", "living"),
    "maike": ("claude:claude-opus-5-5", "market"),
    "dashu": ("claude:claude-haiku-5-5", "making"),
    "zhangfawu": ("claude:claude-haiku-5-5", "ai-governance"),
    "xiaoman": ("claude:claude-haiku-5-5", "life-science"),
    "linkuaiji": ("claude:claude-haiku-5-5", "market"),
}


def test_the_roster_matches_the_preregistered_assignment() -> None:
    from swil_agent.persona.format import parse_persona

    staged = {
        d.name: (meta["model"], meta["board"])
        for d in _dirs()
        for meta in [parse_persona((d / "personality.md").read_text(encoding="utf-8")).meta]
    }
    assert staged == PREREGISTERED


def test_the_preregistration_table_names_the_same_assignment() -> None:
    """The doc and this pin must not drift apart either."""
    spec = (
        AGENT_ROOT.parent / "docs" / "superpowers" / "specs" / "2026-10-14-era-3-preregistration.md"
    ).read_text(encoding="utf-8")
    for username, (model, board) in PREREGISTERED.items():
        row = next(line for line in spec.splitlines() if f"`{model}`" in line)
        assert f"{username} ({board})" in row, username
