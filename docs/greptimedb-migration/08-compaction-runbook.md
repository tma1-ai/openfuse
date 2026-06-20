# 08 - Compaction & SST Fragmentation Runbook

The one performance lever for the GreptimeDB read path is **compaction**, not
indexing or query shape. This runbook explains why, what to do after a large
backfill, and how to monitor steady state.

## 1. Why fragmentation is the only lever

The by-type dashboard queries (`getObservationDetailByTypeByTime`, the
`observations_usage_cost` EAV aggregation) scan a time range and group by key.
Latency is dominated by **how many SST files the scan has to merge**, not by row
count, not by the `JOIN observations`, not by any `key` index.

Measured on a real stack (GreptimeDB 1.1.0, ~3.5M observations / ~14M EAV rows):

| State                          | Same Q2 query |
| ------------------------------ | ------------- |
| 1022 un-compacted SST files    | **9.6 s**     |
| After `compact_table` (1 file) | **0.2 s**     |

`EXPLAIN ANALYZE` attributes the cost to the EAV table's `MergeScan` over the
1022 files (~5.5 s `elapsed_compute`), not the join (~0.36 s) or the
aggregation (negligible). A `key` skipping index does **not** help — the
`key NOT IN (...)` guard is anti-selective and the `GROUP BY key` happens after
the scan, so nothing prunes. Do not add one.

GreptimeDB also enforces a hard per-region file ceiling: once a region exceeds
**384 SST files** even `count(*)` fails with `Too many files (max allowed: 384)`
until background compaction catches up. The
`GreptimeWriter` flushes every ~1 s under load, so high ingest or a bulk
backfill produces many small SSTs fast.

## 2. After a large backfill — mandatory manual compaction

The fleet reconciliation/backfill replays history through the unary write path,
which lands as many small SSTs. Measured: backfilling ~2.5M observations created
**~4032 SST files** on `observations_usage_cost` — enough to trip the 384-file
wall and degrade every by-type dashboard to ~10 s until compaction caught up.

**After the fleet backfill drains, compact the affected tables once:**

```sql
-- Run over the MySQL wire (port 4002) against the GREPTIME_DB database (openfuse).
ADMIN compact_table('observations_usage_cost', 'strict_window', 86400);
ADMIN compact_table('observations',            'strict_window', 86400);
```

`strict_window` with an explicit window (here 86400 s = 1 day) compacts within
day-aligned windows. Prefer a real window over a bare `0`: `window=0` collapses
the whole table into the minimum number of files in one pass (what the benchmark
used to get a single file), which is fine for a short-lived test table but
expensive and disruptive on a production table with a long TTL (default 730d).

Compaction of `observations` can take a while at scale; run it fire-and-forget
and watch the SST metric (section 3) drop back to single digits.

### `compact_table` signature reference

From GreptimeDB source (`common/function/src/admin/flush_compact_table.rs`):

```
ADMIN compact_table(<table> [, <type> [, <options>]])
```

- `<type>`:
  - `regular` (default) — TWCS compaction. `<options>`: `parallelism=N`.
  - `strict_window` / `swcs` — window compaction. `<options>`: a single number =
    window seconds, or a `window=<seconds>,parallelism=<N>` key-value string.
- `window_seconds = 0` — no windowing, fewest output files. Avoid bare `0` on
  long-TTL production tables.

## 3. Steady-state monitoring

The worker samples per-table region statistics every 60 s
(`GreptimeStatsRunner`, gated by `LANGFUSE_GREPTIME_STATS_ENABLED`, period
`LANGFUSE_GREPTIME_STATS_INTERVAL_MS`) and emits gauges:

| Metric                            | Meaning                                            |
| --------------------------------- | -------------------------------------------------- |
| `langfuse.greptime.sst_files_max` | Per-region **maximum** SST count — hits 384 first. |
| `langfuse.greptime.sst_files`     | Sum of SST files across the table's regions.       |
| `langfuse.greptime.region_rows`   | Row count.                                         |
| `langfuse.greptime.disk_size`     | On-disk bytes.                                     |
| `langfuse.greptime.memtable_size` | In-memory (un-flushed) bytes.                      |

All tagged by `table`. Alert on **`sst_files_max` approaching the 384 limit**
(e.g. warn at ~200) — that is the value that actually trips the wall, so it is a
better signal than the sum. A steady climb means ingest is outrunning background
compaction.

If steady-state compaction genuinely cannot keep up (sustained high
`sst_files_max` with no backfill in flight), tune the table-level TWCS options
(`compaction.twcs.*`) on the GreptimeDB side rather than relying on repeated
manual `compact_table` calls. Treat engine-side compaction tuning as the last
step, after confirming the climb is steady-state and not a one-off backfill.
