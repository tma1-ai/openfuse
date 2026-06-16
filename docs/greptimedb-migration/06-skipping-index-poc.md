# 06 — Projection skipping-index PoC

## Goal

The main projection tables (`traces`, `observations`, `scores`) carry only a
`PRIMARY KEY (project_id, id)` and a `TIME INDEX`. The hottest read paths filter
or join on un-indexed equality columns — above all `observations.trace_id`
(`getObservationsForTrace`, `getCostForTraces`, the two-phase traces-UI metrics,
every rollup), plus `traces.session_id` / `user_id` and
`scores.trace_id` / `observation_id`. Only `dataset_run_items` (migration `0003`)
ships skipping indexes today.

This PoC measured whether a GreptimeDB bloom **skipping index** on
`observations.trace_id` produces granule/file pruning, to decide whether to add a
`0006` migration.

## Method

Local `openfuse`, demo project `7a88fb47-b4e2-43b8-a06c-a5ce950dc53a`
(`observations` ≈ 1092 live rows). `ADMIN flush_table` before each measurement.

```sql
-- baseline (no index)
EXPLAIN ANALYZE
SELECT id, total_cost FROM observations
WHERE project_id = :p AND trace_id = :t AND is_deleted = false;

-- add the index, rebuild SSTs, re-measure
ALTER TABLE observations MODIFY COLUMN trace_id
  SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ADMIN flush_table('observations');
ADMIN compact_table('observations');
```

## Results

| query                         | index | files / file_ranges | output_rows | pruning |
| ----------------------------- | ----- | ------------------- | ----------- | ------- |
| trace_id = (150-obs trace)    | none  | 18 / 18             | 150         | none    |
| trace_id = (150-obs trace)    | bloom | 15 / 15             | 150         | none    |
| trace_id = (1-obs trace)      | bloom | 15 / 15             | 1           | none    |

`SHOW CREATE TABLE` confirmed the index was built
(`` `trace_id` STRING NULL SKIPPING INDEX WITH(false_positive_rate = '0.01' ...) ``).
The `ALTER ... SET/UNSET SKIPPING INDEX` syntax works on this GreptimeDB build.

`file_ranges` stayed equal to the total file count in every case — **no granule
pruning was observed**, even for a single-row result. The `FilterExec` always
reports `selectivity: 0` (the predicate is applied after a full `SeqScan`).

## Conclusion — not shipping the migration (for now)

The PoC is **inconclusive at seed scale**, not positive. ~1092 rows land in ~15
tiny SST files written in one seed run, so a given `trace_id`'s rows are spread
across most files and the bloom filter cannot exclude any. This is a property of
the seed data, not evidence that the index is useless: at production scale a
trace's spans are ingested in a short window and cluster into a few adjacent
files, so a `trace_id =`/`IN` query could prune the rest.

Per the PR plan's decision gate ("ship only if pruning is demonstrably positive;
otherwise document and keep a draft — do not add an index on unproven benefit"),
we **do not activate** a `0006` migration here. The local `openfuse` index was
`UNSET` so the schema matches migrations `0001`–`0005`.

## Draft migration (activate after validating at scale)

When a production-scale dataset is available, re-run the `EXPLAIN ANALYZE`
before/after on a clustered trace; if `file_ranges` drops, add the following as
`packages/shared/greptime/migrations/0006_skipping_indexes.sql`:

```sql
-- Bloom skipping indexes for the hottest equality-filter / join columns. Mirrors the
-- dataset_run_items approach (0003). Validate granule pruning with EXPLAIN ANALYZE first.
ALTER TABLE observations MODIFY COLUMN trace_id      SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE scores       MODIFY COLUMN trace_id      SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE scores       MODIFY COLUMN observation_id SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE traces       MODIFY COLUMN session_id    SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE traces       MODIFY COLUMN user_id       SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
```

Notes:
- Bloom skipping indexes prune on **equality / IN** only (the hot patterns are
  `trace_id IN (...)`, `session_id IN (...)`); they do not help range scans, which
  the `TIME INDEX` already bounds.
- `granularity` / `false_positive_rate` are starting points; tune against real
  cardinality and file sizes.
- Roll back a column with `ALTER TABLE <t> MODIFY COLUMN <c> UNSET SKIPPING INDEX`.
