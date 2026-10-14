"""Prompt-context assembly for the act path.

Gathers everything an LLM sees before deciding what an account does this
round: local memory-derived state (rhythm counters, engagement history) plus
every API-sourced feed/notification/thread/contacts block, each degrading
on a partial-outage round (contract `01` §4).
"""
