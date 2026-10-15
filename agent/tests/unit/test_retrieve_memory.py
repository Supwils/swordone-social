"""Act-path memory retrieval (loop-engine spec §8).

The planner no longer sees `tail -20` of `memory.md`. `retrieve_memory`
builds a bounded slice: last 8 dated lines always, then dated lines that
mention a counterparty or the board, newest first, capped at 24,
chronological. `posts_today` stays a full-file count — rhythm must not
be computed from the slice.
"""

from __future__ import annotations

from datetime import datetime

from swil_agent.act.context import build_context
from swil_agent.act.context_format import posts_today
from swil_agent.act.memory import retrieve_memory
from swil_agent.act.planner import render_planner_prompt
from swil_agent.models import ActContext, Persona

from ._runners import FakeResources, make_persona

TODAY = "2026-08-21"
NOW = datetime(2026, 8, 21, 10, 0, 0)
COUNTERPARTY = "ada"
BOARD = "oss"
LIMIT = 24
RECENCY_FLOOR = 8


def _dated(n: int, *, day: str = "2026-06-01", kind: str = "like", body: str = "") -> str:
    pid = f"{n:024d}"
    if kind == "like":
        suffix = f" | {body}" if body else ""
        return f"{day} | like | postId={pid}{suffix}"
    if kind == "post":
        return f"{day} | post | id={pid} | {body}"
    if kind == "comment":
        return f"{day} | comment | postId={pid} | {body}"
    return f"{day} | {kind} | {body}"


def _two_hundred(*, overlay: dict[int, str] | None = None) -> str:
    """200 dated lines. Indices 192-199 are the recency floor (markers RECENCY-0..7)."""
    lines: list[str] = []
    extra = overlay or {}
    for i in range(200):
        if i in extra:
            lines.append(extra[i])
        elif i >= 192:
            lines.append(_dated(i, day="2026-08-20", body=f"RECENCY-{i - 192}"))
        else:
            lines.append(_dated(i))
    return "\n".join(lines)


def _recency_markers() -> list[str]:
    return [f"RECENCY-{i}" for i in range(RECENCY_FLOOR)]


def _retrieve(
    memory_text: str,
    *,
    board: str = "",
    counterparties: list[str] | None = None,
    today: str = TODAY,
    limit: int = LIMIT,
) -> str:
    return retrieve_memory(
        memory_text,
        today=today,
        board=board,
        counterparties=counterparties or (),
        limit=limit,
    )


def _persona(*, board: str = "") -> Persona:
    return make_persona(board=board)


# ── retrieve_memory (spec §8) ───────────────────────────────────────────────


def test_empty_file_returns_empty_string() -> None:
    assert _retrieve("") == ""


def test_a_200_line_file_is_capped_at_limit() -> None:
    """Spec §8: a 200-line file cannot appear in full. Cap is 24."""
    retrieved = _retrieve(_two_hundred())
    assert len(retrieved.splitlines()) <= LIMIT
    assert len(retrieved.splitlines()) == RECENCY_FLOOR


def test_last_eight_dated_lines_are_always_present() -> None:
    retrieved = _retrieve(_two_hundred())
    for marker in _recency_markers():
        assert marker in retrieved


def test_a_counterparty_mention_outside_the_floor_is_kept() -> None:
    """Spec §8: from the rest, a dated line mentioning a feed/DM username
    is kept even though it is not in the last 8."""
    memory = _two_hundred(
        overlay={5: _dated(5, day="2026-01-15", kind="comment", body=f"replied to @{COUNTERPARTY}")}
    )
    retrieved = _retrieve(memory, counterparties=[COUNTERPARTY])
    assert f"@{COUNTERPARTY}" in retrieved
    for marker in _recency_markers():
        assert marker in retrieved
    assert len(retrieved.splitlines()) <= LIMIT


def test_a_board_mention_outside_the_floor_is_kept() -> None:
    memory = _two_hundred(
        overlay={7: _dated(7, day="2026-02-01", kind="post", body=f"posted on {BOARD} tonight")}
    )
    retrieved = _retrieve(memory, board=BOARD)
    assert BOARD in retrieved
    assert len(retrieved.splitlines()) <= LIMIT


def test_retrieved_block_stays_in_chronological_order() -> None:
    memory = _two_hundred(
        overlay={5: _dated(5, day="2026-01-15", kind="comment", body=f"replied to @{COUNTERPARTY}")}
    )
    retrieved = _retrieve(memory, counterparties=[COUNTERPARTY])
    lines = retrieved.splitlines()
    assert lines == sorted(lines)  # YYYY-MM-DD prefixes sort as chronology
    assert lines[0].startswith("2026-01-15")
    assert lines[-1].endswith("RECENCY-7")


