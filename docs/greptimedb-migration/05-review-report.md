# GreptimeDB Migration Review Report

> Review date: 2026-06-15  
> Scope: current GreptimeDB migration design and implementation under `docs/greptimedb-migration`, `packages/shared/greptime`, `packages/shared/src/server/greptime`, GreptimeDB read repositories, worker ingestion/write paths, and remaining ClickHouse call sites.

## Executive Summary

The overall architecture is sound: `raw_events` as replayable source of truth, merged projection tables with `merge_mode='last_non_null'`, and EAV side tables for metadata/tag filtering are the right primitives for moving Langfuse from ClickHouse to GreptimeDB.

This is not yet a full ClickHouse-equivalent replacement. The current implementation has several important gaps:

- The score mutation path violates the documented "raw_events + projection" source-of-truth model.
- The main projection schemas are optimized for entity lookup and merge correctness, but not yet enough for high-volume UI/API query paths.
- The GreptimeDB writer lacks the oversized-row isolation and recovery behavior needed for LLM observability payloads.
- Some ClickHouse semantics are explicitly narrowed, especially dynamic usage/cost key breakdowns and observation-aggregate filters in the public traces API.
- Several real ClickHouse call sites remain and block complete cutover.

## What Looks Correct

### Storage Model

The table family split is correct:

- `raw_events`: append-only source of truth.
- `traces`, `observations`, `scores`, `dataset_run_items`: merged projection tables.
- `*_metadata` and `*_tags`: EAV filter tables for values that ClickHouse previously stored as `Map` / `Array`.

The base schema follows the final write-path decision in `02-write-path.md`: full-history rebuild from `raw_events`, app-side merge using existing Langfuse merge logic, and direct gRPC writes to projection/EAV tables.

Key examples:

- `raw_events` is append-only with `PRIMARY KEY (project_id, entity_type, entity_id)`: `packages/shared/greptime/migrations/0001_init.sql`.
- Projection tables use `merge_mode='last_non_null'` and `sst_format='flat'`.
- Projection time indexes are stable entity logical times: trace `timestamp`, observation `start_time`, score `timestamp`.

This avoids the known GreptimeDB write-sequence pitfall because the worker rebuilds a full snapshot from deterministically sorted history instead of relying on arrival order.

### Tenant Isolation

The GreptimeDB filter layer is careful about tenant isolation. EAV filters use project-scoped correlated `EXISTS` predicates and include `is_deleted = false`, avoiding cross-project ID collisions.

This is important because EAV tables key rows by `entity_id`, not globally unique `(project_id, entity_id)` in a relational sense.

### JSON Row Contract

The read path avoids `SELECT *` and projects JSON columns through `json_to_string`, which is the right MySQL-wire contract for GreptimeDB. This prevents JSON bytes from leaking into domain converters.

### Cost Precision

Cost columns remain `DECIMAL(38, 12)`. This preserves ClickHouse `Decimal64(12)` semantics and avoids silent float drift in cost aggregation.

## Findings

### 1. Score Mutations Break the Source-of-Truth Model

Severity: High

The documented GAP-MUT decision in `04-read-path.md` says post-ingestion mutations should write both:

- direct projection/EAV rows for immediate read-after-write visibility
- a synthetic `raw_events` record for replay durability

The trace mutation path follows this model. `upsertTraceToGreptime` appends a synthetic `trace-create` event to `raw_events`, then writes the projection.

The score mutation path does not. `upsertScoreToGreptime` is projection-only. The code explicitly says annotation/manual scores have no replayable ingestion origin and therefore "their durable home is the projection, never an ingestion rebuild."

This is a real architecture split, not a small implementation bug. If projection is durable state for scores, then `raw_events` is not the complete source of truth. If `raw_events` must remain the complete source of truth, score mutations need an internal replayable event shape that does not go through the public ingestion validator.

Recommendation:

Choose one model and document it as a hard invariant:

1. Make score projection the explicit source-of-truth exception, including retention, deletion, backup, and rebuild behavior.
2. Or introduce an internal `score-mutation` event schema in `raw_events`, replayed by a dedicated internal path instead of `validateAndInflateScore`.

Do not leave the implementation and design document disagreeing.

### 2. Projection Schemas Are Under-Indexed for High-Frequency Query Paths

Severity: High

The main projection primary keys are all lean:

- `traces`: `(project_id, id)`
- `observations`: `(project_id, id)`
- `scores`: `(project_id, id)`
- `dataset_run_items`: `(project_id, id)`

This is good for entity lookup, deduplication, and merge correctness. It is not enough for the read workload.

High-frequency queries filter on columns outside those primary keys:

