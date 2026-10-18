"""Prompt v2's memory lines: `memory.md` entries rendered without ids.

`memory.md`'s on-disk format is unchanged -- the engaged list, retrieval and
the cooldown still read its ids; only the persona's view of it drops them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final, NamedTuple

_LINE: Final = re.compile(r"^\d{4}-(\d{2})-(\d{2}) \| ([A-Za-z_]+)(?: \|\s?(.*))?$")
_IDS: Final = re.compile(r"\b(?:id|postId|commentId|parentId|conversationId|messageId|echoOf)=\S*")
_HEX_ID: Final = re.compile(r"\b[0-9a-f]{24}\b")
_TO: Final = re.compile(r"\bto=(\S+)")
_IMAGE_TAG: Final = re.compile(r"^\[img:[^\]]*\]\s*")


class MemoryEntry(NamedTuple):
    day: str
    verb: str
    to: str
    text: str


def parse_memory_line(line: str) -> MemoryEntry | None:
    """One dated `memory.md` line, its ids stripped; `None` for an undated one."""
    match = _LINE.match(line.strip())
    if match is None:
        return None
    rest = match.group(4) or ""
    to = _TO.search(rest)
    parts = (_HEX_ID.sub("", _IDS.sub("", _TO.sub("", part))) for part in rest.split(" | "))
    text = " ".join(" ".join(part.split()) for part in parts if part.strip())
    return MemoryEntry(
        day=f"{match.group(1)}-{match.group(2)}",
        verb=match.group(3),
        to=to.group(1) if to else "",
        text=text,
    )


def render_memory_entry(entry: MemoryEntry) -> str:
    text = entry.text
    if entry.verb == "post":
        caption = _IMAGE_TAG.sub("", text)
        body = f"发帖：{caption}" if caption else "发帖"
    elif entry.verb == "comment":
        body = f"评论：{text}"
    elif entry.verb == "like":
        body = "点赞了一条帖子"
    elif entry.verb == "follow":
        body = f"关注了 {text}"
    elif entry.verb == "echo":
        body = f"转发了一条帖子：{text}" if text else "转发了一条帖子"
    elif entry.verb == "dm":
        body = f"私信 @{entry.to}：{text}" if entry.to else f"私信：{text}"
    elif entry.verb == "dream":
        body = "更新了「最近」"
    else:
        body = f"{entry.verb}：{text}" if text else entry.verb
    return f"{entry.day} {body}"


def render_memory_lines(lines: Iterable[str]) -> list[str]:
    """The act view: every dated line, id-free, in order."""
    return [
        render_memory_entry(entry)
        for line in lines
        if (entry := parse_memory_line(line)) is not None
    ]


def fold_memory_lines(lines: Iterable[str]) -> list[str]:
    """The dream view: like and follow lines become one count line at the end."""
    out: list[str] = []
    likes = follows = 0
    for line in lines:
        entry = parse_memory_line(line)
        if entry is None:
            continue
        if entry.verb == "like":
            likes += 1
        elif entry.verb == "follow":
            follows += 1
        else:
            out.append(render_memory_entry(entry))
    counts = [f"点赞 {likes} 次"] if likes else []
    if follows:
        counts.append(f"关注了 {follows} 个人")
    if counts:
        out.append("另外：" + "，".join(counts) + "。")
    return out
