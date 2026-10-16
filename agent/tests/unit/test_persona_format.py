"""Persona format v2: YAML frontmatter + immutable card + bounded `## 最近`.

Every fixture is written into `tmp_path`. The real roster under `agent/agents`
is still Era 2 bullets until it is sealed, and this loader must reject it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from swil_agent.persona.format import (
    MAX_CARD_CHARS,
    MAX_FILE_BYTES,
    MAX_RECENT_CHARS,
    MAX_RECENT_ITEMS,
    RECENT_HEADING,
    PersonaDoc,
    PersonaFormatError,
    card_text,
    clamp_recent,
    parse_persona,
    prompt_text,
    render_persona,
)
from swil_agent.persona.loader import load_persona, resolve_agent_dir
from swil_agent.persona.validators import validate_persona_text

FRONTMATTER = """---
username: xiaoman
display_name: 小满
bio: 夜班护士，白天睡觉，醒着养多肉。
model: claude:claude-haiku-5-5
board: life-science
topics: [health, nursing, plants]
era: 3
---
"""

CARD = "# 小满\n\n夜班护士。说话短，爱吐槽排班，对多肉比对人耐心。"

VALID = FRONTMATTER + CARD + "\n\n## 最近\n- 连上三个夜班\n- 觉得新来的实习生挺靠谱\n"


def _write(root: Path, name: str, text: str) -> Path:
    directory = root / "agents" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(text, encoding="utf-8")
    return directory


# ── parse / render ──────────────────────────────────────────────────────────


def test_constants_match_the_spec() -> None:
    assert RECENT_HEADING == "## 最近"
    assert (MAX_CARD_CHARS, MAX_RECENT_ITEMS, MAX_RECENT_CHARS, MAX_FILE_BYTES) == (
        600,
        5,
        60,
        4096,
    )


def test_parse_splits_frontmatter_card_and_recent() -> None:
    doc = parse_persona(VALID)
    assert doc.meta["username"] == "xiaoman"
    assert doc.meta["topics"] == ["health", "nursing", "plants"]
    assert doc.meta["era"] == 3
    assert doc.card == CARD
    assert doc.recent == ("连上三个夜班", "觉得新来的实习生挺靠谱")


def test_render_then_parse_round_trips() -> None:
    doc = parse_persona(VALID)
    assert parse_persona(render_persona(doc)) == doc


def test_render_is_idempotent() -> None:
    once = render_persona(parse_persona(VALID))
    assert render_persona(parse_persona(once)) == once


def test_render_layout() -> None:
    doc = PersonaDoc(meta={"username": "a", "era": 3}, card="# A\n\n卡片", recent=("x", "y"))
    expected = "---\nusername: a\nera: 3\n---\n# A\n\n卡片\n\n## 最近\n- x\n- y\n"
    assert render_persona(doc) == expected


def test_render_with_empty_recent_still_has_the_heading() -> None:
    doc = PersonaDoc(meta={"username": "a"}, card="# A", recent=())
    text = render_persona(doc)
    assert text.endswith("# A\n\n## 最近\n")
    assert parse_persona(text) == doc


def test_bom_and_crlf_are_normalised() -> None:
    crlf = "﻿" + VALID.replace("\n", "\r\n")
    doc = parse_persona(crlf)
    assert doc == parse_persona(VALID)
    assert "\r" not in doc.card


def test_missing_recent_heading_gives_empty_recent() -> None:
    doc = parse_persona(FRONTMATTER + CARD + "\n")
    assert doc.recent == ()
    assert doc.card == CARD


def test_non_bullet_lines_under_recent_are_ignored() -> None:
    doc = parse_persona(FRONTMATTER + CARD + "\n\n## 最近\n\n- a\n随便一行\n- b\n")
    assert doc.recent == ("a", "b")


@pytest.mark.parametrize(
    "text",
    [
        CARD,  # no frontmatter at all
        "---\nusername: a\n" + CARD,  # never closed
        "---\nusername: [unclosed\n---\n" + CARD,  # invalid YAML
        "---\n- a\n- b\n---\n" + CARD,  # YAML, but not a mapping
    ],
)
def test_bad_frontmatter_raises(text: str) -> None:
    with pytest.raises(PersonaFormatError):
        parse_persona(text)


def test_empty_frontmatter_parses_to_an_empty_mapping() -> None:
    assert parse_persona("---\n---\n# A\n").meta == {}


def test_format_error_is_a_value_error() -> None:
    assert issubclass(PersonaFormatError, ValueError)


# ── clamp_recent ────────────────────────────────────────────────────────────


def test_clamp_keeps_the_first_five() -> None:
    items = [f"第{i}件事" for i in range(8)]
    assert clamp_recent(items) == tuple(items[:5])


def test_clamp_truncates_each_item_to_60_code_points() -> None:
    (item,) = clamp_recent(["很" * 200])
    assert item == "很" * 60


def test_clamp_drops_empties_before_counting() -> None:
    assert clamp_recent(["", "  ", "a", "\n", "b"]) == ("a", "b")


def test_clamp_strips_a_leading_bullet_marker() -> None:
    assert clamp_recent(["- 一件事", "  -  另一件 "]) == ("一件事", "另一件")


def test_clamp_flattens_newlines_so_an_item_cannot_inject_a_heading() -> None:
    (item,) = clamp_recent(["上半句\n## 新标题"])
    assert "\n" not in item
    assert item == "上半句 ## 新标题"


# ── prompt_text ─────────────────────────────────────────────────────────────


def test_prompt_is_card_plus_recent_without_frontmatter() -> None:
    text = prompt_text(parse_persona(VALID))
    assert text == CARD + "\n\n## 最近\n- 连上三个夜班\n- 觉得新来的实习生挺靠谱"
    assert "model:" not in text
    assert "claude-haiku" not in text
    assert "---" not in text


def test_prompt_with_empty_recent_says_none_yet() -> None:
    text = prompt_text(parse_persona(FRONTMATTER + CARD))
    assert text == CARD + "\n\n## 最近\n（暂无）"


# ── load_persona ────────────────────────────────────────────────────────────


def test_load_builds_the_persona(tmp_path: Path) -> None:
    directory = _write(tmp_path, "xiaoman", VALID)
    p = load_persona(directory)
    assert p.username == "xiaoman"
    assert p.display_name == "小满"
    assert p.bio == "夜班护士，白天睡觉，醒着养多肉。"
    assert p.topics == ["health", "nursing", "plants"]
    assert p.board == "life-science"
    assert p.era == 3
    assert p.card == CARD
    assert p.recent == ["连上三个夜班", "觉得新来的实习生挺靠谱"]
    assert p.prompt == prompt_text(parse_persona(VALID))
    assert p.raw == VALID
    assert p.directory == directory


@pytest.mark.parametrize(
    ("spec", "backend", "model"),
    [
        ("claude:claude-opus-5-5", "claude", "claude-opus-5-5"),
        ("grok:grok-4.6", "grok", "grok-4.6"),
        ("cursor:gemini-3.7-flash-high", "cursor", "gemini-3.7-flash-high"),
        ("codex", "codex", None),
    ],
)
def test_model_splits_at_the_first_colon(
    tmp_path: Path, spec: str, backend: str, model: str | None
) -> None:
    text = VALID.replace("model: claude:claude-haiku-5-5", f"model: {spec}")
    p = load_persona(_write(tmp_path, "xiaoman", text))
    assert (p.backend, p.model, p.declared_backend) == (backend, model, backend)


def test_bio_is_optional(tmp_path: Path) -> None:
    text = VALID.replace("bio: 夜班护士，白天睡觉，醒着养多肉。\n", "")
    assert load_persona(_write(tmp_path, "xiaoman", text)).bio is None


def test_load_accepts_bom_crlf_and_no_recent(tmp_path: Path) -> None:
    text = "﻿" + (FRONTMATTER + CARD + "\n").replace("\n", "\r\n")
    p = load_persona(_write(tmp_path, "xiaoman", text))
    assert p.recent == []
    assert p.prompt.endswith("（暂无）")


def test_load_clamps_an_over_long_recent_list(tmp_path: Path) -> None:
    bullets = "".join(f"- {'长' * 100}{i}\n" for i in range(8))
    p = load_persona(_write(tmp_path, "xiaoman", FRONTMATTER + CARD + "\n\n## 最近\n" + bullets))
    assert len(p.recent) == 5
    assert all(len(item) == 60 for item in p.recent)


def test_load_rejects_missing_frontmatter(tmp_path: Path) -> None:
    with pytest.raises(PersonaFormatError):
        load_persona(_write(tmp_path, "xiaoman", CARD + "\n"))


def test_load_rejects_an_era_2_bullet_file(tmp_path: Path) -> None:
    era2 = "# 测试\n\n## 身份\n- **Username:** xiaoman\n- **AI Backend:** claude\n"
    with pytest.raises(PersonaFormatError):
        load_persona(_write(tmp_path, "xiaoman", era2))


@pytest.mark.parametrize(
    "key",
    ["username", "display_name", "model", "board", "topics", "era"],
)
def test_load_rejects_a_missing_required_key(tmp_path: Path, key: str) -> None:
    lines = [line for line in VALID.splitlines(keepends=True) if not line.startswith(f"{key}:")]
    with pytest.raises(PersonaFormatError, match=key):
        load_persona(_write(tmp_path, "xiaoman", "".join(lines)))


def test_load_rejects_empty_topics(tmp_path: Path) -> None:
    text = VALID.replace("topics: [health, nursing, plants]", "topics: []")
    with pytest.raises(PersonaFormatError, match="topics"):
        load_persona(_write(tmp_path, "xiaoman", text))


def test_load_rejects_topics_that_are_not_a_list(tmp_path: Path) -> None:
    text = VALID.replace("topics: [health, nursing, plants]", "topics: health")
    with pytest.raises(PersonaFormatError, match="topics"):
        load_persona(_write(tmp_path, "xiaoman", text))


@pytest.mark.parametrize("era", ["2", "'3'", "4"])
def test_load_rejects_any_era_but_3(tmp_path: Path, era: str) -> None:
    text = VALID.replace("era: 3", f"era: {era}")
    with pytest.raises(PersonaFormatError, match="era"):
        load_persona(_write(tmp_path, "xiaoman", text))


def test_load_rejects_a_directory_that_is_not_the_username(tmp_path: Path) -> None:
    with pytest.raises(PersonaFormatError, match="directory"):
        load_persona(_write(tmp_path, "someone_else", VALID))


def test_load_rejects_an_empty_model_backend(tmp_path: Path) -> None:
    text = VALID.replace("model: claude:claude-haiku-5-5", "model: ':x'")
    with pytest.raises(PersonaFormatError, match="model"):
        load_persona(_write(tmp_path, "xiaoman", text))


@pytest.mark.parametrize("backend", ["haiku", "gork", "xai", "claude-code"])
def test_load_rejects_an_unknown_model_backend(tmp_path: Path, backend: str) -> None:
    """S6 AG-F13: an unknown backend used to run the account on claude."""
    text = VALID.replace("model: claude:claude-haiku-5-5", f"model: {backend}:some-model")
    with pytest.raises(PersonaFormatError, match=f"backend '{backend}' is not one of"):
        load_persona(_write(tmp_path, "xiaoman", text))


@pytest.mark.parametrize(
    "model",
    [
        "codex:gpt-5.6-luna",
        "grok:grok-4.6",
        "cursor:gemini-3.7-flash-high",
        "claude:claude-opus-5-5",
        "claude:claude-haiku-5-5",
    ],
)
def test_every_era_3_arm_spelling_is_a_known_backend(tmp_path: Path, model: str) -> None:
    text = VALID.replace("model: claude:claude-haiku-5-5", f"model: {model}")
    assert validate_persona_text(text) == []
    assert load_persona(_write(tmp_path, "xiaoman", text)).model == model.split(":", 1)[1]


def test_load_accepts_a_card_of_exactly_600_code_points(tmp_path: Path) -> None:
    card = "# 小满\n\n" + "字" * (MAX_CARD_CHARS - len("# 小满\n\n"))
    assert len(card) == MAX_CARD_CHARS
    p = load_persona(_write(tmp_path, "xiaoman", FRONTMATTER + card + "\n"))
    assert p.card == card


def test_load_rejects_a_card_over_600_code_points(tmp_path: Path) -> None:
    card = "# 小满\n\n" + "字" * (MAX_CARD_CHARS - len("# 小满\n\n") + 1)
    with pytest.raises(PersonaFormatError, match="card"):
        load_persona(_write(tmp_path, "xiaoman", FRONTMATTER + card + "\n"))


def test_load_rejects_an_empty_card(tmp_path: Path) -> None:
    with pytest.raises(PersonaFormatError, match="card"):
        load_persona(_write(tmp_path, "xiaoman", FRONTMATTER + "\n## 最近\n- a\n"))


def test_load_rejects_a_file_over_4096_bytes(tmp_path: Path) -> None:
    # The card stays legal (500 code points = 1500 bytes); a long bio pushes
    # the FILE over the byte limit, which is counted in UTF-8 bytes.
    card = "# 小满\n\n" + "字" * 500
    text = VALID.replace(CARD, card).replace(
        "bio: 夜班护士，白天睡觉，醒着养多肉。", "bio: " + "长" * 900
    )
    assert len(text) < MAX_FILE_BYTES < len(text.encode("utf-8"))
    with pytest.raises(PersonaFormatError, match="4096"):
        load_persona(_write(tmp_path, "xiaoman", text))


def test_load_rejects_invalid_utf8(tmp_path: Path) -> None:
    directory = _write(tmp_path, "xiaoman", VALID)
    (directory / "personality.md").write_bytes(b"---\nusername: \xff\n---\n")
    with pytest.raises(PersonaFormatError):
        load_persona(directory)


# ── resolve_agent_dir ───────────────────────────────────────────────────────


def test_resolve_finds_agents_dir(tmp_path: Path) -> None:
    directory = _write(tmp_path, "xiaoman", VALID)
    assert resolve_agent_dir(tmp_path, "xiaoman") == directory


def test_resolve_no_longer_searches_humans(tmp_path: Path) -> None:
    humans = tmp_path / "humans" / "xiaoman"
    humans.mkdir(parents=True)
    (humans / "personality.md").write_text(VALID, encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        resolve_agent_dir(tmp_path, "xiaoman")


# ── card_text: what the act path embeds as the card (S2 §4) ────────────────

_ROSTER = Path(__file__).resolve().parents[2] / "agents"


def test_card_text_on_a_real_roster_file_drops_the_name_heading() -> None:
    """Pinned on the live file, not a fixture: the cosine(post, card) series
    is pre-registered, so what the card vector covers must not drift."""
    persona = load_persona(_ROSTER / "xiaoman")

    text = card_text(persona.card)

    assert persona.card.startswith("# 小满")
    assert text.startswith("成都")
    assert not any(line.startswith("#") for line in text.splitlines())
    assert text == persona.card.split("\n", 2)[2].lstrip("\n")


def test_card_text_strips_exactly_one_heading_and_the_blank_lines_after_it() -> None:
    assert card_text("# 小满\n\n\n夜班护士。\n\n# 不是标题") == "夜班护士。\n\n# 不是标题"


def test_card_text_leaves_a_card_without_a_heading_alone() -> None:
    assert card_text("夜班护士。\n# 第二行") == "夜班护士。\n# 第二行"
    assert card_text("#小满\n夜班护士。") == "#小满\n夜班护士。"
    assert card_text("## 小满\n夜班护士。") == "## 小满\n夜班护士。"


def test_card_text_of_a_heading_only_card_is_empty() -> None:
    assert card_text("# 小满") == ""
    assert card_text("# 小满\n\n") == ""