- observations by `trace_id`
- scores by `session_id`, `dataset_run_id`, `trace_id`, `observation_id`
- trace list by `timestamp`, `user_id`, `session_id`, `environment`, `name`, tags, and rollup conditions
- dataset run items by `dataset_id`, `dataset_run_id`, `dataset_item_id`, `trace_id`

GreptimeDB's own table-design guidance says primary key/tag layout controls physical ordering by `(primary key, time index)`, while value indexes must be added based on query patterns. `flat` SST format makes high-cardinality tags viable, but it does not remove the need to index/filter intentionally.

Current schema only adds EAV indexes and a few `dataset_run_items` skipping indexes. The major projection foreign-key and enum columns are mostly plain fields.

Recommendation:

Run a measured index PoC before production cutover:

- High-cardinality equality filters: add `SKIPPING INDEX` candidates for `trace_id`, `observation_id`, `session_id`, `dataset_run_id`, `dataset_item_id`.
- Low-cardinality filters: add `INVERTED INDEX` candidates for `type`, `source`, `data_type`, `level`, `environment`.
- Validate with `EXPLAIN ANALYZE`, not only smoke tests.

The first benchmark set should include:

- trace detail with observations and scores
- trace UI list with timestamp and environment filters
- observations by trace
- scores by session/run/trace
- dataset run item table count and rows

### 3. GreptimeWriter Lacks Oversized-Row Isolation

Severity: High

`GreptimeWriter` writes one batch per physical table in a combined gRPC call. On failure it retries the whole flush and then drops rows after max attempts.

This is weaker than the existing ClickHouse writer, which has substantial handling for large strings and oversized batches. LLM observability data frequently contains large `input`, `output`, `metadata`, `tool_calls`, and multimodal-adjacent payloads. One bad row can keep failing the whole flush and eventually drop unrelated projection/EAV rows.

A replay does not automatically fix this if the same raw event keeps producing the same oversized projection row.

Recommendation:

Add failure isolation before relying on this writer in production:

- batch bisection on write failure
- single-row failure classification
- explicit truncation strategy for fields that already have ClickHouse-side limits
- metrics by table and error class, not only aggregate `rows_dropped`

The projection/EAV fate-sharing goal is valid, but it should not force unrelated rows in the same flush to fail together indefinitely.

### 4. Public Traces API Has a Functional Narrowing

Severity: Medium

The GreptimeDB public traces generator throws for filters whose ClickHouse table is `observations`.

This is explicit and preferable to silent mis-filtering, but it is still a ClickHouse parity gap. Users who rely on observation aggregate filters in the public traces API will see behavior change.

Recommendation:

- Return a clear public API 4xx error for unsupported filters instead of an internal error.
- Add this to the cutover checklist as a known incompatibility unless it is implemented before release.
- If parity is required, implement observation aggregate filtering through an observation rollup CTE or a precomputed rollup table.

### 5. Dynamic Usage/Cost Key Breakdown Is Narrowed

Severity: Medium

ClickHouse can use `sumMap`, `mapKeys`, and `mapValues` to aggregate arbitrary dynamic keys in `usage_details` and `cost_details`.

The GreptimeDB dashboard path narrows by-type cost/usage breakdowns to known keys: `input`, `output`, and `total`. This is documented in the code and design notes. It is exact for standard Langfuse usage, but not equivalent for custom usage/cost keys.

Recommendation:

Decide whether custom keys are a supported product surface:

- If yes, add a long-tail EAV/aggregation table for usage/cost details.
- If no, document this as an intentional product narrowing in API/UI behavior.

### 6. Remaining ClickHouse Call Sites Block Full Cutover

Severity: Medium

Several real ClickHouse paths remain outside test code:

- experiment backfill reads from `dataset_run_items_rmt`, `observations`, and `traces`
- score analytics estimate still uses ClickHouse `SAMPLE`
- event propagation still references ClickHouse partition mechanics
- query tracking still uses ClickHouse `system.*`
- internal tracing still constructs a ClickHouse writer

Some of these are migration-era infra and may be intentionally kept for now. They still block deleting the ClickHouse client and claiming the backend is GreptimeDB-only.

Recommendation:

Maintain an explicit call-site inventory and gate final cutover on it reaching zero for product paths. CI should prevent new `queryClickhouse`, `commandClickhouse`, or `ClickhouseWriter` call sites except in a small allowlist during the migration.

### 7. Dataset Run Items Preserve Semantics but Need Performance Proof

Severity: Medium

The `dataset_run_items` projection intentionally uses `(project_id, id)` as the merge key, while the logical business key is `(project_id, dataset_id, dataset_run_id, dataset_item_id)`.

