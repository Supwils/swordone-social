"""`validate_persona_text`: every limit of persona format v2, as readable failures."""

from __future__ import annotations

from swil_agent.persona.validators import validate_persona_text

VALID = """---
username: xiaoman
display_name: 小满
model: grok:grok-4.6
board: life-science
topics: [health]
era: 3
---
# 小满

夜班护士，说话短。

## 最近
- 连上三个夜班
"""


def test_valid_text_has_no_failures() -> None:
    assert validate_persona_text(VALID) == []


def test_bom_crlf_and_missing_recent_are_still_valid() -> None:
    text = "﻿" + VALID.split("## 最近")[0].replace("\n", "\r\n")
    assert validate_persona_text(text) == []


def test_missing_frontmatter_is_reported() -> None:
    failures = validate_persona_text("# 小满\n\n卡片\n")
    assert len(failures) == 1
    assert "frontmatter" in failures[0]


def test_every_missing_required_key_is_reported() -> None:
    text = VALID.replace("board: life-science\n", "").replace("era: 3\n", "")
    failures = validate_persona_text(text)
    assert any("board" in f for f in failures)
    assert any("era" in f for f in failures)


def test_empty_topics_is_reported() -> None:
    failures = validate_persona_text(VALID.replace("topics: [health]", "topics: []"))
    assert any("topics" in f for f in failures)


def test_wrong_era_is_reported() -> None:
    failures = validate_persona_text(VALID.replace("era: 3", "era: 2"))
    assert any("era" in f for f in failures)


def test_non_string_scalar_is_reported() -> None:
    failures = validate_persona_text(VALID.replace("board: life-science", "board: [a, b]"))
    assert any("board" in f for f in failures)


def test_non_string_bio_is_reported() -> None:
    failures = validate_persona_text(VALID.replace("era: 3", "era: 3\nbio: [a]"))
    assert any("bio" in f for f in failures)


def test_long_card_is_reported() -> None:
    text = VALID.replace("夜班护士，说话短。", "字" * 600)
    assert any("card" in f for f in validate_persona_text(text))


def test_empty_card_is_reported() -> None:
    text = VALID.replace("# 小满\n\n夜班护士，说话短。\n", "")
    assert any("card" in f for f in validate_persona_text(text))


def test_too_many_recent_items_is_reported() -> None:
    text = VALID + "".join(f"- 事{i}\n" for i in range(5))
    assert any("最近" in f and "6" in f for f in validate_persona_text(text))


def test_long_recent_item_is_reported() -> None:
    text = VALID + "- " + "长" * 61 + "\n"
    assert any("最近" in f and "60" in f for f in validate_persona_text(text))


def test_file_over_4096_bytes_is_reported() -> None:
    text = VALID.replace("display_name: 小满", "display_name: " + "长" * 1400)
    assert any("4096" in f for f in validate_persona_text(text))


def test_several_failures_are_all_reported() -> None:
    text = VALID.replace("era: 3", "era: 2").replace("topics: [health]", "topics: []")
    assert len(validate_persona_text(text)) >= 2
