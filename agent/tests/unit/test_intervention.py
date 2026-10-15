"""`analysis/intervention.py` -- the human-intervention record.

Three manual interventions happened during the drift experiment and none of
them appears in any `/lab` series. What this file pins is not "an event was
posted" but the four properties that decide whether such a record is worth
anything at all:

1. **It carries the instant it is ABOUT.** Every `/lab` read of `agent_events`
   orders and filters by `created_at`, so a marker recorded weeks later with
   today's timestamp annotates the wrong stretch of the series -- which is
   indistinguishable from not recording it.
2. **`metrics` is flat.** `agentEventIngest.metrics` is a `z.record` of flat
   scalars; a nested value 400s the WHOLE event, and both runtimes swallow
   the 400. That defect ran six weeks undetected. Here the operator cannot
   pass a mapping at all.
3. **A rejection is LOUD.** `Resources.lab_event` swallows every `ApiError`
   by contract. An intervention is filed once, by hand, and nothing retries
   it, so this path uses `record_intervention`, which raises.
4. **The dating BASIS travels with the date.** A commit timestamp is an upper
   bound on an edit that happened at some unknown earlier moment; an archive
   header is a second-accurate observation. An analyst who cannot tell them
   apart reads a bound as a measurement.

The fixtures below make each of those discriminable rather than merely
asserted (standing constraint §4): `OCCURRED_AT` is far in the past AND in a
non-UTC zone, so "kept the instant" and "kept the offset" are two different
failures; `WINDOW_START` is a different instant again; and the kind under
test is varied so a hardcoded artifact/gateBypassed pair cannot pass.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import httpx
import pytest

from swil_agent.analysis.intervention import (
    DatingBasis,
    InterventionKind,
    build_intervention_event,
    run_intervention,
)
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, WriteNotVerifiedError

# 01:35:04 in PDT, which is 08:35:04 UTC -- the real archive header of the
# 2026-08-05 `liushang` rollback. A fixture in UTC could not tell "normalised
# to UTC" from "dropped the offset", and one dated today could not tell
# "carried the instant" from "used now()".
PDT = timezone(timedelta(hours=-7))
OCCURRED_AT = datetime(2026, 8, 5, 1, 35, 4, tzinfo=PDT)
OCCURRED_AT_UTC = "2026-08-05T08:35:04+00:00"

# A DIFFERENT instant, so `windowStartsAt` cannot pass by echoing `occurredAt`.
WINDOW_START = datetime(2026, 7, 25, 4, 39, 56, tzinfo=PDT)
WINDOW_START_UTC = "2026-07-25T11:39:56+00:00"


def _event(**overrides: Any) -> LabEvent:
    kwargs: dict[str, Any] = {
        "kind": InterventionKind.PERSONALITY_ROLLBACK,
        "occurred_at": OCCURRED_AT,
        "summary": "手工干预：短语固着回滚",
        "evidence": "personality.archive.md header 2026-08-05 01:35:04",
        "dated_from": DatingBasis.ARCHIVE_HEADER,
    }
    kwargs.update(overrides)
    return build_intervention_event(**kwargs)


def _resources(handler: Any) -> Resources:
    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(handler)
    )
    return Resources(client)


# ── the wire body ──────────────────────────────────────────────────────────


def test_the_event_is_typed_anomaly_on_both_type_and_phase() -> None:
    """`anomaly` is already in the zod enum, the Drizzle `$type`, the server
    DTO and the client's mirror -- verified before writing anything, and NO
    migration is involved. Pinned so a future emitter cannot quietly file this
    as a `cycle` event and disappear into the round timeline."""
    wire = _event().to_wire()
    assert wire["type"] == "anomaly"
    assert wire["phase"] == "anomaly"
    assert wire["outcome"] == "flagged"


def test_the_event_carries_the_instant_it_is_about_normalised_to_utc() -> None:
    """The whole point. `agent_events` has no `captured_at`, so `occurredAt`
    overrides `created_at` -- the column every `/lab` read sorts by.

    Normalised to UTC rather than sent as-is: `z.coerce.date()` hands the
    string to `new Date(...)`, and while an offset-qualified value survives
    that intact, an unqualified one is resolved in the SERVER's zone. Sending
    UTC removes the question.
    """
    assert _event().to_wire()["occurredAt"] == OCCURRED_AT_UTC


def test_every_metrics_value_is_a_flat_scalar() -> None:
    """The six-week defect, made impossible rather than caught: this function
    takes no mapping argument, so there is no way for a caller to introduce a
    nested value. Asserted over the WHOLE dict rather than the fields this
    task happens to write, so a later addition of a list or an object is
    caught by the same test."""
    metrics = _event(window_start=WINDOW_START).to_wire()["metrics"]
    assert metrics
    for key, value in metrics.items():
        assert isinstance(value, str | int | float | bool) or value is None, (key, value)
    # ...and it really is JSON-serialisable as sent, which is the property the
    # server's zod schema actually tests.
    assert json.loads(json.dumps(metrics)) == metrics


@pytest.mark.parametrize(
    ("kind", "artifact", "gate_bypassed"),
    [
        (InterventionKind.PERSONALITY_ROLLBACK, "personality.md", True),
        (InterventionKind.PERSONALITY_EDIT, "personality.md", True),
        (InterventionKind.MEMORY_EDIT, "memory.md", False),
        (InterventionKind.OTHER, "", False),
    ],
)
def test_the_artifact_and_gate_flag_are_derived_from_the_kind(
    kind: InterventionKind, artifact: str, gate_bypassed: bool
) -> None:
    """Derived, not asked for. `gateBypassed` is the single most load-bearing
    fact for anyone reading the drift series -- it says the constitution layer
    did not see this write, so the series has a gap the gate otherwise
    guarantees it does not -- and an operator free to set it independently of
    the kind is an operator who eventually will set it wrong.

    All four kinds, because two of them share an artifact and two share a
    flag: a table that mapped every kind to the same pair would pass any
    single row.
    """
    metrics = _event(kind=kind).to_wire()["metrics"]
    assert metrics["intervention"] == kind.value
    assert metrics["artifact"] == artifact
    assert metrics["gateBypassed"] is gate_bypassed


def test_the_dating_basis_travels_with_the_date() -> None:
    metrics = _event(dated_from=DatingBasis.COMMIT).to_wire()["metrics"]
    assert metrics["datedFrom"] == "commit"


def test_a_bounded_instant_records_its_window_and_an_observed_one_does_not() -> None:
    """`windowStartsAt` is present ONLY when the instant is a bound, so "we
    know when" and "we know only within a range" stay distinguishable at read
    time. Asserted both ways: a key that were always present, or always
    absent, would pass one half alone."""
    bounded = _event(dated_from=DatingBasis.COMMIT, window_start=WINDOW_START)
    assert bounded.to_wire()["metrics"]["windowStartsAt"] == WINDOW_START_UTC
    assert "windowStartsAt" not in _event().to_wire()["metrics"]


def test_the_reason_is_omitted_when_blank_and_kept_when_given() -> None:
    """Both halves, because an implementation that always omitted `reason`
    would pass the first assertion vacuously -- the same trap
    `test_lab_event_omits_empty_optional_fields` names in `test_resources.py`."""
    assert "reason" not in _event(reason="   ").to_wire()
    assert "reason" not in _event(reason=None).to_wire()
    assert _event(reason="phrase fixation").to_wire()["reason"] == "phrase fixation"


# ── what it refuses ────────────────────────────────────────────────────────


def test_an_empty_summary_is_refused() -> None:
    with pytest.raises(ValueError, match="summary"):
        _event(summary="   ")


def test_an_over_length_summary_is_refused_before_the_server_sees_it() -> None:
    """The server caps `summary` at 500 (`runtime/runtime.schemas.ts`). Checked here so
    the operator is told which field is too long instead of being handed a 400
    whose body the CLI would have to unpick at 2am."""
    with pytest.raises(ValueError, match="500"):
        _event(summary="x" * 501)


def test_an_over_length_reason_is_refused() -> None:
    with pytest.raises(ValueError, match="300"):
        _event(reason="x" * 301)


def test_empty_evidence_is_refused() -> None:
    """Required, not optional: a record nobody can check against a header, a
    commit or a note is a rumour in the one series whose job is to make the
    data auditable."""
    with pytest.raises(ValueError, match="evidence"):
        _event(evidence="  ")


def test_a_naive_instant_is_refused_rather_than_guessed_at() -> None:
    """A naive value formats without an offset and lands in the SERVER's zone
    -- seven hours out here, small enough to still look like a plausible
    timestamp."""
    with pytest.raises(ValueError, match="aware"):
        _event(occurred_at=datetime(2026, 8, 5, 1, 35, 4))


def test_a_naive_window_start_is_refused_too() -> None:
    with pytest.raises(ValueError, match="window_start"):
        _event(window_start=datetime(2026, 7, 25, 4, 39, 56))


def test_lab_event_refuses_a_naive_occurred_at_at_construction() -> None:
    """The same guard one layer down, so a future emitter that bypasses
    `build_intervention_event` cannot ship a zone-less instant either."""
    with pytest.raises(ValueError, match="aware"):
        LabEvent(
            type="anomaly",
            phase="anomaly",
            outcome="flagged",
            summary="x",
            occurred_at=datetime(2026, 8, 5, 1, 35, 4),
        )


def test_an_event_without_occurred_at_sends_no_such_key() -> None:
    """Every live-runtime event happens now, and `created_at` already defaults
    to now(). Sending the key anyway would make an act event's timestamp a
    claim by the client instead of a fact recorded by the server."""
    wire = LabEvent(type="cycle", phase="act", outcome="success", summary="hi").to_wire()
    assert "occurredAt" not in wire


# ── the write: verified and loud ───────────────────────────────────────────


def test_record_intervention_returns_the_created_event_id() -> None:
    """The envelope is `{data: {event: {id}}}` -- `ok(res, { event }, 201)`
    inside `respond.ts`'s `{data, meta}` -- so the id is TWO levels down, not
    one like every snapshot route's `{data: {id}}`."""
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/agents/liushang/events"
        bodies.append(json.loads(request.content))
        return httpx.Response(201, json={"data": {"event": {"id": "evt-1"}}})

    assert _resources(handler).record_intervention("liushang", _event()) == "evt-1"
    assert bodies[0]["occurredAt"] == OCCURRED_AT_UTC


