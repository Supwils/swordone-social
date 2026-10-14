"""Tests for `swil_agent.dream.candidate`: the cooldown gate, the group-memory
digest, the 最近 prompt and `parse_recent`."""

from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path
from typing import Any

from swil_agent.dream.candidate import (
    DREAM_INSTRUCTION,
    DREAM_MEMORY_NOTE,
    FilesystemDreamState,
    build_dream_prompt,
    check_cooldown,
    group_memory_digest,
    memories_since,
    parse_recent,
)

from ._runners import FakeState, make_persona

# A fixed local wall-clock moment for every cooldown test, so memory-line
# dates can be written relative to it.
NOW = datetime(2026, 10, 14, 20, 0, 0)


def _ts(moment: datetime) -> int:
    return int(moment.timestamp())


def _memory(*lines: str) -> str:
    return "".join(f"{line}\n" for line in lines)


def _n(user: str, kind: str, name: str | None = None) -> dict[str, Any]:
    return {"actor": {"username": user, "displayName": name or user.title()}, "type": kind}


# ── memories_since ───────────────────────────────────────────────────────────


def test_lines_dated_after_the_dream_day_count() -> None:
    text = _memory("2026-10-13 | post | a", "2026-10-14 | like | b", "2026-10-15 | like | c")
    assert memories_since(text, datetime(2026, 10, 13, 9, 0)) == 2


def test_same_day_lines_count_only_after_the_dreams_own_line() -> None:
    text = _memory(
        "2026-10-14 | post | before",
        f"2026-10-14 | {DREAM_MEMORY_NOTE}",
        "2026-10-14 | like | after-1",
        "2026-10-14 | comment | after-2",
    )
    assert memories_since(text, datetime(2026, 10, 14, 8, 0)) == 2


def test_same_day_lines_without_a_dream_line_do_not_count() -> None:
    """A date with no time cannot be ordered against the dream unless the
    dream's own line sits between them -- such lines are not counted."""
    text = _memory("2026-10-14 | post | a", "2026-10-14 | like | b")
    assert memories_since(text, datetime(2026, 10, 14, 8, 0)) == 0


def test_the_last_dream_line_of_the_day_is_the_one_that_orders() -> None:
    text = _memory(
        f"2026-10-14 | {DREAM_MEMORY_NOTE}",
        "2026-10-14 | like | between",
        "2026-10-14 | dream | personality consolidated",
        "2026-10-14 | like | after",
    )
    assert memories_since(text, datetime(2026, 10, 14, 8, 0)) == 1


def test_undated_lines_never_count() -> None:
    text = _memory("no date here", "2026-10-15 | post | a", "   ", "15-10-2026 | x")
    assert memories_since(text, datetime(2026, 10, 14, 8, 0)) == 1


def test_rotation_cannot_make_the_count_negative() -> None:
    """The count reads dates, not a line-count delta, so a memory file that
    shrank since the last dream (rotation) yields 0, never a negative."""
    assert memories_since("", datetime(2026, 10, 14, 8, 0)) == 0


# ── cooldown ─────────────────────────────────────────────────────────────────


def test_force_mode_never_cools_down() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(NOW) - 60)
    decision = check_cooldown(state, "zenith", auto=False, memory_text="", now=NOW)
    assert decision.proceed and decision.reason == ""


def test_a_first_ever_dream_proceeds() -> None:
    decision = check_cooldown(FakeState(), "zenith", auto=True, memory_text="", now=NOW)
    assert decision.proceed and not decision.override


def test_within_cooldown_and_too_few_new_memories_skips() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(datetime(2026, 10, 14, 12, 0)))
    text = _memory(f"2026-10-14 | {DREAM_MEMORY_NOTE}", *["2026-10-14 | like | x"] * 7)
    decision = check_cooldown(state, "zenith", auto=True, memory_text=text, now=NOW)
    assert not decision.proceed
    assert decision.reason == "cooldown (8h < 12h, +7 new memories)"


def test_enough_dated_memories_override_the_cooldown() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(datetime(2026, 10, 14, 12, 0)))
    text = _memory(f"2026-10-14 | {DREAM_MEMORY_NOTE}", *["2026-10-14 | like | x"] * 8)
    decision = check_cooldown(state, "zenith", auto=True, memory_text=text, now=NOW)
    assert decision.proceed and decision.override
    assert decision.reason == "cooldown override: +8 new memories since last dream"


