"""Persona format v2: YAML frontmatter + immutable card + bounded `## 最近` list.

```
---
username: xiaoman            # configuration, parsed by code, never model-written
...
---
# 小满
(card: who they are -- the era's anchor, never rewritten)

## 最近
- (<= 5 items x 60 code points, maintained by the dream)
```

The model only ever sees `prompt_text` (card + 最近). The dream only ever
supplies a new 最近 list; code reassembles the file around it.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import yaml

RECENT_HEADING = "## 最近"
MAX_CARD_CHARS = 600
MAX_RECENT_ITEMS = 5
MAX_RECENT_CHARS = 60
MAX_FILE_BYTES = 4096

_FENCE = "---"
_EMPTY_RECENT = "（暂无）"


class PersonaFormatError(ValueError):
    """A personality.md that is not a valid v2 persona."""


@dataclass(frozen=True)
class PersonaDoc:
    meta: dict[str, Any]
    card: str
    recent: tuple[str, ...]


def _normalise(text: str) -> str:
    return text.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n")


def _bullet_text(line: str) -> str | None:
    stripped = line.strip()
    if stripped == "-" or stripped.startswith("- "):
        return stripped[1:].strip() or None
    return None


def parse_persona(text: str) -> PersonaDoc:
    """Split a persona file into frontmatter, card and 最近.

    Raises `PersonaFormatError` when the frontmatter is missing, unclosed, not
    valid YAML or not a mapping. A missing `## 最近` heading is not an error:
    the whole body is the card and the list is empty.
    """
    lines = _normalise(text).split("\n")
    if lines[0].rstrip() != _FENCE:
        raise PersonaFormatError("missing YAML frontmatter (file must start with '---')")
    close = next((i for i in range(1, len(lines)) if lines[i].rstrip() == _FENCE), None)
    if close is None:
        raise PersonaFormatError("YAML frontmatter is never closed with '---'")
    try:
        meta = yaml.safe_load("\n".join(lines[1:close]))
    except yaml.YAMLError as exc:
        raise PersonaFormatError(f"invalid YAML frontmatter: {exc}") from exc
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        raise PersonaFormatError("YAML frontmatter must be a mapping")

    body = lines[close + 1 :]
    heading = next((i for i, line in enumerate(body) if line.rstrip() == RECENT_HEADING), None)
    if heading is None:
        return PersonaDoc(meta=meta, card="\n".join(body).strip(), recent=())
    recent = tuple(item for line in body[heading + 1 :] if (item := _bullet_text(line)) is not None)
    return PersonaDoc(meta=meta, card="\n".join(body[:heading]).strip(), recent=recent)


def _bullets(recent: Iterable[str]) -> str:
    return "".join(f"- {item}\n" for item in recent)


def render_persona(doc: PersonaDoc) -> str:
    frontmatter = yaml.safe_dump(doc.meta, allow_unicode=True, sort_keys=False)
    return (
        f"{_FENCE}\n{frontmatter}{_FENCE}\n{doc.card}\n\n{RECENT_HEADING}\n{_bullets(doc.recent)}"
    )


def clamp_recent(items: Iterable[str]) -> tuple[str, ...]:
    """Bring a 最近 list within limits: one line per item, no bullet marker,
    no empties, each <= 60 code points, at most 5 items (the first ones)."""
    out: list[str] = []
    for item in items:
        # Collapsing all whitespace keeps an item on one line, so it can never
        # inject a heading or a second bullet into the file.
        text = " ".join(item.split()).removeprefix("- ").strip()
        if not text or text == "-":
            continue
        out.append(text[:MAX_RECENT_CHARS].rstrip())
        if len(out) == MAX_RECENT_ITEMS:
            break
    return tuple(out)


def card_text(card: str) -> str:
    """The card as the act path embeds it (S2 §4): one leading `# ` heading
    line -- the display name -- and the blank lines after it removed, nothing
    else. The name is not who the account is, and it would pull every post
    that mentions it toward the card."""
    lines = card.split("\n")
    if not lines[0].startswith("# "):
        return card
    rest = lines[1:]
    while rest and not rest[0].strip():
        rest.pop(0)
    return "\n".join(rest)


def prompt_text(doc: PersonaDoc) -> str:
    """The persona as the model sees it: card + 最近, never the frontmatter."""
    bullets = _bullets(doc.recent).rstrip("\n") or _EMPTY_RECENT
    return f"{doc.card}\n\n{RECENT_HEADING}\n{bullets}"
