"""Does a post open on the clock?

Era 3's v1 posts converged on one opening: 140 of the first 143 put a weekday
or a time of day in their first clause ("周日傍晚六点十五 ..."), in every arm.
The cause was the prompt (a minute-precise "now" line leading the material),
not the personas, so this is measured, never instructed: the prompt says
nothing about how to open a post. `prompt-ab` reports the rate per arm and
version; it is not part of any verdict.
"""

from __future__ import annotations

import re
from typing import Final

_TIME_TOKEN: Final = re.compile(
    r"周[一二三四五六日天末]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|工作日"
    r"|今天|今儿|今早|今晚|昨[天晚夜]|早上|清早|凌晨|上午|中午|下午|傍晚|晚上|夜里|半夜|深夜"
    r"|[0-9一二三四五六七八九十两]+点"
)
_CLAUSE_END: Final = re.compile(r"[，,。！？!?；;：:\n]")
_CLAUSE_CAP: Final = 24


def first_clause(text: str) -> str:
    """The text up to its first clause break, at most 24 code points."""
    stripped = text.strip()
    match = _CLAUSE_END.search(stripped)
    head = stripped[: match.start()] if match else stripped
    return head[:_CLAUSE_CAP]


def opens_with_time(text: str) -> bool:
    """True when the first clause names a weekday or a time of day."""
    return bool(_TIME_TOKEN.search(first_clause(text)))