def test_lines_written_before_the_dream_do_not_override() -> None:
    """The Era 2 rule counted a line-count delta, so lines that predate the
    dream could fire the override. Dated counting must not."""
    state = FakeState()
    state.set_last_dream(at=_ts(datetime(2026, 10, 14, 12, 0)))
    text = _memory(*["2026-10-13 | like | old"] * 20, f"2026-10-14 | {DREAM_MEMORY_NOTE}")
    decision = check_cooldown(state, "zenith", auto=True, memory_text=text, now=NOW)
    assert not decision.proceed


def test_an_elapsed_cooldown_proceeds_silently() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(NOW) - 12 * 3600)
    decision = check_cooldown(state, "zenith", auto=True, memory_text="", now=NOW)
    assert decision.proceed and decision.reason == "" and not decision.override


def test_hours_are_floored_not_rounded() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(NOW) - int(11.9 * 3600))
    decision = check_cooldown(state, "zenith", auto=True, memory_text="", now=NOW)
    assert not decision.proceed
    assert decision.reason.startswith("cooldown (11h < 12h")


def test_the_cooldown_settings_are_threaded() -> None:
    state = FakeState()
    state.set_last_dream(at=_ts(NOW) - 3 * 3600)
    text = _memory("2026-10-15 | like | a", "2026-10-15 | like | b")
    assert check_cooldown(
        state, "zenith", auto=True, memory_text="", now=NOW, cooldown_hours=2
    ).proceed
    assert check_cooldown(
        state, "zenith", auto=True, memory_text=text, now=NOW, min_new_memories=2
    ).override


def test_cooldown_defaults_to_the_wall_clock() -> None:
    state = FakeState()
    state.set_last_dream(at=int(time.time()) - 13 * 3600)
    assert check_cooldown(state, "zenith", auto=True, memory_text="").proceed


# ── FilesystemDreamState ─────────────────────────────────────────────────────


def test_filesystem_state_has_no_marker_for_a_never_dreamed_account(tmp_path: Path) -> None:
    assert FilesystemDreamState(tmp_path).last_dream_ts("zenith") is None


def test_record_dream_round_trips(tmp_path: Path) -> None:
    fs_state = FilesystemDreamState(tmp_path)
    fs_state.record_dream("zenith", at=1_700_000_000)
    assert fs_state.last_dream_ts("zenith") == 1_700_000_000
    assert (tmp_path / "last_dream_zenith").read_text(encoding="utf-8") == "1700000000"
    assert fs_state.last_dream_ts("other") is None


def test_filesystem_state_treats_a_corrupt_marker_as_absent(tmp_path: Path) -> None:
    (tmp_path / "last_dream_zenith").write_text("not-a-number", encoding="utf-8")
    assert FilesystemDreamState(tmp_path).last_dream_ts("zenith") is None


# ── group-memory digest ─────────────────────────────────────────────────────


def test_digest_sorts_by_likes_plus_double_comments() -> None:
    notifications = [*[_n("alpha", "like")] * 5, *[_n("beta", "comment")] * 3]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_follows_do_not_affect_the_sort_weight() -> None:
    notifications = [*[_n("alpha", "follow")] * 9, _n("beta", "like")]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_reply_and_mention_count_as_comments() -> None:
    assert "2 条回应" in group_memory_digest([_n("alpha", "reply"), _n("alpha", "mention")])


def test_digest_takes_at_most_five_users() -> None:
    notifications = [_n(f"user{i}", "like") for i in range(9)]
    assert len(group_memory_digest(notifications).splitlines()) == 5


def test_digest_renders_one_line_per_user() -> None:
    digest = group_memory_digest([_n("alpha", "follow"), _n("alpha", "like")])
    assert digest == "- @alpha（Alpha）：1 次点赞 / 关注了你"


def test_digest_skips_a_notification_with_no_usable_username() -> None:
    notifications = [{"actor": {"displayName": "Ghost"}, "type": "like"}, _n("alpha", "like")]
    assert group_memory_digest(notifications) == "- @alpha（Alpha）：1 次点赞"


def test_digest_orders_ties_alphabetically_by_username() -> None:
    notifications = [_n("zoo", "like"), _n("alpha", "like")]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @alpha")


def test_an_empty_notification_list_yields_an_empty_digest() -> None:
    assert group_memory_digest([]) == ""


# ── the dream prompt ─────────────────────────────────────────────────────────


def test_the_system_prompt_is_the_persona_prompt() -> None:
    persona = make_persona(prompt="卡片\n\n## 最近\n- 旧事", model="claude-haiku-5-5")
    req = build_dream_prompt(persona, memory_tail="m", group_memory="")
    assert req.system == "卡片\n\n## 最近\n- 旧事"
    assert req.model == "claude-haiku-5-5"


