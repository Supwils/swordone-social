"""What one executed action produces, and the helpers every per-kind
executor shares to build it: field cleaning, the error detail, the
`ExecutionOutcome` constructor and the local field-validation SKIP.

Moved out of `act/executor.py` verbatim (S3 §12.27); that module's per-kind
`_execute_*` functions are the only callers.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from swil_agent.api.client import ApiError
from swil_agent.api.dto import (
    REASON_MAX_UNITS,
    SUMMARY_MAX_UNITS,
    TARGET_ID_MAX_UNITS,
    LabEvent,
    cap_utf16,
)
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.models import Action, ActionResult

_LAB_TYPE = "cycle"
_LAB_PHASE = "act"


class ExecutionOutcome(BaseModel):
    """Everything one executed action produces: the `ActionResult` a round
    tally cares about, the act-log line a caller may want to
    print (contract `02` §5.2), and the exact `LabEvent` this module already
    emits via `Resources.lab_event` (contract `02` §5.3) — exposed here too
    so a future caller (a round-level orchestrator) can reconstruct or
    re-log the same line without recomputing it from `ActionResult` alone.
    """

    result: ActionResult
    log_line: str
    lab_event: LabEvent


def _clean(raw: str | None) -> str:
    """Newlines deleted (not replaced with a space), runs of spaces collapsed
    to one, then trimmed.

    The trailing `.strip()` makes a whitespace-only text empty, so
    `Action(kind="post", text="   ")` is a local SKIP with no `Resources`
    call at all instead of a network round-trip the server would 400.
    """
    text = (raw or "").replace("\n", "")
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _clean_username(raw: str | None) -> str:
    """Every `@` and
    every whitespace character removed, anywhere in the string — not just
    a leading `@` or surrounding trim.
    """
    return re.sub(r"[@\s]", "", raw or "")


def _error_detail(exc: ApiError | WriteNotVerifiedError) -> str:
    """The response body, preserved into the log (design spec §7.6).

    `ApiError.__str__` already renders `"HTTP {status}: {body[:300]}"`
    (`api/client.py`) — including `TransportError`, an `ApiError` subclass
    for the "never got a response at all" case — so returning it unmodified
    already fixes the `2>/dev/null` blind spot. `WriteNotVerifiedError` gets
    an explicit "not verified" prefix so a 2xx-with-no-id failure reads as a
    distinct failure class from a genuine 4xx/5xx wherever `detail` surfaces
    (log line, `/lab`, a human skimming the act log).
    """
    if isinstance(exc, WriteNotVerifiedError):
        return f"write not verified: {exc}"
    return str(exc)


def _outcome(
    action: Action,
    *,
    landed: bool,
    resource_id: str | None,
    detail: str | None,
    log_line: str,
    lab_outcome: str,
    lab_summary: str,
    lab_reason: str | None = None,
    lab_target_id: str | None = None,
    conversation_id: str | None = None,
    call_succeeded: bool | None = None,
) -> ExecutionOutcome:
    # `call_succeeded` DERIVES from `landed` unless a branch says otherwise,
    # so the two cannot drift apart by accident: the only caller that passes
    # it explicitly is `_execute_follow`'s 409/`CONFLICT` branch, the single
    # place a follow can be landed without a memory line (loop-engine spec
    # §6; see `ActionResult`).
    result = ActionResult(
        action=action,
        landed=landed,
        resource_id=resource_id,
        detail=detail,
        conversation_id=conversation_id,
        call_succeeded=landed if call_succeeded is None else call_succeeded,
    )
    # Summary, reason and target id carry model output (post text, a
    # username, a post id), so each is capped to the server's bound here:
    # one over it 400s the whole event, and `lab_event` swallows that.
    event = LabEvent(
        type=_LAB_TYPE,
        phase=_LAB_PHASE,
        outcome=lab_outcome,
        action=action.kind,
        summary=cap_utf16(lab_summary, SUMMARY_MAX_UNITS),
        reason=None if lab_reason is None else cap_utf16(lab_reason, REASON_MAX_UNITS),
        target_id=None if lab_target_id is None else cap_utf16(lab_target_id, TARGET_ID_MAX_UNITS),
    )
    return ExecutionOutcome(result=result, log_line=log_line, lab_event=event)


def _skip(
    action: Action, *, agent_name: str, field_detail: str, lab_summary: str
) -> ExecutionOutcome:
    """Every per-kind field-validation skip (contract `02` §2, "the SKIP is
    per-action rather than for the whole plan" — §1.4). No `Resources` call
    is ever reached on this path; `resources.calls == []` is the test
    assertion that carries that weight.
    """
    return _outcome(
        action,
        landed=False,
        resource_id=None,
        detail=f"{action.kind} — {field_detail}",
        log_line=f"SKIP {agent_name} {action.kind} — {field_detail}",
        lab_outcome="skip",
        lab_summary=lab_summary,
    )
