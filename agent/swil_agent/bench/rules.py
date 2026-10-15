"""The deterministic halves of a bench score: output cleanup, rules, fidelity.

Pure functions, each a port of one piece of `benchmark-run.sh` (line numbers
are the deleted script's). The regexes are copied verbatim; changing one would
silently re-score every persona that states the rule.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from swil_agent.llm.extract import collapse_doubled_text

# `:104` / `:108` -- matched against the RAW personality.md, frontmatter included.
NO_EXCLAMATION_RULE: Final = re.compile(r"不用感叹号|不要感叹号|永远不用感叹号|no exclamation")
HASHTAG_RULE: Final = re.compile(r"必须用 ?hashtag|必须 ?hashtag|必须用#|要用 ?hashtag")
_EXCLAMATION: Final = re.compile(r"[!！]")

# What `sed`'s `[[:space:]]` strips under the UTF-8 locale this ran in (macOS,
# measured 2026-10-14 against every code point Python calls whitespace): all of
# Python's `str.isspace()` set except U+001C-U+001F and U+0085 -- and `\n`,
# which is the line separator, not line content. U+3000 (the ideographic space
# a Chinese paragraph indent uses) IS stripped. A bare `str.strip()` would
# also take the five control characters; ASCII-only would keep U+3000.
_SED_SPACE: Final = "".join(
    chr(code)
    for code in (
        *(0x09, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000),
    )
)


def clean_output(raw: str) -> str:
    """The model's answer as the row records it (`:143-146`).

    `$(...)` around `llm_text` dropped the trailing newlines before the
    doubled-text collapse ran, so the collapse sees the same string it did in
    Bash (S3 §12.20 -- `complete_text` would collapse the raw stdout, newline
    included, and miss an `X\\nX\\n` double). Then every LINE is trimmed
    (`sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'`), not just the
    ends, and the outer `$(...)` drops the trailing newlines once more.
    `""` means "skip this run".
    """
    text = collapse_doubled_text(raw.rstrip("\n")).rstrip("\n")
    return "\n".join(line.strip(_SED_SPACE) for line in text.split("\n")).rstrip("\n")


@dataclass(frozen=True)
class RuleScore:
    """`score` is `None` (and `detail` `""`) when the persona states no rule
    this checks."""

    score: float | None
    detail: str


def rule_score(raw_persona: str, output: str) -> RuleScore:
    """`rule_check` (`:102-115`): the share of applicable rules the output
    keeps, `round(passed / applied, 3)`, with `no_excl:ok` / `hashtag:FAIL`
    style detail in rule order."""
    applied = 0
    passed = 0
    detail: list[str] = []
    if NO_EXCLAMATION_RULE.search(raw_persona):
        applied += 1
        if _EXCLAMATION.search(output):
            detail.append("no_excl:FAIL")
        else:
            detail.append("no_excl:ok")
            passed += 1
    if HASHTAG_RULE.search(raw_persona):
        applied += 1
        if "#" in output:
            detail.append("hashtag:ok")
            passed += 1
        else:
            detail.append("hashtag:FAIL")
    if applied == 0:
        return RuleScore(score=None, detail="")
    return RuleScore(score=round(passed / applied, 3), detail=" ".join(detail))


def vector_fidelity(reference: Sequence[float], output: Sequence[float]) -> float:
    """`:154`: the dot product of two bge-m3 vectors, which the daemon
    returns unit-length -- so this IS their cosine -- rounded to 6 places.
    Not strict on length, like the Bash `zip`."""
    return round(sum(a * b for a, b in zip(reference, output, strict=False)), 6)
