# Architecture

Openfuse keeps the Langfuse application and swaps one component: the analytics event store moves from ClickHouse to GreptimeDB. Nothing else about the topology changes.

```
        SDKs / OTel clients
              │ ingest (HTTP)
              ▼
      ┌───────────────┐         ┌───────────────┐
      │  langfuse-web │         │ langfuse-worker│
      │ (Next.js app, │         │ (queue consumers,
      │  tRPC, REST)  │         │  replay, evals) │
      └───────┬───────┘         └───────┬───────┘
              │                         │
   app/config│                  replay │  raw_events → merged projections
              ▼                         ▼
      ┌───────────────┐         ┌──────────────────────────────┐
      │   Postgres    │         │           GreptimeDB          │
      │ users,projects│         │  raw_events  (append-only SoT)│
      │ prompts, keys,│         │  traces / observations /      │
      │ dataset defs  │         │  scores / dataset_run_items   │
      └───────────────┘         │  EAV: *_metadata, *_tags,     │
      ┌───────────────┐         │  observations_usage_cost,     │
      │     Redis     │         │  observations_tool_*          │
      │ BullMQ queues │         └──────────────────────────────┘
      └───────────────┘
                Object storage (S3 / MinIO) — OPTIONAL
```

## What lives where

### Postgres — application and configuration data

Unchanged from upstream Langfuse: users, organizations, projects, API keys, prompts, dataset _definitions_, configs. Schema and migrations are upstream Langfuse's, applied automatically by the web container entrypoint.

### GreptimeDB — the analytics event store

This is the part the fork rebuilds. GreptimeDB holds:

- **`raw_events`** — append-only, the **source of truth**. Every ingested entity event (and synthetic events from UI mutations / deletions) is appended here. `append_mode=true`, retired only by TTL.
- **Merged projections** — `traces`, `observations`, `scores`, `dataset_run_items`: merge-mode (`last_non_null`) tables holding the current merged state of each entity, rebuilt by replaying `raw_events`.
- **EAV side-tables** — indexed `key/value` decompositions that make filtering/breakdown server-side: `*_metadata`, `traces_tags` / `observations_tags`, `observations_usage_cost` (per-custom-key usage/cost), and `observations_tool_definitions` / `observations_tool_calls` (per tool name). They mirror what ClickHouse expressed with `map`/`array` access on the same row.

Reads go over the MySQL wire (`:4002`); ingest writes go over gRPC (`:4001`).

### Redis — queues

BullMQ job queues (ingestion, evals, exports, reconciliation). Unchanged from upstream.

### Object storage — optional

With the event store in GreptimeDB, S3/MinIO is no longer required to ingest. The remaining consumers — media uploads, the OTel ingestion carrier, the eval blob store, and batch/blob exports — all support a local-filesystem backend and default to it. Only opt-in batch/blob _exports_ require an S3-compatible bucket.

## Write path: source of truth and replay

1. An ingestion event arrives; after sampling accepts it, the original envelope is appended to `raw_events`.
2. The worker reads the entity's **full** `raw_events` history, dedups by event id, sorts by logical time with stable tie-breaks, and merges to one current snapshot.
3. It writes the projection row plus the entity's EAV rows (`buildGreptimeRowsForRecord` is the single fan-out used by both the worker writer and the seeder).

Merging is done in the worker, not by hoping engine write-order matches logical time — GreptimeDB `last_non_null` uses write sequence, so the worker always writes one already-merged snapshot. UI trace/score mutations write synthetic `*-create` / `score-snapshot` events to `raw_events` (durable + replayable) and direct-write the projection for read-after-write visibility.

## Read path

The ClickHouse dashboard had two query families (normalized tables read with `FINAL`, and an events-aggregation path). On GreptimeDB both collapse onto the same merged projection. Repositories read projections with explicit `project_id`, `is_deleted = false`, and JSON-aware row conversion — no `FINAL`. Metadata/tag/tool filters route through the EAV tables as project-scoped, soft-delete-aware `EXISTS` semi-joins; breakdowns join the EAV table and `GROUP BY`. Dashboard/metrics outputs are verified byte-for-byte against upstream (see the [parity report](greptimedb-migration/parity/PARITY-REPORT.md)).

## Deletion and replay

Entity and project deletes append a tombstone to `raw_events` and delete the current projection + EAV rows. A later full-history replay rebuilds the entity as **soft-deleted** rather than resurrecting it. (`dataset_run_items` is a documented exception — see [known limitations](known-limitations.md).)

## Why ClickHouse is not part of this fork

LLM traces are observability data — timestamped wide events with high-cardinality context — which is what GreptimeDB is built for. Using it as the Langfuse analytics store removes ClickHouse as a separate dependency, manages retention/schema/indexing in plain SQL (TTL, inverted/skipping/full-text indexes), and makes object storage optional for ingestion. The product-path ClickHouse client, query, and writer call sites are removed, with a CI guard preventing reintroduction.

For the migration's full design record — feasibility, schema design, write path, read path, reviews, and the parity harness — see [`docs/greptimedb-migration/`](greptimedb-migration/).
