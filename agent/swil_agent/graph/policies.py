"""The cycle graph's retry policies, one per node that has one.

Moved verbatim out of `graph/cycle.py` (S3 §12.27) so that module stays under
the size cap. Every phase graph (`CYCLE`, `ACT`, `DREAM`) attaches the same
policy to the same node, so a subset run retries exactly what the cycle
retries (S3 §12.2(e)).
"""

from __future__ import annotations

from typing import Final

from langgraph.types import RetryPolicy

from swil_agent.api.client import TransportError

# Spec §5.4's node table, as corrected. Read as ATTEMPTS, which is what
# `RetryPolicy` takes -- see this module's report for the one row where the
# brief's literal `max_attempts=1` and its own two required tests disagree
# (`execute`: a policy that never retries makes both "a transient failure IS
# retried" and "widening `retry_on` must be detectable" unsatisfiable).
#
# `guardrail` is PURE (no I/O at all) so it gets none. `write` and `logout`
# are absent from §5.4's table, and `write` sharply so: re-running it archives
# and rewrites `personality.md` a second time.
#
# ── Why NO node keeps the library's default `retry_on` ──────────────────────
#
# Measured against langgraph 1.2.11 (`langgraph._internal._retry`):
# `default_retry_on` answers **False for every `RuntimeError`**, and `ApiError`
# -- hence `TransportError`, which subclasses it -- IS a `RuntimeError`. So a
# bare `RetryPolicy(max_attempts=2)` retries NONE of this codebase's typed
# failures and retries exactly one thing: an unwrapped third-party leak such
# as `httpx.CookieConflict` (spec §15.3 row 17), which is deterministic and
# gains nothing from a second attempt. Every default-predicate policy in this
# module was therefore decorative for the case it was written for.
#
# Each policy below now names what that node may actually survive. Two of them
# name `TransportError` for two DIFFERENT safety arguments; one names nothing
# at all, because nothing transient can reach it. In all three cases a
# permanent `ApiError` (404/403/400) is excluded BY TYPE, which is §5.4's
# "permanent failures are not retried" -- `TransportError` always carries
# `status=0`, so no permanent status can be inside the retried set.
#
# **What can actually reach a node boundary today (measured, 2026-08-18).**
# `ApiError` is the universal wrapper and nearly every step catches it:
# `sync_backend_step` and every block of `build_context` (`except ApiError`),
# `execute_action` (`_WriteFailure = (ApiError, WriteNotVerifiedError)`),
# `_resolve_board_id`, `snapshot_step`, and `Resources.lab_event` /
# `mark_notifications_read`, which never raise at all. `EmbedderClient` wraps
# `httpx.HTTPError` into `EmbedderUnavailable`; `SubprocessRunner` turns a
# timeout into `""` and a missing binary into `BackendBinaryMissingError`. So
# NO `TransportError` reaches any node boundary in the shipped composition.
# The tuples below are the contract for what a future narrowing of one of
# those catches may safely let escape -- not a live retry (standing constraint
# §7: the equivalence is conditional, and this is the condition).

# `login` = probe -> `sync_backend_step` -> `context_step`. The ONE node in
# the cycle that is wholly idempotent: a read-only probe, a PATCH that writes
# the same constant `agentBackend` value every round, and reads. So a retry
# here cannot duplicate anything.
#
# The probe is NOT what this retries, and cannot be: `compose.health_check` returns a
# `bool` and swallows `httpx.HTTPError` itself, so a flaky probe yields
# `online=False` -> `ActOutcome.OFFLINE`, a legitimate round outcome, not an
# exception. Retrying it would also diverge from Bash, which probes exactly
# once per round in Main for the whole roster.
LOGIN_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))

# `plan` gets NO retry, and that is the measured answer rather than an
# omission. This node makes no HTTP call at all -- its one call is an LLM
# SUBPROCESS, and every subprocess failure is already normalised below it:
# `subprocess.TimeoutExpired` -> `""` -> `BackendUnavailableError` ->
# `plan_round` returns `None` -> `ActOutcome.BACKEND_UNAVAILABLE` (a round
# outcome, not an exception). The one thing that does escape,
# `BackendBinaryMissingError`, is permanent -- a `claude`/`codex` absent from
# PATH is not fixed by trying again -- and a retry would simply pay for a
# second LLM call before failing the same way.
PLAN_RETRY: Final = RetryPolicy(max_attempts=1)

# NOT the library default, and narrowly on purpose: `execute_step` walks the
# surviving actions IN ORDER and posts each one, so it is not idempotent --
# a retry after a mid-loop failure re-posts everything that already landed.
# `TransportError` is the one failure that never reached the server
# (`status=0`), so nothing can have landed before it.
#
# What makes even that safe today is that it is UNREACHABLE from inside the
# loop: `execute_action` catches `(ApiError, WriteNotVerifiedError)` around
# every write, `_resolve_board_id` catches `ApiError`, and
# `Resources.lab_event` never raises -- so a transport failure while executing
# an action becomes a `landed=False` `ActionResult` instead of reaching this
# boundary (pinned by `test_a_transport_failure_mid_loop_is_absorbed_...`).
# What CAN reach it after N actions have landed is an `OSError` from the
# `memory.md` append, and this narrow tuple is what stops that from
# re-executing the N (pinned by `test_a_failure_after_an_action_landed_...`).
# If a future change lets a transport failure escape mid-loop, this policy
# becomes a duplicate-post generator and must be narrowed to a per-action
# retry instead.
EXECUTE_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))
DREAM_RETRY: Final = RetryPolicy(max_attempts=1)

# `snapshot` is fail-soft and must never block the cycle -- and it already is,
# INSIDE the step: `snapshot_step` catches `(EmbedderUnavailable,
# WriteNotVerifiedError, ApiError)` and returns `ok=False` with the failure's
# own message. So this policy cannot make the step fail soft; what it does is
# scope the one failure a future narrowing of that catch could let escape.
# `TransportError` is retry-safe HERE for a reason the other nodes do not
# have: the server dedupes snapshots by `contentHash`, so an upload that may
# or may not have landed (which is exactly what `status=0` means) cannot
# produce a duplicate row on a second attempt. `EmbedderUnavailable` is
# deliberately NOT in the tuple -- a daemon that is down stays down for the
# round, and the step already fails open on it.
SNAPSHOT_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))
