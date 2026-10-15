"""The dream's inputs and output: the cooldown gate, the group-memory digest,
the prompt that asks for a new 最近 list, and parsing the reply.

The model never sees or returns the whole persona file. It gets the persona
prompt (card + current 最近) as the system prompt and answers with a JSON list;
code clamps and writes it (`persona/source.py`'s `write_recent`).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any, Final, Protocol

from swil_agent.llm.runner import CompletionRequest
from swil_agent.models import CooldownDecision, Persona

# ── cooldown ────────────────────────────────────────────────────────────────

_DEFAULT_COOLDOWN_HOURS: Final = 12
_DEFAULT_MIN_NEW_MEMORIES: Final = 8

# The line the dream appends to memory.md when it lands. Memory lines carry a
# date but no time, so this line is also what orders same-day lines against
# the dream (`memories_since`).
DREAM_MEMORY_NOTE: Final = "dream | 最近已更新"

_MEMORY_DATE: Final = re.compile(r"^(\d{4}-\d{2}-\d{2}) \|")
_DATE_FORMAT: Final = "%Y-%m-%d"


class DreamState(Protocol):
    """Where the last dream's moment is recorded."""

    def last_dream_ts(self, name: str) -> int | None: ...

    def record_dream(self, name: str, *, at: int) -> None: ...


class FilesystemDreamState:
    """`DreamState` backed by `<state_dir>/last_dream_<name>` (epoch seconds)."""

    def __init__(self, state_dir: Path) -> None:
        self._dir = state_dir

    def last_dream_ts(self, name: str) -> int | None:
        path = self._dir / f"last_dream_{name}"
        if not path.is_file():
            return None
        try:
            return int(path.read_text(encoding="utf-8").strip())
        except ValueError:
            return None

    def record_dream(self, name: str, *, at: int) -> None:
        (self._dir / f"last_dream_{name}").write_text(str(at), encoding="utf-8")


def memories_since(memory_text: str, last_dream: datetime) -> int:
    """Count memory lines dated after `last_dream`.

    A line dated after the dream's day counts. A line dated the same day counts
    only when it comes after that day's last `dream |` line, the one marker
    that orders it against the dream. Undated lines never count. Because this
    reads dates rather than a line-count delta, rotating memory.md cannot make
    it negative.
    """
    day = last_dream.strftime(_DATE_FORMAT)
    lines = memory_text.splitlines()
    marker = f"{day} | dream |"
    after = max((i for i, line in enumerate(lines) if line.startswith(marker)), default=None)
    count = 0
    for i, line in enumerate(lines):
        match = _MEMORY_DATE.match(line)
        if match is None:
            continue
        date = match.group(1)
        if date > day or (date == day and after is not None and i > after):
            count += 1
    return count


def check_cooldown(
    state: DreamState,
    name: str,
    *,
    auto: bool,
    memory_text: str,
    now: datetime | None = None,
    cooldown_hours: int = _DEFAULT_COOLDOWN_HOURS,
    min_new_memories: int = _DEFAULT_MIN_NEW_MEMORIES,
) -> CooldownDecision:
    """Decide whether the account may dream now.

    Without `auto`, and for an account that never dreamed, it always may.
    Otherwise it may once `cooldown_hours` (floored) have passed, or earlier
    when at least `min_new_memories` memory lines are dated after the last
    dream. `reason` is empty for a silent proceed.
    """
    if not auto:
        return CooldownDecision(proceed=True)

    last_ts = state.last_dream_ts(name)
    if last_ts is None:
        return CooldownDecision(proceed=True)

    now_ts = int(now.timestamp()) if now is not None else int(time.time())
    hours = (now_ts - last_ts) // 3600
    if hours >= cooldown_hours:
        return CooldownDecision(proceed=True)

    new = memories_since(memory_text, datetime.fromtimestamp(last_ts))
    if new < min_new_memories:
        return CooldownDecision(
            proceed=False,
            reason=f"cooldown ({hours}h < {cooldown_hours}h, +{new} new memories)",
        )
    return CooldownDecision(
        proceed=True,
        override=True,
        reason=f"cooldown override: +{new} new memories since last dream",
    )


# ── group-memory digest ─────────────────────────────────────────────────────

_TOP_USERS: Final = 5
_COMMENT_TYPES: Final = frozenset({"comment", "reply", "mention"})


