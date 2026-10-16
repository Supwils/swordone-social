"""The limits of persona format v2, as human-readable failures.

`load_persona` raises on the frontmatter, card and size checks; an over-limit
`## 最近` is clamped on load instead, because the dream rewrites that list
every round and a hand edit there must not stop an account from running.
`validate_persona_text` reports all of them, for `register` and for authors.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from swil_agent.llm.selection import KNOWN_BACKENDS
from swil_agent.persona.format import (
    MAX_CARD_CHARS,
    MAX_FILE_BYTES,
    MAX_RECENT_CHARS,
    MAX_RECENT_ITEMS,
    PersonaFormatError,
    parse_persona,
)

ERA = 3
REQUIRED_KEYS = ("username", "display_name", "model", "board", "topics", "era")
_STRING_KEYS = ("username", "display_name", "model", "board")


def _is_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def meta_problems(meta: Mapping[str, Any]) -> list[str]:
    problems: list[str] = []
    missing = [key for key in REQUIRED_KEYS if meta.get(key) is None or meta.get(key) == ""]
    if missing:
        problems.append(f"frontmatter is missing required keys: {', '.join(missing)}")

    for key in _STRING_KEYS:
        if key not in missing and not _is_text(meta[key]):
            problems.append(f"frontmatter '{key}' must be a non-empty string")
    if meta.get("bio") is not None and not isinstance(meta["bio"], str):
        problems.append("frontmatter 'bio' must be a string")

    if "model" not in missing and _is_text(meta["model"]):
        backend = str(meta["model"]).split(":", 1)[0].strip()
        if not backend:
            problems.append("frontmatter 'model' must start with a backend (backend:model)")
        elif backend.lower().replace("-", "_") not in KNOWN_BACKENDS:
            # A typo here used to run the account on claude, silently: the
            # arm's model family is the experiment's independent variable.
            problems.append(
                f"frontmatter 'model' backend {backend!r} is not one of "
                f"{', '.join(sorted(KNOWN_BACKENDS))}"
            )

    if "topics" not in missing:
        topics = meta["topics"]
        if not isinstance(topics, list) or not all(_is_text(t) for t in topics):
            problems.append("frontmatter 'topics' must be a list of strings")
        elif not topics:
            problems.append("frontmatter 'topics' must have at least one entry")

    if "era" not in missing:
        era = meta["era"]
        if type(era) is not int or era != ERA:
            problems.append(f"frontmatter 'era' must be {ERA}, got {era!r}")
    return problems


def card_problems(card: str) -> list[str]:
    if not card:
        return ["card is empty"]
    if len(card) > MAX_CARD_CHARS:
        return [f"card is {len(card)} code points (max {MAX_CARD_CHARS})"]
    return []


def recent_problems(recent: Sequence[str]) -> list[str]:
    problems: list[str] = []
    if len(recent) > MAX_RECENT_ITEMS:
        problems.append(f"最近 has {len(recent)} items (max {MAX_RECENT_ITEMS})")
    problems.extend(
        f"最近 item {i} is {len(item)} code points (max {MAX_RECENT_CHARS})"
        for i, item in enumerate(recent, start=1)
        if len(item) > MAX_RECENT_CHARS
    )
    return problems


def size_problems(size: int) -> list[str]:
    if size > MAX_FILE_BYTES:
        return [f"file is {size} bytes (max {MAX_FILE_BYTES})"]
    return []


def validate_persona_text(text: str) -> list[str]:
    """Every way `text` fails persona format v2; empty when it is valid."""
    problems = size_problems(len(text.encode("utf-8")))
    try:
        doc = parse_persona(text)
    except PersonaFormatError as exc:
        return [*problems, str(exc)]
    return [
        *problems,
        *meta_problems(doc.meta),
        *card_problems(doc.card),
        *recent_problems(doc.recent),
    ]