def test_todays_post_outside_the_floor_is_kept_when_it_fits() -> None:
    """Spec §8 rule 3: today's `post` lines stay in the slice when the cap allows."""
    memory = _two_hundred(overlay={10: _dated(10, day=TODAY, kind="post", body="TODAY-POST-KEPT")})
    retrieved = _retrieve(memory)
    assert "TODAY-POST-KEPT" in retrieved
    for marker in _recency_markers():
        assert marker in retrieved


def test_posts_today_counts_a_today_post_that_retrieval_dropped() -> None:
    """Spec §8 rule 3: `posts_today` is a FULL-file count.

    The oldest today-post sits outside the recency floor and is not a
    mention. Sixteen newer today-posts plus the last-8 floor fill the
    cap, so retrieval drops it — and the rhythm counter must still see it.
    """
    overlay: dict[int, str] = {
        0: _dated(0, day=TODAY, kind="post", body="DROPPED-TODAY-POST"),
    }
    for i in range(1, 17):
        overlay[i] = _dated(i, day=TODAY, kind="post", body=f"EXTRA-TODAY-{i}")
    memory = _two_hundred(overlay=overlay)
    retrieved = _retrieve(memory)
    assert "DROPPED-TODAY-POST" not in retrieved
    assert len(retrieved.splitlines()) <= LIMIT
    assert posts_today(memory, TODAY) == 17
    assert posts_today(retrieved, TODAY) < posts_today(memory, TODAY)


# ── ActContext wiring (spec §8) ─────────────────────────────────────────────


def test_act_context_does_not_carry_a_200_line_memory_file() -> None:
    memory = _two_hundred(
        overlay={5: _dated(5, day="2026-01-15", kind="comment", body=f"replied to @{COUNTERPARTY}")}
    )
    resources = FakeResources()
    resources.recommended = [
        {
            "id": "a" * 24,
            "author": {"username": COUNTERPARTY},
            "createdAt": f"{TODAY}T00:00:00Z",
            "text": "hello from ada",
            "likeCount": 0,
            "commentCount": 0,
        }
    ]
    ctx = build_context(
        resources,
        _persona(board=BOARD),
        memory_text=memory,
        now=NOW,
        budget=5,
    )
    assert len(ctx.recent_memory.splitlines()) <= LIMIT
    assert len(memory.splitlines()) == 200
    assert ctx.recent_memory != memory


def test_a_feed_author_mention_is_preferentially_kept_in_act_context() -> None:
    memory = _two_hundred(
        overlay={5: _dated(5, day="2026-01-15", kind="comment", body=f"replied to @{COUNTERPARTY}")}
    )
    resources = FakeResources()
    resources.recommended = [
        {
            "id": "a" * 24,
            "author": {"username": COUNTERPARTY},
            "createdAt": f"{TODAY}T00:00:00Z",
            "text": "hello from ada",
            "likeCount": 0,
            "commentCount": 0,
        }
    ]
    ctx = build_context(
        resources,
        _persona(),
        memory_text=memory,
        now=NOW,
        budget=5,
    )
    assert f"@{COUNTERPARTY}" in ctx.recent_memory
    for marker in _recency_markers():
        assert marker in ctx.recent_memory


def test_a_dm_partner_mention_is_kept_in_act_context() -> None:
    memory = _two_hundred(
        overlay={5: _dated(5, day="2026-01-15", kind="comment", body=f"dm to @{COUNTERPARTY}")}
    )
    resources = FakeResources()
    resources.conversation_items = [
        {
            "id": "conv1",
            "participants": [{"username": COUNTERPARTY}],
            "unread": False,
            "lastMessage": {"text": "hi"},
        }
    ]
    ctx = build_context(
        resources,
        _persona(),
        memory_text=memory,
        now=NOW,
        budget=5,
    )
    assert f"@{COUNTERPARTY}" in ctx.recent_memory


def test_act_context_posts_today_still_sees_a_post_retrieval_dropped() -> None:
    overlay: dict[int, str] = {
        0: _dated(0, day=TODAY, kind="post", body="DROPPED-TODAY-POST"),
    }
    for i in range(1, 17):
        overlay[i] = _dated(i, day=TODAY, kind="post", body=f"EXTRA-TODAY-{i}")
    memory = _two_hundred(overlay=overlay)
    ctx = build_context(
        FakeResources(),
        _persona(),
        memory_text=memory,
        now=NOW,
        budget=5,
    )
    assert ctx.today_post_count == 17
    assert "DROPPED-TODAY-POST" not in ctx.recent_memory


def test_planner_memory_block_is_labeled_as_a_retrieved_slice() -> None:
    """Spec §8: the prompt label tells the model this is a slice, not the log."""
    prompt = render_planner_prompt(ActContext(recent_memory="slice-line"), rhythm_guidance="g")
    assert "## 近期记忆（检索）" in prompt
    assert "slice-line" in prompt
    assert "最近行动记录（最新20条）" not in prompt
