"""The invocation gates, below the CLI (`swil_agent/policy.py`, S3 §6).

`test_cli.py` pins what each command prints and exits with; this pins the
decisions themselves, which raise domain errors and never touch Typer.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from swil_agent.policy import (
    PRODUCTION_HOST,
    EraNotOpenError,
    ProductionWritesRefusedError,
    is_production_url,
    refuse_production_writes,
    require_era_start,
)

_PROD = f"https://{PRODUCTION_HOST}"


def test_the_production_host_is_compared_as_a_hostname_not_a_substring() -> None:
    assert is_production_url(_PROD)
    assert is_production_url(f"{_PROD}:443/api")
    assert not is_production_url(f"https://staging.example/?next={PRODUCTION_HOST}")
    assert not is_production_url("")


def test_production_writes_are_refused_only_with_the_flag_on_and_no_override() -> None:
    with pytest.raises(ProductionWritesRefusedError):
        refuse_production_writes(_PROD, i_mean_production=False, require_non_prod=True)
    refuse_production_writes(_PROD, i_mean_production=True, require_non_prod=True)
    refuse_production_writes(_PROD, i_mean_production=False, require_non_prod=False)
    refuse_production_writes(
        "http://localhost:8899", i_mean_production=False, require_non_prod=True
    )


def test_an_unset_era_start_is_refused() -> None:
    with pytest.raises(EraNotOpenError):
        require_era_start(None)
    require_era_start(datetime(2026, 10, 14, tzinfo=UTC))
