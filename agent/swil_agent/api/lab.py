"""`Resources`' observation-lab writes: lab events, post vectors, the
intervention record, personality and behavior snapshots, the bench run and
the population metric.

A mixin composed into `Resources` (S3 §9); it reaches the API only through
`self._client`, which `Resources.__init__` sets. Logs under
`swil_agent.api.resources`, the name these lines had before the split.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Literal

from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.envelope import WriteNotVerifiedError, _nested_id
from swil_agent.api.ingest_throttle import retry_after_seconds
from swil_agent.api.paths import username_segment

logger = logging.getLogger("swil_agent.api.resources")

VectorFilingStatus = Literal["filed", "echo", "rate_limited", "failed"]


@dataclass(frozen=True)
class VectorFiling:
    """One post-vector ingest's outcome. `echo` is the server's refusal of an
    echo post (400, `fields.postId == "ECHO"`); `retry_after` (seconds) is
    set only on `rate_limited`, and only when the 429 said how long."""

    status: VectorFilingStatus
    retry_after: float | None = None


def _is_echo_refusal(exc: ApiError) -> bool:
    if exc.status != 400:
        return False
    try:
        payload: Any = json.loads(exc.body)
    except ValueError:
        return False
    error = payload.get("error") if isinstance(payload, dict) else None
    fields = error.get("fields") if isinstance(error, dict) else None
    return isinstance(fields, dict) and fields.get("postId") == "ECHO"


class LabWrites:
    """The `/agents/*` writes the lab and its samplers file."""

    _client: ApiClient

    def lab_event(self, username: str, event: LabEvent) -> None:
        """Best-effort observability write.

        A lab-event outage must never change a round's outcome (contract 02
        §5.3), so this never raises an `ApiError`. It is not silent, though:
        a refused event (a 400 on an over-long field, a 403 from the wrong
        key, the server down) is one WARNING naming the event and the error,
        because a ledger that drops rows without a trace is not a ledger.
        """
        try:
            self._client.post(f"/agents/{username_segment(username)}/events", json=event.to_wire())
        except ApiError as exc:
            logger.warning(
                "lab event %s/%s/%s for %s was not filed: %s",
                event.type,
                event.phase,
                event.outcome,
                username,
                exc,
            )

    def post_vector(
        self,
        username: str,
        *,
        post_id: str,
        round_id: str | None,
        embedding: list[float],
        card_sim: float | None,
        max_sim: float | None,
    ) -> bool:
        """POST /agents/{username}/post-vectors (S2 §5): one post's bge-m3
        vector and its two similarities. True when the server filed it.

        Best-effort like `lab_event` -- a measurement outage never changes a
        round -- but LOGGED and answered, because the caller records an
        unfiled vector on the cycle_run card. The ingest is idempotent on
        `postId` (201 new, 200 existing); a 409 (a different non-null round),
        a 429, an echo refusal or any other rejection is a False. `roundId` is
        sent as `null`, not omitted, when unknown: the server then resolves it.
        """
        return (
            self.file_post_vector(
                username,
                post_id=post_id,
                round_id=round_id,
                embedding=embedding,
                card_sim=card_sim,
                max_sim=max_sim,
            ).status
            == "filed"
        )

    def file_post_vector(
        self,
        username: str,
        *,
        post_id: str,
        round_id: str | None,
        embedding: list[float],
        card_sim: float | None,
        max_sim: float | None,
    ) -> VectorFiling:
        """`post_vector` with the outcome spelled out, for the backfill: a
        429 carries how long to wait, and the server's echo refusal is told
        apart from a failure. Never raises."""
        body: dict[str, Any] = {
            "postId": post_id,
            "roundId": round_id,
            "embedding": embedding,
            "cardSim": card_sim,
            "maxSim": max_sim,
        }
        try:
            response = self._client.post(
                f"/agents/{username_segment(username)}/post-vectors", json=body
            )
        except ApiError as exc:
            logger.warning("post-vector for %s (post %s) failed: %s", username, post_id, exc)
            if exc.status == 429:
                return VectorFiling("rate_limited", retry_after_seconds(exc.headers))
            if _is_echo_refusal(exc):
                return VectorFiling("echo")
            return VectorFiling("failed")
        if _nested_id(response, "data", "id") is None:
            logger.warning(
                "post-vector for %s (post %s) was not filed: %s", username, post_id, response
            )
            return VectorFiling("failed")
        return VectorFiling("filed")

    def record_intervention(self, username: str, event: LabEvent) -> str:
        """`lab_event`'s LOUD twin: same route, verified, and it raises.

        `lab_event` swallows every `ApiError` because a measurement outage
        must not change a round's outcome. A human intervention record is the
        opposite kind of write: it is filed once, by hand, deliberately, and a
        silent failure means the analysis it exists to correct goes on being
        wrong. Nothing retries it and nothing else will notice.

        The two silent failures this closes are both real. `agentEventIngest`
        400s the WHOLE event on a nested `metrics` value (`z.record` of flat
        scalars only), a defect that ran six weeks undetected because Bash's
        `|| true` and this class's own `except ApiError` both discard it. And
        `POST /agents/{username}/events` requires the actor to BE that
        account (`runtime/events.ts`'s `agent.id !== actor.id` -> 403), so a
        credential for the wrong account fails in a way no return value
        distinguishes from success.

        Returns the created event's id. The envelope is
        `{data: {event: {id}}}` -- `ok(res, { event }, 201)`
        (runtime/runtime.controller.ts) inside `respond.ts`'s `{data, meta}` -- so the
        id is TWO levels down, not one like every snapshot route's
        `{data: {id}}`. A 2xx without it is a rejection, not a success.
        """
        response = self._client.post(
            f"/agents/{username_segment(username)}/events", json=event.to_wire()
        )
        event_id = _nested_id(response, "data", "event", "id")
        if event_id is None:
            raise WriteNotVerifiedError(f"lab event rejected by server: {response}")
        return event_id

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        """POST a personality snapshot; return the created id.

        Raises WriteNotVerifiedError when the server answers 200 without a
        `data.id`, which is the "server rejected" case.
        """
        response = self._client.post(
            f"/agents/{username_segment(username)}/snapshots", json=payload
        )
        snapshot_id = _nested_id(response, "data", "id")
        if snapshot_id is None:
            raise WriteNotVerifiedError(f"snapshot rejected by server: {response}")
        return snapshot_id

    def create_behavior_snapshot(
        self, username: str, payload: dict[str, Any]
    ) -> tuple[str, float | None]:
        """POST a BEHAVIOR snapshot; return `(id, fidelity)`.

        A DIFFERENT endpoint from `create_snapshot` above, with a different
        body and a different response: `ingestBehavior` answers
        `ok(res, { id, fidelity }, 201)`
        (server/src/modules/agents/persona/persona.controller.ts, returning
        `persona/drift.ts`'s `{ id, fidelity }`), so the envelope is
        `{"data": {"id": ..., "fidelity": ...}}`.

        `fidelity` is `null` whenever the account has no personality
        snapshot to compare against (`persona/drift.ts`), which is
        the normal state for an account whose first dream has not landed
        yet -- so `None` here is data, not an error, and is reported as
        "n/a".

        Raises WriteNotVerifiedError when the server answers 2xx with no
        `data.id`, which is the "server rejected" case.
        """
        response = self._client.post(
            f"/agents/{username_segment(username)}/behavior-snapshots", json=payload
        )
        snapshot_id = _nested_id(response, "data", "id")
        if snapshot_id is None:
            raise WriteNotVerifiedError(f"behavior snapshot rejected by server: {response}")
        data = response.get("data")
        raw = data.get("fidelity") if isinstance(data, dict) else None
        # `isinstance(True, int)` is True in Python, and a JSON `true` here
        # would otherwise become `1.0` -- a perfect fidelity score invented
        # out of a boolean.
        if isinstance(raw, bool) or not isinstance(raw, int | float):
            return snapshot_id, None
        return snapshot_id, float(raw)

    def record_benchmark_run(self, body: dict[str, Any]) -> str:
        """POST /agents/benchmark/runs (Persona Bench); return the row id.

        `bench.controller.ts` answers `ok(res, { id }, 201)`, so the id is
        `data.id`. Raises `ApiError` (a 429 carries `Retry-After` in its
        headers, for the caller's wait) and `WriteNotVerifiedError` on a 2xx
        without an id. Authorised by the replayed persona's own key.
        """
        response = self._client.post("/agents/benchmark/runs", json=body)
        run_id = _nested_id(response, "data", "id")
        if run_id is None:
            raise WriteNotVerifiedError(f"benchmark run rejected by server: {response}")
        return run_id

    def record_population_metric(self) -> dict[str, Any]:
        """POST /agents/population-metric -- GLOBAL, no username, no body.

        `populationRouter.post('/population-metric', requireUser, ...)`
        (population/population.routes.ts) is mounted before the `/:username/*`
        routes, so this is a literal path and ANY lab account's api_key
        authorises it. The request has no body: `json=None` makes httpx omit
        it entirely rather than sending `null`.

        Returns the `data` object (`capturedAt`, `personaCohesion`,
        `behaviorCohesion`, `n` -- `population/population.ts`).

        The verification is `data.capturedAt`: `null`, `false` and a missing
        key are the rejection. A degenerate
        sample (`n < 2`) is deliberately NOT historised by the server but
        still answers with a `capturedAt`, so it counts as success here
        as well.
        """
        response = self._client.post("/agents/population-metric")
        data = response.get("data")
        captured_at = data.get("capturedAt") if isinstance(data, dict) else None
        if not isinstance(data, dict) or captured_at is None or captured_at is False:
            raise WriteNotVerifiedError(f"population metric rejected by server: {response}")
        return data
