"""One population-cohesion sample, triggered and timestamped.

The SERVER computes the metric from the
latest personality and behavior snapshots (`recordPopulationMetric`,
server/src/modules/agents/population/population.ts); this only triggers
and reports it. Intended to run daily so `/lab`'s homogenization trend has
history.

The route is `/agents/population-metric` -- GLOBAL, not per-username -- and
ANY lab account's `api_key.txt` authorises it. That is the whole reason
`find_account_with_api_key` exists: picking an account here is picking a
CREDENTIAL, never a subject.

`n < 2` is not a failure. The server declines to historise a degenerate
sample (cohesion over fewer than two vectors is a placeholder 1.0 that would
poison the trend) but still answers with a `capturedAt`, so Bash reports it
as success and so does this.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict

from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources, WriteNotVerifiedError

logger = logging.getLogger(__name__)

API_KEY_FILENAME: Final = "api_key.txt"

# Era 3 has one cohort: every account lives under `agents/`.
ACCOUNTS_DIR: Final = "agents"


class PopulationMetricResult(BaseModel):
    """What one `run_population_metric` call recorded.

    The three metric fields are `None` on any failure and never 0.0: a
    cohesion of zero is a real, extreme measurement ("this population has
    nothing in common"), and coercing an outage into it would write the most
    alarming possible reading into the one series that is supposed to detect
    homogenization.
    """

    model_config = ConfigDict(frozen=True)

    ok: bool
    reason: str | None = None
    captured_at: str | None = None
    persona_cohesion: float | None = None
    behavior_cohesion: float | None = None
    n: int | None = None


def find_account_with_api_key(agent_root: Path, name: str | None = None) -> Path | None:
    """The account directory whose `api_key.txt` will authorise the call.

    With a `name`: `agents/<name>`, and the key file must exist -- a real
    account with no key resolves to nothing, the same as an unknown name.
    Without one: the first `agents/*/` directory (sorted) that has a key.

    Returns None rather than raising: "no keyed account" is an exit code the
    CLI owns, not this function.
    """
    base = agent_root / ACCOUNTS_DIR
    if name is not None:
        candidate = base / name
        return candidate if (candidate / API_KEY_FILENAME).is_file() else None
    if not base.is_dir():
        return None
    for directory in sorted(p for p in base.iterdir() if p.is_dir()):
        if (directory / API_KEY_FILENAME).is_file():
            return directory
    return None


def _number(raw: Any) -> float | None:
    """A JSON number, or None. `isinstance(True, int)` is True in Python, so
    a boolean would otherwise pass as a cohesion of 1.0."""
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    return float(raw)


def run_population_metric(resources: Resources) -> PopulationMetricResult:
    """Trigger one sample. Never raises.

    The credential is whatever `resources` already carries -- see
    `find_account_with_api_key` for choosing it. Nothing about the account
    reaches the wire; the route takes no username.

    Bash exits 1 on a rejection (this is a daily launchd job, not a
    cycle-wired step, so a loud failure is wanted there). Here the failure
    is REPORTED rather than raised, and the CLI maps it to an exit code:
    the same split the rest of this package uses, and the reason nothing in
    `analysis/` can turn a measurement outage into an exception on some
    future caller's path.
    """
    try:
        data = resources.record_population_metric()
    except (ApiError, WriteNotVerifiedError) as exc:
        # The exception's OWN message, never a hardcoded guess -- an auth
        # failure and an unreachable host are both "rejected" otherwise.
        logger.warning("population-metric: server rejected — %s", exc)
        return PopulationMetricResult(ok=False, reason=str(exc))

    captured_at = data.get("capturedAt")
    persona = _number(data.get("personaCohesion"))
    behavior = _number(data.get("behaviorCohesion"))
    raw_n = data.get("n")
    count = raw_n if isinstance(raw_n, int) and not isinstance(raw_n, bool) else None

    logger.info(
        "population-metric: ok personaCohesion=%s behaviorCohesion=%s n=%s",
        persona,
        behavior,
        count,
    )
    return PopulationMetricResult(
        ok=True,
        captured_at=captured_at if isinstance(captured_at, str) else None,
        persona_cohesion=persona,
        behavior_cohesion=behavior,
        n=count,
    )
