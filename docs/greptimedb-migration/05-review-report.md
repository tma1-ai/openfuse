# GreptimeDB Migration Review Report

> Review date: 2026-06-20  
> Reviewed tree: `eded6353b` on `greptime-ci-release-images`  
> Baseline: pre-PR #1 Langfuse ClickHouse/S3 path at `ac649254c^`  
> Scope: `docs/greptimedb-migration`, GreptimeDB schema/migrations, raw event write path, projection writer, read repositories, dashboard/query builder, deletion/reconciliation/deployment/CI, and remaining ClickHouse references.

## Executive Summary

The migration has largely reached the core goals described in docs 00-04. The product backend no longer uses the ClickHouse client/query/writer path. GreptimeDB now owns `raw_events` as the source of truth, merged projections, EAV filter/index tables, dashboard/query reads, dataset and experiment reads, deletion/reconciliation, and deployment bootstrap.

Several blockers from the previous version of this report are now closed:

- Score mutations write synthetic `score-snapshot` events into `raw_events`; they are no longer projection-only.
- The writer now has deterministic/transient error classification, logical-group bisection, and reactive oversized-row truncation.
- Public traces API observation aggregate filters are implemented.
- Dynamic usage/cost custom keys are handled by the `observations_usage_cost` EAV table.
- Product-path `clickhouseClient`, `queryClickhouse`, `commandClickhouse`, and `ClickhouseWriter` call sites are grep-zero, with a CI guard preventing reintroduction.
- PR #41 has landed on `main`, adding the bulk Arrow Flight backfill writer. This report still notes that the reviewed release-image branch is behind `main`; use the branch that includes PR #41 as the release baseline.

This is not completely finished. The remaining issues are narrower:

1. Some feature parity is still reduced, especially dashboard/widget tool introspection filters.
2. `dataset_run_items` is raw-events-backed on write, but its deletion semantics are projection hard-delete plus replay skip, not the same tombstone replay model used by traces/observations/scores.
3. Large queries and large backfills still depend on compaction/SST state. There is a runbook and metrics, but not a fully automated operational loop.
4. The new bulk backfill writer needs a production-like drill with post-backfill compaction and alert validation.

Bottom line: the architecture is sound and the implementation is mostly there. The next phase should be semantic cleanup, production-readiness proof, and removal of historical ambiguity from the code.

## Migration Goal Assessment

| Goal from docs | Current status | Assessment |
|---|---:|---|
| GreptimeDB replaces S3 event store as source of truth | Mostly done | Standard ingestion, OTel ingestion, and UI trace/score mutations write `raw_events`; object storage is optional for event/blob carrier cases. |
| Full-history replay rebuilds projections deterministically | Done | Worker reads full `raw_events` history, dedups by `event_id`, sorts by logical time plus stable ingestion tie-breaks, then writes projection rows. |
| ClickHouse removed from product backend | Done | Actual CH client/query/writer tokens are zero; CI guard prevents reintroduction. Some compatibility names/comments remain. |
| Projection read path covers traces/observations/scores | Done | Core repos read GreptimeDB projections with explicit `project_id`, `is_deleted=false`, JSON row conversion, and no `FINAL`. |
| Dataset/experiment path migrated | Mostly done | DRI projection and readers exist; experiment/dashboard joins use DRI. Deletion/replay semantics remain a design exception. |
| Dashboard/query builder migrated | Mostly done | v1/v2 collapse onto GreptimeDB views; histogram/by-type/time-fill have Greptime-specific execution. Tool introspection filters remain unsupported. |
| Dynamic usage/cost custom keys | Done for new and backfilled rows | `observations_usage_cost` handles custom keys; fleet reconciliation can populate history. |
| Bulk historical backfill | Landed on `main` | PR #41 adds the bulk Arrow Flight writer; still needs release-baseline inclusion and a production-like drill. |
| Production deploy path | Partially done | Schema bootstrap, Docker Compose, CI servertests, GreptimeDB stats, and runbook exist. Compaction/backfill still need stronger operational automation. |

