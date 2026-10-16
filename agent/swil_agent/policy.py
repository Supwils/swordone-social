"""Invocation gates a round must pass before it touches an account (spec §11).

Two policies, both decided here and both REPORTED by the CLI:

  * the production guard -- with `SWIL_REQUIRE_NON_PROD=1`, a write command
    against the production host is refused unless the operator passed
    `--i-mean-production`;
  * the era gate -- every Era 3 round reads `since=<ERA_START>`, so a round
    with no era open is refused rather than fed Era 2 posts.

This module raises domain errors and never prints or exits: it must not
import Typer. `cli/errors.py` maps each error to the exit code (75) and the
byte-identical operator line, which is why the messages live there and not
here.
"""

from __future__ import annotations

from datetime import datetime
from typing import Final
from urllib.parse import urlparse

# Spec §3 / §11. Compared as a hostname, never as a substring of SWIL_URL.
PRODUCTION_HOST: Final = "swil-social-api-production.up.railway.app"


class ProductionWritesRefusedError(RuntimeError):
    """`SWIL_REQUIRE_NON_PROD=1` and `SWIL_URL` names the production host."""


class EraNotOpenError(RuntimeError):
    """`ERA_START` is unset: no era is open for a round to read from."""


def url_host(url: str) -> str:
    return urlparse(url).hostname or ""


def is_production_url(url: str) -> bool:
    return url_host(url) == PRODUCTION_HOST


def refuse_production_writes(
    swil_url: str, *, i_mean_production: bool, require_non_prod: bool
) -> None:
    """Raise `ProductionWritesRefusedError` when the guard is on, the override is
    absent and `swil_url` is the production host.

    `require_non_prod` is `Settings.swil_require_non_prod`
    (`SWIL_REQUIRE_NON_PROD`; a process export outranks `agent/.env`).
    """
    if i_mean_production or not require_non_prod:
        return
    if not is_production_url(swil_url):
        return
    raise ProductionWritesRefusedError(PRODUCTION_HOST)


def require_era_start(era_start: datetime | None) -> None:
    """Raise `EraNotOpenError` when no era is open: an unset ERA_START would feed
    Era 2 posts into an Era 3 prompt, and every runnable persona is Era 3."""
    if era_start is None:
        raise EraNotOpenError("ERA_START is unset")