The read path compensates with `ROW_NUMBER() OVER (PARTITION BY project_id, dataset_id, dataset_run_id, dataset_item_id ORDER BY created_at DESC, updated_at DESC, id DESC)`.

This preserves ClickHouse `LIMIT 1 BY` semantics, but it is potentially expensive. The schema adds skipping indexes on `dataset_id`, `dataset_run_id`, `dataset_item_id`, and `trace_id`, which is directionally right. It still needs scale validation because window dedup over large run-item sets can be costly.

Recommendation:

Benchmark the DRI table on realistic experiment sizes. If the window path is too slow, consider changing the projection key to the logical key or adding a secondary current-state table keyed by the logical tuple.

## ClickHouse-vs-GreptimeDB Semantic Assessment

### Correct Mappings

| ClickHouse behavior | GreptimeDB implementation | Assessment |
|---|---|---|
| `ReplacingMergeTree` merged current state | `merge_mode='last_non_null'` projection plus full-history app merge | Correct, given stable time index |
| `FINAL` reads | Plain projection reads with `is_deleted=false` | Correct |
| `Map` metadata filters | EAV metadata tables with project-scoped `EXISTS` | Correct and safer for tenant isolation |
| trace tags array filters | `traces_tags` EAV table | Correct for union-only tag semantics |
| Decimal cost columns | `DECIMAL(38,12)` | Correct |
| JSON display/restoration | JSON columns plus row-contract converters | Correct |

### Narrowed or Different Mappings

| ClickHouse behavior | GreptimeDB behavior | Risk |
|---|---|---|
| `sumMap` over arbitrary usage/cost keys | known-key SQL aggregation or app-side expansion in some paths | Custom-key breakdown may differ |
| Public traces API observation aggregate filters | unsupported and throws | API compatibility gap |
| ClickHouse `SAMPLE` for score analytics estimate | not migrated | Cutover blocker |
| Score mutation event-store append | projection-only in GreptimeDB | Source-of-truth split |
| ClickHouse writer oversized-row handling | absent in GreptimeWriter | Data-loss risk on large payloads |

## GreptimeDB-Specific Design Review

### Good Use of GreptimeDB

- `sst_format='flat'` is appropriate for high-cardinality entity IDs.
- `merge_mode='last_non_null'` is a good fit for merged entity snapshots.
- Append-only `raw_events` is a good fit for event-store semantics.
- EAV tables avoid relying on JSON filtering performance for core filters.
- Full-text indexes on `input`, `output`, and metadata `value` are a good first step for term search.

### Underused GreptimeDB Capabilities

- Projection foreign-key filters need more indexing.
- Low-cardinality dimensions should use inverted indexes where query-heavy.
- `EXPLAIN ANALYZE` should become part of the migration verification process.
- Flow is reasonably deferred, but trace-level rollups should have a benchmark threshold that triggers revisiting Flow or a precomputed rollup table.

### Things Not to Overuse

- Do not push everything into Pipeline yet. The current app-side fan-out is more debuggable and fits the migration stage.
- Do not rely on JSON columns for high-cardinality filtering until the JSON query path is proven at scale.
- Do not use TTL on `raw_events` as a cost-control knob unless a snapshot/checkpoint mechanism exists. Full-history rebuild depends on complete raw history.

## Recommended Priority Plan

1. Resolve score mutation source-of-truth semantics.
2. Add GreptimeDB writer failure isolation for oversized rows.
3. Run index and query-plan PoCs for the top read paths.
4. Convert remaining product ClickHouse call sites or mark them as explicit unsupported scope.
5. Turn the ClickHouse call-site inventory into CI enforcement.
6. Decide whether dynamic usage/cost custom keys are supported.
7. Benchmark dataset run item window dedup and decide whether to keep or remodel.

## Verification Gaps

Current smoke tests are useful, but they mostly verify correctness on small data. Before production cutover, add measured tests for:

- large traces with many observations
- very large `input` / `output` / `metadata`
- high-cardinality projects with many traces and sessions
- dataset runs with many items and repeated logical keys
- dynamic custom usage/cost keys
- replay after delete and after score mutation
- GreptimeDB `EXPLAIN ANALYZE` snapshots for key queries

## Bottom Line

The migration is on a credible path. The main architectural move is right: GreptimeDB should not emulate ClickHouse table-for-table; it should use raw events, merged projections, and query-specific side tables.

The remaining work is mostly about tightening invariants and proving performance. The biggest thing to fix is the source-of-truth split for score mutations. The biggest thing to measure is whether the current lean projection PKs plus limited indexes can sustain Langfuse's real UI/API workload.