## What Looks Correct

### Source of Truth and Replay

The core architecture matches the approved Option 2 in `00-feasibility.md` and `02-write-path.md`:

- `raw_events` is append-only and stores the original event envelope.
- `traces`, `observations`, `scores`, and `dataset_run_items` are merged projections.
- metadata/tags and custom usage/cost keys are materialized as query-specific side tables.
- replay reads history from `raw_events`, not from the current projection.

The important correction from the early design is also implemented: `raw_events` is written only after sampling accepts an entity. Replay therefore sees exactly the events this fork intends to keep, rather than later resurrecting sampled-out data.

### GreptimeDB Write Semantics

GreptimeDB `merge_mode='last_non_null'` uses write sequence, not a ClickHouse-style explicit version column. The implementation avoids depending on engine arrival order by merging the full entity history in the worker and writing one current snapshot.

That is the right design. It follows the lesson from `poc-results.md`: do not emulate `ReplacingMergeTree(event_ts)` by hoping write order matches logical time.

### Mutation Durability

The old report's biggest correctness issue is fixed. Trace UI mutations write a synthetic `trace-create`; score UI mutations write a synthetic `score-snapshot`. Both append `raw_events` first and then direct-write projection/EAV for read-after-write visibility.

The `score-snapshot` shape is the right compromise. It avoids forcing manual/annotation scores through public ingestion validation that was not designed for already-inflated UI score records.

### Writer Isolation

The writer now has the missing failure isolation:

- transient failures retry as a whole batch;
- deterministic failures trigger logical-group bisection;
- a group keeps projection + EAV rows together;
- oversized leaf rows get reactive truncation for whitelisted large fields;
- drops/truncations are metered by table and error class.

This is a material improvement over the first GreptimeWriter version and is closer to the original ClickHouse writer's operational protections.

### Bulk Backfill

PR #41 has added the bulk Arrow Flight backfill writer on `main`. That closes the architectural gap where fleet-wide reconciliation had to replay history through the unary writer. The remaining work is operational: run it on realistic data, confirm it reduces write overhead, then compact and verify the hot tables.

### Read Path Tenant Isolation

The GreptimeDB filter layer is careful about project scoping. EAV filters use correlated `EXISTS` with both `project_id` and `entity_id`, and projection reads consistently add `project_id` plus `is_deleted=false`.

This satisfies the repo review rule that project-scoped analytics queries must carry tenant filters.

### Query Surface Coverage

The migration has gone well beyond the old P0-P4 state:

- events-v4 style readers are collapsed onto projection reads;
- daily metrics, environments, score analytics, export streams, and batch export paths are GreptimeDB-backed;
- public API generators use Greptime filter translation;
- dashboard v1/v2 both use the GreptimeDB query model;
- DRI/experiment joins are implemented.

The query-builder work is directionally good: it translates only the supported model, throws explicit `InvalidRequestError` on unsupported shapes, and keeps row output compatible with the ClickHouse-era caller contract.

### Index Follow-Through

Per `schema-pk-prioritize-filters`, `schema-pk-filter-on-orderby`, and `query-index-skipping-indices`, the original ClickHouse sort/index intent mattered:

- observations filtered by `trace_id`;
- scores filtered by `trace_id`, `observation_id`, `session_id`, `dataset_run_id`;
- traces filtered by `session_id`, `user_id`, `environment`;
- low-cardinality dimensions filtered by `type`, `level`, `source`, `data_type`, `environment`.

The GreptimeDB schema now has bloom skipping indexes and inverted indexes for these hot patterns. It intentionally does not copy ClickHouse's full `ORDER BY` layout; instead it uses lean projection keys plus secondary indexes and compaction. That is a reasonable GreptimeDB-specific adaptation.

## Findings

### 1. Dashboard Tool Filters Are Still a Product Parity Gap

Severity: Medium

The old ClickHouse dashboard column mapping includes:

