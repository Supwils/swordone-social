"""One human intervention, recorded as a first-class `/lab` event.

Three manual interventions happened during the drift experiment and none of
them appears in any `/lab` series, so every longitudinal read of that window
is wrong and looks fine:

  * `liushang`'s `personality.md` was hand-rolled back on 2026-08-05 for
    phrase fixation, bypassing the drift gate entirely -- the archive header
    (`归档于 2026-08-05 01:35:04，手工干预：短语固着回滚`) is the only trace.
  * ten entries were deleted from `liushang`'s `memory.md` at the same
    moment, which changes what every later dream prompt was built from.
  * `lvchuang`'s `personality.md` was rewritten out of band with NO archive
    entry, so no snapshot exists and `/lab` draws a flat drift line through
    a stretch where the document actually moved.

**This module is the one member of `analysis/` that is never called from a
round.** Its siblings are fail-soft by contract because Bash calls them with
`|| true` inside a cycle. This one is operator-driven, runs once, by hand,
and is deliberately LOUD: nothing retries it, nothing else notices, and a
silently-dropped record leaves the analysis it exists to correct exactly as
wrong as it was. `Resources.record_intervention` (not `lab_event`) is what
carries that difference onto the wire.

**Everything on the wire is built here, from scalars.** `metrics` is a
`z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))`
(`runtime/runtime.schemas.ts`) -- flat only, and a nested object or array 400s the
WHOLE event, which is the defect that ran six weeks undetected. The caller
never hands in a mapping: it passes typed scalar arguments and this module
assembles the dict, so a nested value is not something an operator can
express at 2am. That is the design point of the whole module -- the guard is
the absence of the footgun, not a check that catches it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ConfigDict

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, WriteNotVerifiedError

logger = logging.getLogger(__name__)

# `agent_events.type` and `.phase` both already carry `anomaly` -- in the zod
# enum (`runtime/runtime.schemas.ts`), in the Drizzle `$type` (`db/schema/lab.ts`), in
# `AgentEventDTO` and in the client's mirror of it. Verified before writing
# anything; NO migration is involved in recording an intervention.
EVENT_TYPE: Final = "anomaly"
EVENT_PHASE: Final = "anomaly"

# `flagged`, not `warn`: the same outcome `echo_flag` and `rule_check` use for
# "a human should look at this window". `population/pulse.ts` keys its alert reads
# on (type, outcome) PAIRS -- `dream|fail`, `echo_flag|flagged`,
# `rule_check|flagged` -- so `anomaly|flagged` collides with none of them.
EVENT_OUTCOME: Final = "flagged"

# The server's own caps (`runtime/runtime.schemas.ts`), checked here so the operator is
# told which field is too long instead of being handed a 400 whose body the
# CLI would have to unpick.
MAX_SUMMARY: Final = 500
MAX_REASON: Final = 300


class InterventionKind(StrEnum):
    """A closed set, because an open one is how a series gets annotated with
    a label nobody can query for later.

    `OTHER` exists so an intervention that does not fit is still recorded
    rather than skipped -- an unrecorded intervention is strictly worse than
    a coarsely-labelled one -- and its `summary` carries what happened.
    """

    PERSONALITY_ROLLBACK = "personality_rollback"
    PERSONALITY_EDIT = "personality_edit"
    MEMORY_EDIT = "memory_edit"
    OTHER = "other"


class DatingBasis(StrEnum):
    """HOW the timestamp was established, recorded next to it.

    A backfilled event's `occurredAt` is only as good as its provenance, and
    the four cases have genuinely different confidence: an archive header is
    a second-accurate observation, a commit date is an UPPER BOUND on an edit
    that happened at some unknown earlier point, a memory-note line is
    date-accurate only, and `OBSERVED` is a human watching the clock. An
    analyst who cannot tell those apart will read a bound as a measurement.
    """

    ARCHIVE_HEADER = "archive-header"
    COMMIT = "commit"
    MEMORY_NOTE = "memory-note"
    OBSERVED = "observed"


# Which file the intervention touched. Derived from the kind rather than
# taken as a fifth required option: it is not an independent fact, and an
# operator free to pair `memory_edit` with `personality.md` is an operator
# who eventually will.
ARTIFACT_BY_KIND: Final[dict[InterventionKind, str]] = {
    InterventionKind.PERSONALITY_ROLLBACK: "personality.md",
    InterventionKind.PERSONALITY_EDIT: "personality.md",
    InterventionKind.MEMORY_EDIT: "memory.md",
    InterventionKind.OTHER: "",
}

# Did this write reach `personality.md` without passing the constitution
# layer (archive -> drift gate -> validators -> snapshot)? Also derived: it
# is a consequence of the kind, and it is the single most load-bearing fact
# for anyone reading the drift series, because it is precisely the case where
# the series has a gap the gate would otherwise guarantee it does not.
GATE_BYPASSED_BY_KIND: Final[dict[InterventionKind, bool]] = {
    InterventionKind.PERSONALITY_ROLLBACK: True,
    InterventionKind.PERSONALITY_EDIT: True,
    InterventionKind.MEMORY_EDIT: False,
    InterventionKind.OTHER: False,
}


class InterventionResult(BaseModel):
    """What one `run_intervention` call recorded.

    `event_id` is `None` on every failure and never `""`: an empty id would
    format into a success line indistinguishable from a real one.
    """

    model_config = ConfigDict(frozen=True)

    ok: bool
    reason: str | None = None
    event_id: str | None = None


def build_intervention_event(
    *,
    kind: InterventionKind,
    occurred_at: datetime,
    summary: str,
    evidence: str,
    dated_from: DatingBasis,
    reason: str | None = None,
    window_start: datetime | None = None,
) -> LabEvent:
    """Assemble the wire event. Raises `ValueError` on anything the server
    would reject, naming the field.

    `occurred_at` (and `window_start`) must be timezone-aware, and are
    REFUSED rather than resolved if they are not. A naive value formats
    without an offset, and zod's `z.coerce.date()` resolves that in the
    SERVER's timezone -- so a stamp copied out of a local `date` line would
    land seven hours from where it belongs, which is small enough to still
    look like a plausible timestamp.

    `.astimezone(UTC)` on a naive datetime would have ANSWERED that question
    by assuming local time, silently, which is why the check comes first: the
    "assume local" decision belongs at exactly one place, `cli/analysis.py`'s
    `_intervention_instant`, where the resolved instant is echoed back to the
    operator before anything is sent. A library caller gets an error instead
    of a guess.

    Every `metrics` value below is a `str` or a `bool` by construction. This
    function is the only thing that writes that dict, and it takes no mapping
    argument, so a nested value -- the shape that 400s the whole event -- has
    no way in.
    """
    if occurred_at.tzinfo is None:
        raise ValueError("occurred_at must be timezone-aware")
    clean_summary = summary.strip()
    if not clean_summary:
        raise ValueError("summary must not be empty")
    if len(clean_summary) > MAX_SUMMARY:
        raise ValueError(f"summary is {len(clean_summary)} chars; the server caps it at 500")
    clean_reason = (reason or "").strip()
    if len(clean_reason) > MAX_REASON:
        raise ValueError(f"reason is {len(clean_reason)} chars; the server caps it at 300")
    clean_evidence = evidence.strip()
    if not clean_evidence:
        # Required, not optional. An intervention record whose claim cannot be
        # traced back to an archive header, a commit or a note is a rumour in
        # the one series that exists to make the data auditable.
        raise ValueError("evidence must not be empty")

    metrics: dict[str, str | bool] = {
        "intervention": kind.value,
        "artifact": ARTIFACT_BY_KIND[kind],
        "gateBypassed": GATE_BYPASSED_BY_KIND[kind],
        "datedFrom": dated_from.value,
        "evidence": clean_evidence,
    }
    if window_start is not None:
        if window_start.tzinfo is None:
            raise ValueError("window_start must be timezone-aware")
        # Present only when the instant is BOUNDED rather than observed: the
        # edit happened somewhere in [windowStartsAt, occurredAt]. Omitting
        # the key when there is no window keeps "we know when" and "we know
        # only within a range" distinguishable at read time.
        metrics["windowStartsAt"] = window_start.astimezone(UTC).isoformat()

    # EQUIVALENT MUTANT, conditionally (standing constraint §7): `reason=
    # clean_reason` -- without the `or None` -- is undetectable today, because
    # `LabEvent.to_wire` omits the field on `if self.reason:` and `""` is
    # falsy. It is written with the `or None` anyway so the model's own value
    # says "absent" rather than "present and empty". The equivalence EXPIRES
    # the moment `to_wire` tests `is not None` (which is the correct test for
    # every other optional field it could grow), at which point the mutant
    # starts sending `"reason": ""` and changes what `/lab` counts.
    return LabEvent(
        type=EVENT_TYPE,
        phase=EVENT_PHASE,
        outcome=EVENT_OUTCOME,
        summary=clean_summary,
        reason=clean_reason or None,
        occurred_at=occurred_at.astimezone(UTC),
        metrics=dict(metrics),
    )


def run_intervention(resources: Resources, *, username: str, event: LabEvent) -> InterventionResult:
    """File the record. Never raises; the CLI turns the result into an exit
    code, exactly as `run_population_metric` does.

    Reporting the failure rather than raising it keeps this module's contract
    identical to its siblings' at the call boundary -- but the failure is not
    swallowed the way `Resources.lab_event` swallows one. It is returned, and
    `swil-agent intervention` exits 75 on it and prints the server's own
    message, because the two ways this call fails in practice both look like
    success from inside a fail-soft path: a nested `metrics` value 400s, and
    a credential for the wrong account 403s.
    """
    try:
        event_id = resources.record_intervention(username, event)
    except (ApiError, WriteNotVerifiedError) as exc:
        logger.warning("intervention: %s — server rejected — %s", username, exc)
        return InterventionResult(ok=False, reason=str(exc))

    logger.info(
        "intervention: %s — recorded id=%s at=%s (%s)",
        username,
        event_id,
        event.occurred_at.isoformat() if event.occurred_at else "now",
        event.metrics.get("intervention"),
    )
    return InterventionResult(ok=True, event_id=event_id)