def test_record_intervention_raises_on_a_2xx_with_no_id() -> None:
    """A 200 whose body carries no event is the shape a silently-rejected
    write takes. `lab_event` cannot tell that from success; this must."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {}})

    with pytest.raises(WriteNotVerifiedError):
        _resources(handler).record_intervention("liushang", _event())


def test_record_intervention_raises_where_lab_event_would_swallow() -> None:
    """The two methods hit the SAME route and differ only in this. A 403 is
    the realistic one: the server requires the actor to BE that account
    (`agent.id !== actor.id`), so a credential for the wrong account fails in
    a way no return value distinguishes from success."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "FORBIDDEN", "message": "nope"}})

    resources = _resources(handler)
    resources.lab_event("liushang", _event())  # swallowed, by contract
    with pytest.raises(ApiError):
        resources.record_intervention("liushang", _event())


# ── run_intervention: reports, never raises ────────────────────────────────


def test_run_intervention_reports_the_event_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"event": {"id": "evt-9"}}})

    result = run_intervention(_resources(handler), username="liushang", event=_event())

    assert result.ok is True
    assert result.event_id == "evt-9"
    assert result.reason is None


def test_run_intervention_reports_a_rejection_with_the_servers_own_message() -> None:
    """Reported, not raised -- the CLI owns exit codes, exactly as
    `run_population_metric` has it. The server's OWN message, never a
    hardcoded guess: a 403 (wrong account) and a 400 (rejected body) have
    completely different fixes and would otherwise read identically."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "VALIDATION", "message": "bad body"}})

    result = run_intervention(_resources(handler), username="liushang", event=_event())

    assert result.ok is False
    assert result.event_id is None
    assert "bad body" in (result.reason or "")


def test_run_intervention_logs_the_account_and_the_instant(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": {"event": {"id": "evt-2"}}})

    with caplog.at_level("INFO", logger="swil_agent.analysis.intervention"):
        run_intervention(_resources(handler), username="liushang", event=_event())

    message = caplog.records[-1].getMessage()
    assert "liushang" in message
    assert OCCURRED_AT.astimezone(UTC).isoformat() in message