def group_memory_digest(notifications: list[dict[str, Any]]) -> str:
    """One line per account that interacted recently, top five by
    likes + 2 x comments (ties alphabetical). Follows render but carry no
    weight."""
    grouped: dict[str, dict[str, Any]] = {}
    for item in notifications:
        actor = item.get("actor")
        actor = actor if isinstance(actor, dict) else {}
        user = actor.get("username")
        if not isinstance(user, str) or not user:
            continue
        entry = grouped.setdefault(
            user,
            {"name": actor.get("displayName") or "", "likes": 0, "comments": 0, "follows": 0},
        )
        kind = item.get("type")
        if kind == "like":
            entry["likes"] += 1
        elif kind in _COMMENT_TYPES:
            entry["comments"] += 1
        elif kind == "follow":
            entry["follows"] += 1

    by_username = sorted(grouped.items(), key=lambda kv: kv[0])
    ranked = sorted(by_username, key=lambda kv: -(kv[1]["likes"] + kv[1]["comments"] * 2))

    lines: list[str] = []
    for user, data in ranked[:_TOP_USERS]:
        parts: list[str] = []
        if data["comments"] > 0:
            parts.append(f"{data['comments']} 条回应")
        if data["likes"] > 0:
            parts.append(f"{data['likes']} 次点赞")
        if data["follows"] > 0:
            parts.append("关注了你")
        lines.append(f"- @{user}（{data['name']}）：" + " / ".join(parts))
    return "\n".join(lines)


# ── the dream prompt ────────────────────────────────────────────────────────

DREAM_INSTRUCTION: Final = (
    "你刚过完一段时间。根据下面的近期记忆，写出你现在的「最近」：最多 5 条，"
    "每条一句话（不超过 60 字），可以是最近在意的事、心情、对某个人的看法。"
    "旧的不重要了就换掉。"
    '只输出 JSON：{"recent": ["…", "…"]}。不要改写你的人设，不要写方法论。'
)

_MEMORY_HEADING: Final = "# 近期记忆"
_GROUP_HEADING: Final = "# 最近和你有过互动的人"
_EMPTY: Final = "（暂无）"


def build_dream_prompt(
    persona: Persona, *, memory_tail: str, group_memory: str
) -> CompletionRequest:
    """System = the persona prompt (card + current 最近); user = the instruction,
    the memory tail and, when there is one, the group-interaction digest."""
    user = f"{DREAM_INSTRUCTION}\n\n{_MEMORY_HEADING}\n\n{memory_tail.strip() or _EMPTY}"
    if group_memory:
        user += f"\n\n{_GROUP_HEADING}\n\n{group_memory}"
    return CompletionRequest(system=persona.prompt, user=user, model=persona.model)


# ── parsing the reply ───────────────────────────────────────────────────────

# Bounds the scan below; a dream reply is a few hundred characters.
_MAX_REPLY_CHARS: Final = 16384


def _string_items(items: list[Any]) -> list[str] | None:
    """The string items of `items`, or `None` when there are none."""
    strings = [item for item in items if isinstance(item, str)]
    return strings or None


def _json_values(body: str) -> Iterator[Any]:
    """Every JSON value that starts at a `{` or `[` in `body`, in order."""
    decoder = json.JSONDecoder()
    for start, char in enumerate(body):
        if char not in "{[":
            continue
        try:
            value, _ = decoder.raw_decode(body, start)
        except json.JSONDecodeError:
            continue
        yield value


def parse_recent(text: str) -> list[str] | None:
    """Extract the new 最近 list from a dream reply.

    Accepts `{"recent": [...]}` or a bare JSON list, on its own, inside ```
    fences or surrounded by prose. Two passes: an object with a `recent` key
    wins over any bare list (prose often quotes the old list first); a bare
    list is the fallback. An object whose `recent` is not a list decides the
    reply as unparseable. Non-string items are dropped, and a list left empty
    is skipped -- an empty 最近 is never written, so `[]` alone yields `None`
    and the dream keeps the current list. Lengths are enforced later
    (`clamp_recent`).
    """
    body = text[:_MAX_REPLY_CHARS]
    for value in _json_values(body):
        if not isinstance(value, dict) or "recent" not in value:
            continue
        recent = value["recent"]
        if not isinstance(recent, list):
            return None
        items = _string_items(recent)
        if items is not None:
            return items
    for value in _json_values(body):
        if isinstance(value, list):
            items = _string_items(value)
            if items is not None:
                return items
    return None