- `toolNames` from `mapKeys(tool_definitions)`
- `calledToolNames` from `tool_call_names`

The GreptimeDB dashboard repository intentionally omits these from `dashboardGreptimeColumnDefinitions` because JSON key membership is not expressible in the current SQL shape. The UI still has widget filter config and import/export allowances for those fields.

The current behavior is fail-loud rather than wrong, which is good. But it is still a user-visible narrowing: existing widgets using tool-available/tool-called filters will break or be rejected after migration.

Recommendation:

Add a dedicated EAV table for tool names if this surface matters:

- `observations_tool_definitions(project_id, entity_id, tool_name, timestamp, is_deleted)`
- `observations_tool_calls(project_id, entity_id, tool_name, timestamp, is_deleted)`

Populate it in `buildGreptimeRowsForRecord`, rebuild via reconciliation, and route `toolNames` / `calledToolNames` filters through the same EAV `EXISTS` pattern as metadata/tags.

### 2. `dataset_run_items` Is a Source-of-Truth Exception

Severity: Medium

`dataset_run_items` events are written to `raw_events` and projected into GreptimeDB, but deletes are hard deletes on the projection table. `IngestionService.mergeAndWrite` explicitly skips writing DRI when `deleted=true`.

This works operationally, but it is not the same invariant as traces/observations/scores:

- trace/observation/score delete appends entity tombstone to `raw_events`;
- replay rebuilds a soft-deleted projection row;
- DRI delete does not preserve a per-entity tombstone in `raw_events`;
- replay avoids resurrection only because deleted replay paths are skipped.

That is a local exception to the "raw_events is the complete source of truth" statement. It may be acceptable because DRI is closer to a derived experiment projection than a user-facing mutable entity, but the exception should be explicit in the design docs and tests.

Recommendation:

Choose one invariant:

1. Keep DRI as a projection-hard-delete exception, document it in `02-write-path.md` / `04-read-path.md`, and add tests for replay after dataset/delete-run delete.
2. Or add DRI tombstones to `raw_events` and make DRI replay rebuild an `is_deleted=true` row like the other projections.

### 3. Backfill Performance Still Depends on Compaction

Severity: Medium

The migration now has a good compaction runbook, `GreptimeStatsRunner` metrics, and PR #41's bulk writer. That is the right direction. But backfill performance and post-backfill read latency still depend on the SST state of the hot tables.

Per `insert-batch-size` and `insert-async-small-batches`, high-frequency small writes create many physical parts/files. GreptimeDB's equivalent operational failure mode is SST fragmentation. The docs measured this clearly: `observations_usage_cost` went from seconds to sub-second after compaction, and the 384-file ceiling can break even simple reads.

The bulk writer reduces the write overhead problem, but it does not remove the need to validate compaction behavior on real backfills.

Recommendation:

- Keep the runbook.
- Add alerting on `langfuse.greptime.sst_files_max`.
- Run a PR #41 backfill drill on realistic data, then compact and measure the hot queries.
- Add a backfill completion hook or admin command that can compact the known hot tables.
- For steady-state, decide whether table-level TWCS tuning belongs in the schema bootstrap or in GreptimeDB deployment config.

### 4. Search Semantics and Performance Are Not Fully Equivalent

Severity: Medium

Full-text indexes exist for `input`, `output`, and metadata values, and the explicit FTS operator uses `matches_term`. But ordinary `contains`, `starts with`, and `ends with` still compile to case-insensitive `LIKE`.

That is semantically closer to ClickHouse substring behavior, but it is scan-prone on large payload columns. `0004_fts_indexes.sql` documents the trade-off correctly: whole-term search can be indexed, true substring cannot.

Recommendation:

- Keep `LIKE` for exact ClickHouse-style substring semantics.
- Make the UI/API distinction clear: term search is fast; substring search may be expensive.
- Add query metrics or a guardrail for large time windows with substring content search.

### 5. Historical Naming Still Carries ClickHouse Concepts

Severity: Low

