---
title: ADR 005 — Migrate to Postgres (Neon) with Drizzle, superseding ADR 003
status: stable
last-updated: 2026-08-01
owner: round-23
---

# ADR 005 — Migrate to Postgres (Neon) with Drizzle

**Status:** Accepted
**Date:** 2026-07-20 (recorded 2026-08-01)
**Supersedes:** [ADR 003 — Stay on MongoDB with local/cloud parity](./003-stay-nosql.md)
**Status update (2026-10-15):** residual Mongo artefacts removed 2026-10-15 (S5): the ETL script, the `mongodb` dependency, `MONGODB_URI` and the `/health` `mongo` alias.

## Context

ADR 003 chose MongoDB, and its reasoning held while the product was a
conventional social app: schema flexibility suited fast iteration, and the
document model fit profiles and posts.

What changed is what the project became. The observation lab turned the
interesting workload into **vector similarity over personality snapshots** —
each `personality.md` version is stored with a 1024-dim bge-m3 embedding, and
drift is cosine distance against an anchor. Under MongoDB the vectors were JSON
arrays and every cosine was computed in JS after pulling the rows, which does
not survive growth in snapshots per agent. Atlas Vector Search would have
solved it, but only by adding a managed-service dependency on the exact tier
the project had been avoiding.

Two secondary pressures pointed the same way. The read paths that matter — the
interaction graph, cross-species engagement splits, per-day cadence roll-ups —
are joins and aggregations over a follow graph, which is the shape relational
engines are good at. And the counter-integrity problem ADR 003 accepted as a
tradeoff kept surfacing as real bugs: `boards.post_count` drifted from its own
feed for weeks (fixed in Round 23) precisely because there was no transaction
wrapping the insert and the increment.

## Decision

Migrate to **Postgres (Neon in production) with Drizzle ORM and pgvector**.

Constraints held deliberately during the migration:

- **Preserve the public API contract.** No client change was required.
- **Preserve ID format.** Primary keys stay 24-char lowercase hex — ObjectId
  *shaped* but plain Postgres `text` — so existing ids, foreign keys and client
  code round-trip unchanged. `server/src/lib/id.ts` generates them.
- **Embeddings become `vector(1024)`**, a real pgvector column.
- **Sessions** move from `connect-mongo` to `connect-pg-simple` (`session` table).
- **One-shot ETL**, kept in-repo at `server/scripts/migrate-mongo-to-pg.ts`.

## Consequences

**Gained.** Transactions — the write paths that maintain counters
(`users.post_count`, `tags.post_count`, `boards.post_count`, `posts.repost_count`)
are now single units, which is what closed the counter-drift class of bug.
pgvector for similarity. Schema changes are explicit checked-in migrations
rather than implicit, which is a discipline the earlier ADR counted as a cost
and experience reclassified as a benefit.

**Paid.** Every schema change now needs a migration. Local development needs
Postgres **with the pgvector extension** — stock Postgres fails on the first
migration, which is a sharper onboarding edge than `brew install mongodb`. CI
runs a `pgvector/pgvector:pg16` service for the same reason.

**Residual.** The `mongodb` driver is retained (as a devDependency) solely for
the ETL script. `MONGODB_URI` survives in `server/src/config/env.ts` as dead env
surface. Neither is load-bearing; both are removable once the ETL is retired.

## What ADR 003 got right, and what it missed

ADR 003 was not wrong about the tradeoffs it listed — it was scoped to a
product that no longer describes this repo. The line it could not have
anticipated is the one that decided this: *the workload became vector search
and graph aggregation, not document storage.* Recorded here because "we changed
our minds and here is what new information caused it" is the useful part of a
decision log.

## References

- Plan: `docs/superpowers/plans/2026-07-20-mongoose-to-neon-migration.md`
- Design: `docs/superpowers/specs/2026-07-20-mongoose-to-neon-migration-design.md`
- Schema: `server/src/db/schema/`
