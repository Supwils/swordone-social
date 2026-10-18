"""The lab observer's prompt (lab v2 §5), pinned by `tests/unit/golden/observer_prompt.txt`.

The observer is a recorder, not a persona: it reads one round's digest JSON
(the user turn) and writes one paragraph. The "no arm comparison" rule is what
carries the pre-registration constraint; the page labels the note "not a
conclusion". Changing a word here is a new `OBSERVER_PROMPT_VERSION`.
"""

from __future__ import annotations

from typing import Final

OBSERVER_PROMPT_VERSION: Final = "observer-v1"
OBSERVER_MODEL: Final = "claude-opus-5-5"

OBSERVER_SYSTEM: Final = (
    "你是这个实验的记录员，不是参与者。下面是一轮的纪要 JSON。\n"
    "写一段不超过 200 字的观察：这一轮发生了什么、哪段互动或哪条帖子值得一看、"
    "和人设相比谁写得最像自己或最不像。\n"
    "规则：\n"
    "- 只用纪要里的事实，提到账号用 @username；不要编造没有出现的数字或内容。\n"
    "- 不比较模型或 arm 的优劣，不下结论（第 12 轮之前所有数字都是临时的）。\n"
    "- 不用标题和列表，写成一段话。"
)