Actual ClickHouse product call sites are gone, but many public/internal compatibility names remain:

- `clickhouseTableName`
- `clickhouseSelect`
- `convertApiProvidedFilterToClickhouseFilter`
- comments in UI table definitions and tests

This is not a runtime blocker. It is an architecture/readability debt. Future contributors will have trouble knowing whether "clickhouse" means legacy semantics, compatibility DTO names, or a real backend dependency.

Recommendation:

Do a small, mechanical naming cleanup after the migration stabilizes:

- keep external API compatibility where needed;
- rename internal mapping fields to `analyticsTableName` / `analyticsSelect` or `dataModelTableName` / `dataModelSelect`;
- keep the CI guard focused on real backend call sites, not compatibility text.

### 6. GreptimeDB Migration Bootstrap Has No Migration Ledger

Severity: Low to Medium

`applyGreptimeMigrations` reads all `packages/shared/greptime/migrations/*.sql`, sorts them, and executes every statement on every run. The DDL is intended to be idempotent.

This works for the current migration style, but it lacks a schema-migration ledger. Once migrations include non-idempotent data rewrites, long-running changes, or engine settings that should be applied exactly once, the current bootstrap model will become fragile.

Recommendation:

Either keep GreptimeDB migrations restricted to idempotent DDL and document that rule, or add a small `_greptime_migrations` ledger table before the migration set grows further.

## ClickHouse Rules Checked

- Per `schema-pk-plan-before-creation`: GreptimeDB projection keys are intentional, but performance depends on secondary indexes and compaction rather than copying ClickHouse `ORDER BY`.
- Per `schema-pk-cardinality-order`: original CH keys used project/date/type/name locality; GreptimeDB chooses lean entity keys and compensates with indexes.
- Per `schema-pk-prioritize-filters`: hot filters are now mostly covered by skipping/inverted indexes.
- Per `schema-pk-filter-on-orderby`: reads consistently bind `project_id`; time-window queries bind the time index where possible.
- Per `query-index-skipping-indices`: bloom skipping indexes were added for high-cardinality equality/IN columns.
- Per `query-join-filter-before`: many GreptimeDB readers push `project_id`, `is_deleted`, and time bounds into base CTEs before joins. Some complex dashboard/experiment joins still need real `EXPLAIN ANALYZE` proof.
- Per `query-join-use-any`: GreptimeDB SQL does not expose ClickHouse `ANY JOIN`; the migration uses `DISTINCT` subqueries or grouped CTEs where fan-out would be wrong.
- Per `insert-batch-size` / `insert-async-small-batches`: the writer batches and PR #41 adds bulk backfill, but backfill still needs compaction validation.
- Per `insert-mutation-avoid-update`: the design avoids frequent updates by append/replay/projection writes; explicit `DELETE` remains for projection cleanup.
- Per `insert-optimize-avoid-final`: GreptimeDB has a different compaction model; manual `compact_table` is documented for large backfills, not per-write operation.

## Original ClickHouse vs Current GreptimeDB Semantics

| Original ClickHouse behavior | Current GreptimeDB behavior | Assessment |
|---|---|---|
| S3 upload before queue; CH projection write in worker | `raw_events` write after sampling, then queue; projection rebuild from `raw_events` | Intentional semantic change, documented and coherent |
| `ReplacingMergeTree(event_ts, is_deleted)` | app-side full-history merge + `merge_mode='last_non_null'` | Correct adaptation |
| `FINAL` / `LIMIT 1 BY` current state reads | merged projection + `is_deleted=false` | Correct |
| Map metadata filters | EAV metadata semi-join | Correct, safer tenant isolation |
| Tags array filters | EAV tags semi-join | Correct |
| `sumMap` / dynamic usage cost maps | known keys from JSON + custom keys from `observations_usage_cost` | Now equivalent after backfill |
| Observation aggregate filters in public traces API | GreptimeDB rollup / observation CTE | Gap closed |
| Tool name filters via `mapKeys(tool_definitions)` / `tool_call_names` | unsupported in dashboard mapping | Remaining parity gap |
| ClickHouse writer batch split/truncate behavior | GreptimeWriter bisection + truncation | Gap closed |
| CH `SAMPLE` score estimate | GreptimeDB score analytics repo | Gap closed at product path level |
| CH migrations and client in app stack | removed from product path | Gap closed |
| Large historical reconciliation through unary writer | PR #41 bulk Arrow Flight writer on `main` | Gap closed architecturally; needs production-like drill |

