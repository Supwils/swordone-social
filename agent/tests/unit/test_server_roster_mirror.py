"""The server's hand-written roster (lab/roster.ts) must mirror the persona frontmatter.

`server/src/modules/agents/lab/roster.ts` keys every Era 3 metric by arm and board, and it
is retyped from `agent/agents/*/personality.md` rather than generated. Nothing compared the
two, so a persona moved to another board (or a model string retyped on one side) would
silently mislabel the arms report. Read-only: parses both files, changes neither.
"""

from __future__ import annotations

import re
from pathlib import Path

from swil_agent.persona.format import parse_persona

AGENT_ROOT = Path(__file__).resolve().parents[2]
ROSTER_DIR = AGENT_ROOT / "agents"
ROSTER_TS = AGENT_ROOT.parent / "server" / "src" / "modules" / "agents" / "lab" / "roster.ts"

_KEY = r"(?:'(?P<q>[\w-]+)'|(?P<b>[\w-]+))"
_ARM_ROW = re.compile(
    _KEY + r":\s*\{\s*model:\s*'(?P<model>[^']+)',\s*usernames:\s*\[(?P<names>[^\]]*)\]",
    re.S,
)
_BOARD_ROW = re.compile(_KEY + r":\s*\[(?P<names>[^\]]*)\]", re.S)
_NAME = re.compile(r"'([^']+)'")


def _block(source: str, start: str) -> str:
    """The object literal that follows `start` up to its closing `};`."""
    head = source.index(start)
    return source[head : source.index("};", head)]


def _key(m: re.Match[str]) -> str:
    return m.group("q") or m.group("b")


def _server_roster() -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    """(username -> (arm id, model), username -> board) as roster.ts declares them."""
    source = ROSTER_TS.read_text(encoding="utf-8")
    arms: dict[str, tuple[str, str]] = {}
    for m in _ARM_ROW.finditer(_block(source, "const ARM_ROWS")):
        for name in _NAME.findall(m.group("names")):
            assert name not in arms, f"{name} is in two arms in roster.ts"
            arms[name] = (_key(m), m.group("model"))
    boards: dict[str, str] = {}
    for m in _BOARD_ROW.finditer(_block(source, "export const BOARDS")):
        for name in _NAME.findall(m.group("names")):
            assert name not in boards, f"{name} is on two boards in roster.ts"
            boards[name] = _key(m)
    return arms, boards


def _frontmatter() -> dict[str, tuple[str, str]]:
    """username -> (model, board) from every persona file."""
    out: dict[str, tuple[str, str]] = {}
    for d in sorted(p for p in ROSTER_DIR.iterdir() if p.is_dir()):
        meta = parse_persona((d / "personality.md").read_text(encoding="utf-8")).meta
        out[str(meta["username"])] = (str(meta["model"]), str(meta["board"]))
    return out


def test_parser_reads_the_whole_roster() -> None:
    # Guards the regexes: a reformatted roster.ts must fail loudly, not compare nothing.
    arms, boards = _server_roster()
    assert len(arms) == 20
    assert len({arm for arm, _ in arms.values()}) == 5
    assert set(boards) == set(arms)


def test_roster_ts_matches_persona_frontmatter() -> None:
    arms, boards = _server_roster()
    personas = _frontmatter()

    assert set(personas) == set(arms), "roster.ts and agent/agents/ name different accounts"
    for username, (model, board) in personas.items():
        assert arms[username][1] == model, (username, arms[username], model)
        assert boards[username] == board, (username, boards[username], board)
