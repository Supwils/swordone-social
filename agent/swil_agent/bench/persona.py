"""Which persona the bench replays, and the three texts it takes from it.

A port of `benchmark-run.sh:42-74`, line for line, because each of these texts
feeds a score whose series predates the port:

  * the **system prompt** the model under test receives;
  * the **reference text** fidelity is measured against (and the judge reads);
  * the **raw file**, which the rule regexes match (`grep ... "$PFILE"` read the
    file itself, frontmatter included -- not the stripped body).

A v2 (Era 3) file starts with a YAML frontmatter block. The model under test
must never see it: it names that model (`model: claude:claude-opus-5-5`). So a
v2 file is BOM- and CR-stripped and its frontmatter dropped, exactly as the
Bash `sed | tr | awk` pipeline did. A v1 (Era 2, sealed) file has no
frontmatter and is used raw -- BOM and CRs included -- also as Bash did; only
the trailing newlines go, because `$(...)` dropped them.

These are deliberately NOT `persona/loader.py`: that loader is the gate that
keeps a sealed or malformed persona out of a round, and the bench exists to
replay sealed personas.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from swil_agent.bench.errors import EXIT_NO_ACTION, EXIT_NO_SUCH_ACCOUNT, EXIT_USAGE, BenchStop

# Era 3 accounts live in agents/; sealed Era 2 accounts in archive/era-2/.
PERSONA_ROOTS: Final = ("agents", "archive/era-2/agents", "archive/era-2/humans")
PERSONALITY_FILENAME: Final = "personality.md"
API_KEY_FILENAME: Final = "api_key.txt"

# Fidelity reference = the persona's IDENTITY + VOICE slice (everything before
# the operational "## 发帖节律" section), so the score asks "does the output
# sound like this persona", not "did it echo the rule list".
RHYTHM_HEADING: Final = "## 发帖节律"

# `benchmarkRunIngest.persona` (`bench.schemas.ts`). Checked before the name is
# joined into `agents/<name>` or `bench/results/<name>`, so `../x` can neither
# read outside the roster nor write outside the results.
PERSONA_NAME: Final = re.compile(r"^[a-zA-Z0-9_]{2,24}$")

_FENCE: Final = "---"
_BOM: Final = "﻿"
_V1_DISPLAY: Final = re.compile(r"^- \*\*Display Name:\*\*", re.IGNORECASE)
_V1_DISPLAY_PREFIX: Final = re.compile(r".*\*\* ")
_V2_DISPLAY_KEY: Final = re.compile(r"^display_name:[ ]*")
_EDGE_QUOTE: Final = re.compile(r"^[\"']|[\"']$")


@dataclass(frozen=True)
class BenchPersona:
    """One persona as the bench uses it. `raw` is the file as decoded, with
    nothing stripped -- the rule regexes' input."""

    name: str
    directory: Path
    raw: str
    system: str
    reference: str
    display: str


def check_persona_name(name: str) -> None:
    """Refuse (64) a name the server would refuse, before any path or LLM call."""
    if not PERSONA_NAME.fullmatch(name):
        raise BenchStop(
            EXIT_USAGE, f"bench: persona {name!r} is not a valid name ({PERSONA_NAME.pattern})"
        )


def find_persona_dir(agent_root: Path, name: str) -> Path | None:
    """The first of `agents/<name>`, `archive/era-2/agents/<name>`,
    `archive/era-2/humans/<name>` that is a directory (Bash `-d`)."""
    for base in PERSONA_ROOTS:
        candidate = agent_root / base / name
        if candidate.is_dir():
            return candidate
    return None


def is_v2(raw: str) -> bool:
    """A v2 persona's first line, after the BOM and CRs go, is exactly `---`."""
    return _v2_text(raw).split("\n", 1)[0] == _FENCE


def _v2_text(raw: str) -> str:
    """`PTEXT`: the BOM dropped from the start, every CR deleted (`tr -d
    '\\r'`), trailing newlines gone (`$(...)`)."""
    return raw.removeprefix(_BOM).replace("\r", "").rstrip("\n")


def system_prompt(raw: str) -> str:
    """`SYS`: a v2 file without its frontmatter, a v1 file as it is.

    The frontmatter walk is the Bash `awk`: line 1 `---` opens it, the next
    `---` closes it, and every later line -- another `---` included -- is
    body. An unclosed frontmatter swallows the whole file, as it did there.
    """
    if not is_v2(raw):
        return raw.rstrip("\n")
    body: list[str] = []
    in_frontmatter = False
    for number, line in enumerate(_v2_text(raw).split("\n"), start=1):
        if number == 1 and line == _FENCE:
            in_frontmatter = True
            continue
        if in_frontmatter and line == _FENCE:
            in_frontmatter = False
            continue
        if not in_frontmatter:
            body.append(line)
    return "\n".join(body).rstrip("\n")


def display_name(raw: str) -> str:
    """`personaDisplay`: v2 from the frontmatter's `display_name:` line (one
    leading and one trailing quote dropped, as the Bash `gsub` did); v1 from
    the first case-insensitive `- **Display Name:**` bullet, cut after its
    last `** ` and CR-stripped. `""` when neither is there."""
    if is_v2(raw):
        for line in _v2_text(raw).split("\n")[1:]:
            if line == _FENCE:
                break
            if line.startswith("display_name:"):
                return _EDGE_QUOTE.sub("", _V2_DISPLAY_KEY.sub("", line, count=1))
        return ""
    for line in raw.split("\n"):
        if _V1_DISPLAY.match(line):
            return _V1_DISPLAY_PREFIX.sub("", line, count=1).replace("\r", "")
    return ""


def reference_text(system: str) -> str:
    """`REF_TEXT`: every line of the system prompt before the first line that
    starts with `## 发帖节律` (the whole prompt when there is none)."""
    lines: list[str] = []
    for line in system.split("\n"):
        if line.startswith(RHYTHM_HEADING):
            break
        lines.append(line)
    return "\n".join(lines).rstrip("\n")


def load_bench_persona(agent_root: Path, name: str) -> BenchPersona:
    """Resolve and read one persona. No directory -> exit 66; a directory
    without `personality.md` or `api_key.txt` (the POST needs the key) -> 75.
    Bash exited 1 for all three (S3 §12.21). A name the server's regex
    refuses is 64."""
    check_persona_name(name)
    directory = find_persona_dir(agent_root, name)
    if directory is None:
        raise BenchStop(EXIT_NO_SUCH_ACCOUNT, f"bench: persona '{name}' not found")
    path = directory / PERSONALITY_FILENAME
    if not path.is_file():
        raise BenchStop(EXIT_NO_ACTION, f"bench: no {PERSONALITY_FILENAME} for {name}")
    if not (directory / API_KEY_FILENAME).is_file():
        raise BenchStop(EXIT_NO_ACTION, f"bench: no {API_KEY_FILENAME} for {name} (needed to POST)")
    # `errors="replace"`: Bash never decoded the file at all, so a stray
    # invalid byte must not stop a run it would have completed.
    raw = path.read_bytes().decode("utf-8", errors="replace")
    system = system_prompt(raw)
    return BenchPersona(
        name=name,
        directory=directory,
        raw=raw,
        system=system,
        reference=reference_text(system),
        display=display_name(raw),
    )