## Architecture Review

### The Good Shape

The storage model is now GreptimeDB-native enough:

- It does not try to preserve ClickHouse tables one-for-one.
- It treats `raw_events` as the replay log.
- It treats projection tables as current-state read models.
- It uses EAV only where query patterns need indexed membership/key filters.
- It keeps JSON columns for restore/display rather than forcing every dynamic shape into typed columns.

This is the right boundary. It keeps ingestion correctness in application code where Langfuse already has domain merge logic, and uses GreptimeDB for durable storage, filtering, aggregation, and time-series scans.

### The Main Architectural Tension

The biggest tension is still event-sourced correctness vs projection pragmatism.

Traces/observations/scores are cleanly event-sourced. DRI is not fully clean. Reconciliation can heal projection drift from `raw_events`, but delete handling has a special skip rule. That may be fine, but it should not be hidden behind the global "raw_events is SoT" statement.

### The Second Architectural Tension

The read path has many one-off SQL translations. That was probably unavoidable for a hard fork, but it increases maintenance cost. The risk is not that one query is wrong today; the risk is that future upstream features add a filter/dimension to table definitions and only the ClickHouse-era mapping names get updated.

The GreptimeDB dashboard model and filter factory are the right abstraction. The next step is to make unsupported fields impossible to select in the UI, or provide a single compatibility matrix used by both frontend option rendering and backend validation.

## Verification Gaps

Existing unit/smoke/CI coverage is useful, especially:

- GreptimeDB converter tests;
- GreptimeDB SQL/filter tests;
- dashboard query builder tests;
- GreptimeDB-backed servertest subset;
- worker deletion/eval servertests;
- writer isolation unit tests;
- PR #41 bulk writer unit coverage.

Still missing before calling the migration production-complete:

1. Golden parity tests for representative existing widgets, including imported widgets using tool filters.
2. Reconciliation tests for DRI delete/replay semantics.
3. `EXPLAIN ANALYZE` snapshots for top read paths on realistic data:
   - trace detail with many observations;
   - traces UI table with score/observation filters;
   - dashboard cost/usage by type;
   - experiment list/detail;
   - export streams.
4. Backfill drill using the PR #41 bulk writer plus post-backfill compaction.
5. Alert validation for `sst_files_max` and writer drop/truncation metrics.
6. Deployment smoke from fresh Compose stack through schema bootstrap, ingestion, read, delete, and dashboard query.

## Recommended Priority Plan

1. Use a release baseline that includes PR #41, then run a realistic bulk backfill drill.
2. Decide and document the DRI delete/source-of-truth invariant.
3. Either implement tool-name EAV tables or remove/disable those filters from GreptimeDB dashboard/widget UI surfaces.
4. Automate or operationalize post-backfill compaction with an explicit command and alert threshold.
5. Add realistic `EXPLAIN ANALYZE` performance artifacts to the migration docs.
6. Clean up internal ClickHouse naming after behavior is stable.
7. Decide whether GreptimeDB migrations stay idempotent-only or need a ledger.

## Bottom Line

The migration is no longer "credible but incomplete"; it is mostly implemented. The remaining work is not about replacing another obvious ClickHouse call site. It is about closing the last semantic exceptions, proving operational performance, and removing historical ambiguity from the code.

The two things I would not defer are the tool-filter parity decision and a production-like drill of the PR #41 bulk backfill path. Everything else can be staged, but those two directly affect whether this behaves like a production migration baseline rather than a working backend fork.