def test_the_user_prompt_carries_the_instruction_memory_and_group_memory() -> None:
    req = build_dream_prompt(
        make_persona(), memory_tail="2026-10-14 | post | 一件事", group_memory="- @alpha：1 次点赞"
    )
    assert req.user.startswith(DREAM_INSTRUCTION)
    assert "2026-10-14 | post | 一件事" in req.user
    assert "- @alpha：1 次点赞" in req.user
    assert req.user.index("2026-10-14 | post") < req.user.index("- @alpha")


def test_the_instruction_asks_for_a_bounded_json_list() -> None:
    assert "最多 5 条" in DREAM_INSTRUCTION
    assert "不超过 60 字" in DREAM_INSTRUCTION
    assert '{"recent": ["…", "…"]}' in DREAM_INSTRUCTION
    assert "不要改写你的人设" in DREAM_INSTRUCTION


def test_the_group_memory_section_vanishes_when_empty() -> None:
    with_group = build_dream_prompt(make_persona(), memory_tail="m", group_memory="- @a：x")
    without = build_dream_prompt(make_persona(), memory_tail="m", group_memory="")
    assert "互动" in with_group.user
    assert "互动" not in without.user


def test_an_empty_memory_still_renders_a_placeholder() -> None:
    req = build_dream_prompt(make_persona(), memory_tail="", group_memory="")
    assert "（暂无）" in req.user


# ── parse_recent ─────────────────────────────────────────────────────────────


def test_parse_recent_reads_a_clean_object() -> None:
    assert parse_recent('{"recent": ["一", "二"]}') == ["一", "二"]


def test_parse_recent_reads_a_bare_list() -> None:
    assert parse_recent('["一", "二"]') == ["一", "二"]


def test_parse_recent_reads_fenced_json() -> None:
    assert parse_recent('```json\n{"recent": ["一"]}\n```') == ["一"]


def test_parse_recent_reads_json_surrounded_by_prose() -> None:
    text = '好的，这是我的最近：\n{"recent": ["想起了夜班", "多肉又死了一盆"]}\n希望可以。'
    assert parse_recent(text) == ["想起了夜班", "多肉又死了一盆"]


def test_parse_recent_skips_bracketed_prose_before_the_json() -> None:
    assert parse_recent('[1] 以下 {"recent": ["一"]}') == ["一"]


def test_parse_recent_rejects_an_object_whose_recent_is_not_a_list() -> None:
    assert parse_recent('{"recent": "一件事"}') is None


def test_parse_recent_rejects_garbage() -> None:
    assert parse_recent("我今天不想写。") is None
    assert parse_recent("") is None
    assert parse_recent("{not json}") is None


def test_parse_recent_drops_non_string_items() -> None:
    assert parse_recent('{"recent": ["一", 2, null, "三"]}') == ["一", "三"]


def test_parse_recent_rejects_a_list_with_no_strings_at_all() -> None:
    assert parse_recent('{"recent": [1, 2]}') is None


def test_parse_recent_treats_an_empty_object_list_as_unparseable() -> None:
    """An empty 最近 is never written: the dream keeps the current list."""
    assert parse_recent('{"recent": []}') is None


def test_parse_recent_treats_an_empty_bare_list_as_unparseable() -> None:
    assert parse_recent("[]") is None
    assert parse_recent("```json\n[]\n```") is None


def test_parse_recent_prefers_an_object_with_recent_over_an_earlier_bare_list() -> None:
    assert parse_recent('我之前写的是 [] 现在 {"recent": ["a"]}') == ["a"]
    assert parse_recent('旧的 ["x"] 新的 {"recent": ["a"]}') == ["a"]


def test_parse_recent_skips_an_empty_object_list_for_a_later_full_one() -> None:
    assert parse_recent('{"recent": []} 改一下 {"recent": ["a"]}') == ["a"]


def test_parse_recent_falls_back_to_a_bare_list_when_no_object_has_recent() -> None:
    assert parse_recent('{"note": 1} 然后 ["一", "二"]') == ["一", "二"]


def test_parse_recent_keeps_over_limit_items_for_the_writer_to_clamp() -> None:
    items = ["长" * 200] * 8
    assert parse_recent('{"recent": [' + ",".join(f'"{i}"' for i in items) + "]}") == items


def test_parse_recent_skips_an_object_without_recent() -> None:
    assert parse_recent('{"note": "先说一句"} 然后 {"recent": ["一"]}') == ["一"]
