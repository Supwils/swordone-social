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


def test_env_file_wins_over_process_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The Bash runtime sources agent/.env with `set -a` AFTER the caller's env,
    so the file wins. Preserve that precedence or operators will be surprised."""
    env = tmp_path / ".env"
    env.write_text("SWIL_URL=https://from-file.test\nPOST_PROBABILITY=30\n", encoding="utf-8")
    monkeypatch.setenv("SWIL_URL", "https://from-process.test")
    monkeypatch.setenv("POST_PROBABILITY", "90")
    s = load_settings(env)
    assert s.swil_url == "https://from-file.test"
    assert s.post_probability == 30


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
    would be permanently stale and -- the file winning over process env --
    would relabel every later sweep. Only the caller's environment counts."""
    env = tmp_path / ".env"
    env.write_text("SWIL_ROUND_ID=20261001T000000Z-r\n", encoding="utf-8")
    monkeypatch.delenv("SWIL_ROUND_ID", raising=False)
    assert load_settings(env).swil_round_id is None
    monkeypatch.setenv("SWIL_ROUND_ID", "20261014T091500Z-r")
    assert load_settings(env).swil_round_id == "20261014T091500Z-r"
