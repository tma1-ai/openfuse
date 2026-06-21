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
                Object storage (S3 / MinIO), optional
```

## What lives where

### Postgres

Application and configuration data, unchanged from upstream Langfuse: users, organizations, projects, API keys, prompts, dataset _definitions_, configs. The schema and migrations are upstream Langfuse's, applied automatically by the web container entrypoint.

### GreptimeDB

The analytics event store, and the part the fork rebuilds. It holds three kinds of table:

- `raw_events`: append-only, the source of truth. Every ingested entity event, plus the synthetic events from UI mutations and deletions, is appended here. It is `append_mode=true` and retired only by TTL.
- Merged projections (`traces`, `observations`, `scores`, `dataset_run_items`): `last_non_null` merge-mode tables holding each entity's current merged state, rebuilt by replaying `raw_events`.
- EAV side-tables: indexed `key/value` decompositions that make filtering and breakdown server-side. They are `*_metadata`, `traces_tags` / `observations_tags`, `observations_usage_cost` (per custom usage/cost key), and `observations_tool_definitions` / `observations_tool_calls` (per tool name). They stand in for the `map`/`array` access ClickHouse did on the same row.

Reads go over the MySQL wire (`:4002`); ingest writes go over gRPC (`:4001`).

### Redis

BullMQ job queues for ingestion, evals, exports, and reconciliation. Unchanged from upstream.

### Object storage (optional)

With the event store in GreptimeDB, S3 or MinIO is no longer required to ingest. Media uploads, the OTel ingestion carrier, and the eval blob store support a local-filesystem backend, and the bundled Compose files default them to it. Opt-in batch/blob _exports_ still need an S3-compatible bucket.

## Write path: source of truth and replay

1. An ingestion event arrives; once sampling accepts it, the original envelope is appended to `raw_events`.
2. The worker reads the entity's full `raw_events` history, dedups by event id, sorts by logical time with stable tie-breaks, and merges to one current snapshot.
3. It writes the projection row plus the entity's EAV rows. `buildGreptimeRowsForRecord` is the single fan-out used by both the worker writer and the seeder.

Each rebuild stamps a monotonic **generation** on the projection (`eav_generation`) and on every EAV row (`generation`); reads keep only an entity's current generation. A key dropped from an updated entity has no row at the new generation and is excluded by correlation, so there is **no up-front EAV `DELETE`** on the write hot path (per-rebuild deletes are a write-amplification source on a single GreptimeDB). The protobuf encode and gRPC write run in a `worker_threads` pool so they do not block the event loop that also serves each job's `raw_events` read.

The worker does the merge rather than relying on engine write-order to match logical time: `last_non_null` merges by write sequence, so the worker always writes one already-merged snapshot. UI trace and score mutations append synthetic `*-create` / `score-snapshot` events to `raw_events` (durable and replayable) and also direct-write the projection for read-after-write visibility.

## Read path

The ClickHouse dashboard had two query families: normalized tables read with `FINAL`, and an events-aggregation path. On GreptimeDB both collapse onto the same merged projection. Repositories read projections with an explicit `project_id`, `is_deleted = false`, and JSON-aware row conversion, with no `FINAL`. Metadata, tag, and tool filters route through the EAV tables as project-scoped, soft-delete-aware `EXISTS` semi-joins correlated to the projection's current generation (so superseded EAV keys are invisible without a delete); breakdowns join the EAV table and `GROUP BY`. The output is checked byte-for-byte against upstream (see the [parity report](greptimedb-migration/parity/PARITY-REPORT.md)).

## Deletion and replay

Deleting an entity or project appends a tombstone to `raw_events` and deletes the current projection and EAV rows. A later full-history replay rebuilds the entity as soft-deleted rather than resurrecting it. (`dataset_run_items` is a documented exception; see [known limitations](known-limitations.md).)

## Why ClickHouse is not part of this fork

LLM traces are observability data: timestamped wide events with high-cardinality context, which is what GreptimeDB is built for. Using it as the analytics store drops ClickHouse as a separate dependency, manages retention, schema, and indexing in plain SQL (TTL, inverted/skipping/full-text indexes), and makes object storage optional for ingestion. The product-path ClickHouse client, query, and writer call sites are gone, with a CI guard that fails the build if they come back.

The migration's full design record (feasibility, schema design, write path, read path, reviews, and the parity harness) lives in [`docs/greptimedb-migration/`](greptimedb-migration/).
