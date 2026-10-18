"""Prompt v2's id-free memory lines and its board news (spec B1/B3)."""

from __future__ import annotations

import re

import pytest

from swil_agent.prompts.v2.memory import (
    fold_memory_lines,
    parse_memory_line,
    render_memory_lines,
)
from swil_agent.prompts.v2.news import (
    NEWS_CHAR_CAP,
    news_topics_for,
    parse_digest,
    render_news,
)

HEX = "6a0000000000000000000001"
HEX_ID = re.compile(r"[0-9a-f]{24}")


@pytest.mark.parametrize(
    ("line", "rendered"),
    [
        (f"2026-10-17 | post | id={HEX} | [img:city night] 夜里的城市", "10-17 发帖：夜里的城市"),
        (f"2026-10-17 | post | id={HEX} | [img:city night]", "10-17 发帖"),
        (
            f"2026-10-17 | comment | postId={HEX} commentId={HEX} parentId={HEX} | 同意",
            "10-17 评论：同意",
        ),
        (f"2026-10-17 | like | postId={HEX}", "10-17 点赞了一条帖子"),
        ("2026-10-17 | follow | @xiaoman", "10-17 关注了 @xiaoman"),
        (f"2026-10-17 | echo | id={HEX} echoOf={HEX} | 说得好", "10-17 转发了一条帖子：说得好"),
        (f"2026-10-17 | echo | id={HEX} echoOf={HEX}", "10-17 转发了一条帖子"),
        (f"2026-10-17 | dm | to=xiaoman conversationId={HEX} | 在吗", "10-17 私信 @xiaoman：在吗"),
        ("2026-10-17 | dream | 最近已更新", "10-17 更新了「最近」"),
        ("2026-09-01 | act | old line 000", "09-01 act：old line 000"),
    ],
)
def test_each_memory_verb_renders_without_ids(line: str, rendered: str) -> None:
    assert render_memory_lines([line]) == [rendered]
    assert not HEX_ID.search(rendered)


def test_undated_lines_are_dropped() -> None:
    assert parse_memory_line("(no memory yet)") is None
    assert render_memory_lines(["# heading", "", "free text"]) == []


def test_a_stray_raw_id_in_the_text_is_removed_too() -> None:
    line = f"2026-10-17 | comment | postId={HEX} | 回 {HEX} 的帖"
    assert render_memory_lines([line]) == ["10-17 评论：回 的帖"]


def test_the_dream_view_folds_likes_and_follows_into_one_count_line() -> None:
    lines = [
        f"2026-10-16 | like | postId={HEX}",
        "2026-10-16 | follow | @a",
        f"2026-10-17 | like | postId={HEX}",
        f"2026-10-17 | post | id={HEX} | 今天的帖",
    ]
    assert fold_memory_lines(lines) == ["10-17 发帖：今天的帖", "另外：点赞 2 次，关注了 1 个人。"]


def test_the_dream_view_has_no_count_line_without_likes_or_follows() -> None:
    assert fold_memory_lines([f"2026-10-17 | post | id={HEX} | 帖"]) == ["10-17 发帖：帖"]


DIGEST = """**抓取时间：** 2026-10-17 06:08
**日报日期：** 2026-10-16

### [general] 通用日报
- g1
- g2
- g3
- g4
→ 通用总结

### [finance] 金融日报
- f1
→ 金融总结

### [crypto] 加密日报
- c1

### [ai-tech] AI 日报
- a1
→ AI 总结
"""


@pytest.mark.parametrize(
    ("board", "topics"),
    [
        ("making", ("supply-chain", "auto-mobility", "general")),
        ("living", ("general",)),
        ("life-science", ("science", "sports-health-nutrition", "general")),
        ("perception", ("gaming", "general")),
        ("ai-governance", ("ai-tech", "general")),
        ("market", ("finance", "crypto", "general")),
        ("not-a-board", ("general",)),
    ],
)
def test_each_board_reads_its_mapped_topics_plus_general(
    board: str, topics: tuple[str, ...]
) -> None:
    assert news_topics_for(board) == topics


def test_a_topic_renders_its_summary_and_at_most_three_highlights() -> None:
    assert render_news(DIGEST, "living") == ["[general] 通用总结", "- g1", "- g2", "- g3"]


def test_the_title_stands_in_for_a_missing_summary_and_other_topics_are_left_out() -> None:
    lines = render_news(DIGEST, "market")
    assert lines[:4] == ["[finance] 金融总结", "- f1", "[crypto] 加密日报", "- c1"]
    assert "[ai-tech] AI 总结" not in lines


def test_the_news_content_is_capped_at_2000_chars() -> None:
    huge = "### [general] 标题\n" + "".join(f"- {'长' * 900}\n" for _ in range(3)) + "→ 总结\n"
    lines = render_news(huge, "living")
    assert len("\n".join(lines)) <= NEWS_CHAR_CAP
    assert lines[0] == "[general] 总结"


def test_one_line_longer_than_the_cap_is_cut_to_the_cap() -> None:
    huge = "### [general] 标题\n→ " + "长" * 3000 + "\n"
    assert len("\n".join(render_news(huge, "living"))) == NEWS_CHAR_CAP


@pytest.mark.parametrize("digest", ["（无法获取）", "", "今日新闻：golden 摘要一条", "### 无话题"])
def test_an_unusable_digest_renders_nothing(digest: str) -> None:
    assert parse_digest(digest) == {}
    assert render_news(digest, "market") == []
