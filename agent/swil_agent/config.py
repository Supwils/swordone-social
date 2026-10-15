"""Typed settings for the agent runtime.

Precedence deliberately matches the Bash runtime: `agent/.env` is sourced with
`set -a` after the caller's environment, so the FILE WINS over process env.
This is the opposite of pydantic-settings' default, hence the explicit
`settings_customise_sources` override below.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

_AGENT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # `extra="ignore"`: the real `agent/.env` carries keys this model does not
    # declare (UNSPLASH_SECRET_KEY, ASPECT_PROMPT_VERSION, SWIL_AGENT_SETUP_TOKEN),
    # and pydantic-settings defaults to `extra="forbid"`, which made loading the
    # real file fail validation. Some of those keys are expected to become real
    # fields in a later phase; until then, ignore rather than reject them.
    model_config = SettingsConfigDict(
        env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    swil_url: str = "http://localhost:8899"
    swil_pass: str | None = None
    # Gate for `register` on servers that require it (isAgent signups).
    swil_agent_setup_token: SecretStr | None = None

    embedder_url: str = "http://127.0.0.1:7777"

    dream_cooldown_hours: int = 12
    dream_min_new_memories: int = 8

    # Era 3 start (ISO 8601). Unset until the operator opens the era.
    era_start: datetime | None = None

    # Act rhythm: a roll <= post_probability (percent) means the round must
    # post; at post_ceiling_per_day posts it must not.
    post_probability: int = Field(60, ge=0, le=100)
    post_ceiling_per_day: int = Field(1, ge=0)
    # Duplicate guard: drop a post candidate whose max cosine similarity to the
    # account's last `post_duplicate_window` posts reaches the threshold.
    post_duplicate_threshold: float = Field(0.92, gt=0, le=1)
    post_duplicate_window: int = Field(12, ge=1, le=63)

    # How many recent posts `behavior-snapshot` embeds.
    behavior_post_limit: int = 12

    # The sweep's shared round id, exported once per sweep by
    # `opportunistic-round.sh`. PROCESS ENV ONLY -- `load_settings` drops any
    # value from the `.env` file (see there). Validated where it is used
    # (`round_id.py`): an invalid value falls back to a manual id, never fails.
    swil_round_id: str | None = None

    # ── LLM backend selection ────────────────────────────────────────────
    #
    # All five are GLOBAL DEFAULTS, not overrides: `llm/selection.py` ranks the
    # persona's `model:` frontmatter above them, because each account's backend is the
    # drift experiment's independent variable and an env var that outranked the
    # roster would silently re-assign every arm at once. Only an explicit CLI
    # flag outranks the file. See that module's docstring for the full ladder.
    #
    # `None` (not `"claude"`) is the default for `swil_llm_backend` on purpose:
    # it means "the file decides", which is what every account does today, so
    # adding these fields changes no round's behaviour until one is set.
    swil_llm_backend: str | None = None
    swil_llm_model: str | None = None

    # Only read when the resolved backend is `api`.
    #
    # `swil_llm_base_url` is the base URL AS THE VENDOR DOCUMENTS IT: the
    # OpenAI-shaped providers publish a base that already ends in `/v1` (the
    # call is `POST {base}/chat/completions`), Anthropic publishes one that does
    # not (`POST {base}/v1/messages`). Normalising the two here would mean
    # rewriting a URL the operator copied from the vendor's own docs, which is a
    # worse surprise than the asymmetry.
    swil_llm_provider: str | None = None
    swil_llm_base_url: str | None = None
    # SecretStr so a stray `repr(settings)` in a log line or a traceback frame
    # prints `**********` instead of the key. It is never written to
    # personality.md, memory.md, or a lab event -- `BackendChoice.describe()`
    # carries the provider and the model and nothing else.
    swil_llm_api_key: SecretStr | None = None
    # Anthropic's Messages API requires `max_tokens`; the OpenAI-shaped one
    # treats it as optional. Sent on both so the two protocols cannot diverge
    # in output length for the same persona, which would confound a
    # cross-provider comparison for a reason that is not the model.
    swil_llm_max_tokens: int = Field(default=4096, gt=0)

    unsplash_access_key: str | None = None

    agent_root: Path = Field(default=_AGENT_ROOT)

    @field_validator(
        "swil_llm_backend",
        "swil_llm_model",
        "swil_llm_provider",
        "swil_llm_base_url",
        "swil_llm_api_key",
        "swil_agent_setup_token",
        "swil_round_id",
        mode="before",
    )
    @classmethod
    def _blank_is_unset(cls, v: object) -> object:
        """`FOO=` in a .env file is how a shell spells "off", not "the empty
        string". Left as `""` these are falsy in some checks and truthy as a
        declared-source in others, so an operator commenting a value out by
        emptying it would get a different resolution than deleting the line."""
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("swil_url", "embedder_url")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # dotenv BEFORE env: the file wins, matching `set -a && . agent/.env`.
        # Sources earlier in the tuple take precedence over later ones, so
        # placing dotenv_settings ahead of env_settings makes a key present in
        # the .env file win over the same key in the process environment,
        # while a key absent from the file still falls through to env_settings
        # (process env) and finally to the field defaults.
        return (init_settings, dotenv_settings, env_settings, file_secret_settings)


def load_settings(env_file: Path | None = None) -> Settings:
    path = env_file if env_file is not None else _AGENT_ROOT / ".env"
    settings = Settings(_env_file=path)
    # `SWIL_ROUND_ID` is per-process: the round script mints one per sweep. In
    # `.env` it would be permanently stale and, the file winning over process
    # env, would outrank the sweep's own export -- so it is read from the
    # process env alone.
    raw = os.environ.get("SWIL_ROUND_ID", "").strip()
    return settings.model_copy(update={"swil_round_id": raw or None})
