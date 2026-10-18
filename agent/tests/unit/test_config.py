import logging
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from swil_agent.config import Settings, load_settings


def test_defaults_match_documented_values(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    s = load_settings(env)
    assert s.swil_url == "https://example.test"
    assert s.embedder_url == "http://127.0.0.1:7777"
    assert s.dream_cooldown_hours == 12
    assert s.dream_min_new_memories == 8
    assert s.era_start is None
    assert s.post_probability == 60
    assert s.post_ceiling_per_day == 1
    assert s.post_duplicate_threshold == 0.92
    assert s.post_duplicate_window == 12


@pytest.mark.parametrize(
    "removed",
    [
        "drift_mode",
        "drift_threshold",
        "drift_threshold_values",
        "drift_threshold_style",
        "drift_threshold_topic",
        "aspect_distill_model",
        "echo_detect",
        "echo_variance_threshold",
        "rule_check_post_limit",
        "cross_read_prob",
        "act_similarity_window",
    ],
)
def test_era_2_settings_are_gone(removed: str) -> None:
    assert removed not in Settings.model_fields


def test_era_start_parses_an_iso_timestamp(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("ERA_START=2026-10-15T00:00:00Z\n", encoding="utf-8")
    assert load_settings(env).era_start == datetime(2026, 10, 15, tzinfo=UTC)


@pytest.mark.parametrize(
    "line",
    [
        "POST_PROBABILITY=101",
        "POST_PROBABILITY=-1",
        "POST_CEILING_PER_DAY=-1",
        "POST_DUPLICATE_THRESHOLD=0",
        "POST_DUPLICATE_THRESHOLD=1.5",
        "POST_DUPLICATE_WINDOW=0",
        "POST_DUPLICATE_WINDOW=64",
    ],
)
def test_out_of_range_post_settings_are_rejected(tmp_path: Path, line: str) -> None:
    env = tmp_path / ".env"
    env.write_text(line + "\n", encoding="utf-8")
    with pytest.raises(ValidationError):
        load_settings(env)


def test_boundary_post_settings_are_accepted(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "POST_PROBABILITY=0\nPOST_CEILING_PER_DAY=0\n"
        "POST_DUPLICATE_THRESHOLD=1\nPOST_DUPLICATE_WINDOW=63\n",
        encoding="utf-8",
    )
    s = load_settings(env)
    assert (s.post_probability, s.post_ceiling_per_day) == (0, 0)
    assert (s.post_duplicate_threshold, s.post_duplicate_window) == (1.0, 63)


def test_process_env_wins_over_the_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One precedence everywhere: the caller's export outranks agent/.env, so a
    one-off `SWIL_URL=... swil-agent ...` (or the round script's restored
    caller value) is the URL the workers actually use."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://from-file.test\nPOST_PROBABILITY=30\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_URL", "https://from-process.test")
    monkeypatch.setenv("POST_PROBABILITY", "90")
    s = load_settings(env)
    assert s.swil_url == "https://from-process.test"
    assert s.post_probability == 90


def test_the_env_file_fills_keys_the_process_env_lacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://from-file.test\n", encoding="utf-8")
    monkeypatch.delenv("SWIL_URL", raising=False)
    assert load_settings(env).swil_url == "https://from-file.test"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("1", True),
        ("TRUE", True),
        (" yes ", True),
        ("on", True),
        ("0", False),
        ("", False),
        ("False", False),
        (" no ", False),
        ("OFF", False),
        ("maybe", True),
    ],
)
def test_require_non_prod_reads_its_spellings_and_never_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str, expected: bool
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", value)
    assert load_settings(env).swil_require_non_prod is expected


def test_an_unrecognised_require_non_prod_is_on_with_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail safe: a value nobody recognises still refuses production."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", "maybe")
    with caplog.at_level(logging.WARNING, logger="swil_agent.config"):
        assert load_settings(env).swil_require_non_prod is True
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "'maybe'" in warnings[0].getMessage()


def test_a_recognised_require_non_prod_logs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    for value in ("1", "off", ""):
        monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", value)
        with caplog.at_level(logging.WARNING, logger="swil_agent.config"):
            load_settings(env)
    assert caplog.records == []


