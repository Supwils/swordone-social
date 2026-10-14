"""Observability/QA passes that measure an account, never drive it.

Behavior snapshots, the population metric, the cycle_run card, the daily
summary and intervention records: each reads an account's files or posts and
emits `/lab` data. Nothing here may ever change a round's outcome -- each
entry point is fail-soft by contract, not by luck.

Nothing in this package may import `langgraph` or anything from `graph/` (an
AST architecture test enforces the langgraph half): a measurement pass has to
stay callable from a plain test with no graph, no checkpointer and no network.
"""
