"""Prompt v2's news block: the persona board's topics plus general, a summary
and at most three highlights each, content capped at 2,000 chars."""

from __future__ import annotations

import re
from typing import Final, NamedTuple

BOARD_NEWS_TOPICS: Final[dict[str, tuple[str, ...]]] = {
    "making": ("supply-chain", "auto-mobility"),
    "living": (),
    "life-science": ("science", "sports-health-nutrition"),
    "perception": ("gaming",),
    "ai-governance": ("ai-tech",),
    "market": ("finance", "crypto"),
}
GENERAL_TOPIC: Final = "general"
NEWS_HIGHLIGHT_LIMIT: Final = 3
NEWS_CHAR_CAP: Final = 2000

_TOPIC: Final = re.compile(r"^### \[([A-Za-z0-9_-]+)\]\s*(.*)$")


class NewsTopic(NamedTuple):
    title: str
    highlights: tuple[str, ...]
    takeaway: str


def parse_digest(text: str) -> dict[str, NewsTopic]:
    """`news_today.md` by topic: `### [topic] title`, `- ` highlights, `→ ` takeaway.
    Anything else (the placeholder, a malformed cache) parses to no topics."""
    blocks: list[tuple[str, str, list[str]]] = []
    for raw in text.splitlines():
        line = raw.strip()
        match = _TOPIC.match(line)
        if match:
            blocks.append((match.group(1), match.group(2).strip(), []))
        elif blocks and line:
            blocks[-1][2].append(line)
    topics: dict[str, NewsTopic] = {}
    for topic, title, lines in blocks:
        highlights = tuple(line[2:].strip() for line in lines if line.startswith("- "))
        takeaway = next((line[1:].strip() for line in lines if line.startswith("→")), "")
        topics.setdefault(topic, NewsTopic(title, highlights, takeaway))
    return topics


def news_topics_for(board: str) -> tuple[str, ...]:
    return (*BOARD_NEWS_TOPICS.get(board.strip(), ()), GENERAL_TOPIC)


def render_news(digest: str, board: str) -> list[str]:
    """The block's lines; `[]` when no mapped topic is in the digest."""
    parsed = parse_digest(digest)
    lines: list[str] = []
    used = 0
    for topic in news_topics_for(board):
        entry = parsed.get(topic)
        if entry is None:
            continue
        summary = entry.takeaway or entry.title
        block = [f"[{topic}] {summary}".rstrip()]
        block += [f"- {item}" for item in entry.highlights[:NEWS_HIGHLIGHT_LIMIT]]
        for line in block:
            cost = len(line) + (1 if lines else 0)
            if used + cost > NEWS_CHAR_CAP:
                if not lines:
                    lines.append(line[:NEWS_CHAR_CAP])
                return lines
            lines.append(line)
            used += cost
    return lines