def test_require_non_prod_export_outranks_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_REQUIRE_NON_PROD=0\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_REQUIRE_NON_PROD", "1")
    assert load_settings(env).swil_require_non_prod is True
    monkeypatch.delenv("SWIL_REQUIRE_NON_PROD")
    assert load_settings(env).swil_require_non_prod is False


def test_trailing_slash_is_stripped_from_swil_url(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test/\n", encoding="utf-8")
    assert load_settings(env).swil_url == "https://example.test"


def test_process_env_used_when_key_absent_from_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A key absent from the file must still come from the process environment,
    not silently fall through to the field default (60)."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    monkeypatch.setenv("POST_PROBABILITY", "25")
    assert load_settings(env).post_probability == 25


def test_round_id_comes_from_the_process_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_ROUND_ID", "20261014T091500Z-r")
    assert load_settings(env).swil_round_id == "20261014T091500Z-r"


@pytest.mark.parametrize("value", [None, "", "  "])
def test_an_unset_or_blank_round_id_is_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://example.test\n", encoding="utf-8")
    if value is None:
        monkeypatch.delenv("SWIL_ROUND_ID", raising=False)
    else:
        monkeypatch.setenv("SWIL_ROUND_ID", value)
    assert load_settings(env).swil_round_id is None


def test_a_round_id_in_the_env_file_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The round script exports a fresh id per sweep; one written into `.env`
    would be permanently stale and would label every manual cycle with an old
    sweep's id. Only the caller's environment counts."""
    env = tmp_path / ".env"
    env.write_text("SWIL_ROUND_ID=20261001T000000Z-r\n", encoding="utf-8")
    monkeypatch.delenv("SWIL_ROUND_ID", raising=False)
    assert load_settings(env).swil_round_id is None
    monkeypatch.setenv("SWIL_ROUND_ID", "20261014T091500Z-r")
    assert load_settings(env).swil_round_id == "20261014T091500Z-r"


def test_every_test_starts_without_a_settings_env_var() -> None:
    """`tests/conftest.py` clears every env name `Settings` reads, derived
    from the model: an exported SWIL_URL/SWIL_PASS cannot reach a test."""
    import os

    assert [n for n in (f.upper() for f in Settings.model_fields) if n in os.environ] == []


# ── prompt version (spec 2026-10-17 A2) ──────────────────────────────────────


def _prompt_settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    for key in ("PROMPT_VERSION", "PROMPT_V2_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings()


def test_prompt_version_defaults_to_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _prompt_settings(monkeypatch)
    assert settings.prompt_version == "v1"
    assert settings.prompt_v2_enabled is False


def test_v2_without_the_enable_flag_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError, match="PROMPT_V2_ENABLED"):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v2")


def test_the_enable_flag_alone_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _prompt_settings(monkeypatch, PROMPT_V2_ENABLED="1").prompt_version == "v1"


@pytest.mark.parametrize("flag", ["1", "true", "YES", " on "])
def test_both_keys_switch_to_v2(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    settings = _prompt_settings(monkeypatch, PROMPT_VERSION=" V2 ", PROMPT_V2_ENABLED=flag)
    assert settings.prompt_version == "v2"
    assert settings.prompt_v2_enabled is True


@pytest.mark.parametrize("flag", ["", "0", "off", "maybe"])
def test_only_an_on_word_enables_v2(monkeypatch: pytest.MonkeyPatch, flag: str) -> None:
    with pytest.raises(ValidationError):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v2", PROMPT_V2_ENABLED=flag)


def test_a_blank_prompt_version_reads_as_v1(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _prompt_settings(monkeypatch, PROMPT_VERSION="").prompt_version == "v1"


def test_an_unknown_prompt_version_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError):
        _prompt_settings(monkeypatch, PROMPT_VERSION="v3")


def test_the_dot_env_file_can_switch_both_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for key in ("PROMPT_VERSION", "PROMPT_V2_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    env = tmp_path / ".env"
    env.write_text("PROMPT_VERSION=v2\nPROMPT_V2_ENABLED=1\n", encoding="utf-8")
    assert load_settings(env).prompt_version == "v2"
