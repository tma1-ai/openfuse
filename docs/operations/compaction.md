# Operations: compaction & SST fragmentation

The one performance lever for the GreptimeDB read path is **compaction**, not indexing or query shape. This page covers why, what to do after a large backfill, and how to monitor steady state. It is the public, operator-facing version of the migration runbook (`docs/greptimedb-migration/08-compaction-runbook.md`) plus the scale evidence from `docs/greptimedb-migration/parity/g3-performance-evidence.md`.

## Why fragmentation is the only lever

By-type dashboard queries (the `observations_usage_cost` EAV aggregation, the by-type-by-time reads) scan a time range and group by key. Latency is dominated by **how many SST files the scan has to merge**, not by row count, the join, or any `key` index.

Measured (GreptimeDB 1.1.x, ~3.5M observations / ~14M EAV rows), same query:

| State                          | Latency   |
| ------------------------------ | --------- |
| 1022 un-compacted SST files    | **9.6 s** |
| After `compact_table` (1 file) | **0.2 s** |

`EXPLAIN ANALYZE` attributes the cost to merging the SST files, not the join or aggregation. A `key` skipping index does **not** help (the guard is anti-selective and the group-by happens after the scan) — do not add one.

GreptimeDB enforces a hard per-region ceiling: once a region exceeds **384 SST files**, even `count(*)` fails with `Too many files (max allowed: 384)` until background compaction catches up. The writer flushes roughly every second under load, so high ingest or a bulk backfill produces small SSTs fast.

At healthy scale with compacted tables, index pruning is present and effective (bloom narrowed a `trace_id` lookup to the exact matching rows) and read queries run in tens of milliseconds. Background TWCS compaction transiently leaves a freshly-merged SST un-indexed (lazy index build), so monitor SST count and let compaction settle after big merges.

## After a large backfill — mandatory manual compaction

Fleet reconciliation/backfill replays history through the write path, landing many small SSTs (measured: backfilling ~2.5M observations created ~4032 SST files on `observations_usage_cost` — enough to trip the 384-file wall and degrade every by-type dashboard to ~10 s).

**After the backfill drains, compact the affected tables once**, over the MySQL wire (`:4002`) against `GREPTIME_DB` (`openfuse`):

```sql
ADMIN compact_table('observations_usage_cost', 'strict_window', 86400);
ADMIN compact_table('observations',            'strict_window', 86400);
```

`strict_window` with an explicit window (86400 s = 1 day) compacts within day-aligned windows. Prefer a real window over a bare `0`: `window=0` collapses the whole table into the fewest files in one pass — fine for a short-lived test table, expensive and disruptive on a production table with a long TTL (default 730d). Compaction of `observations` can take a while at scale; run it fire-and-forget and watch the SST metric drop back to single digits.

### `compact_table` reference

```
ADMIN compact_table(<table> [, <type> [, <options>]])
```

- `<type>`: `regular` (default, TWCS; option `parallelism=N`) or `strict_window` / `swcs` (window compaction; option = window seconds, or `window=<seconds>,parallelism=<N>`).
- `window_seconds = 0` — no windowing, fewest output files. Avoid on long-TTL production tables.

## Steady-state monitoring

The worker samples per-table region statistics every 60 s (`GreptimeStatsRunner`, gated by `LANGFUSE_GREPTIME_STATS_ENABLED`, period `LANGFUSE_GREPTIME_STATS_INTERVAL_MS`) and emits gauges, all tagged by `table`:

| Metric                            | Meaning                                            |
| --------------------------------- | -------------------------------------------------- |
| `langfuse.greptime.sst_files_max` | Per-region **maximum** SST count — hits 384 first. |
| `langfuse.greptime.sst_files`     | Sum of SST files across the table's regions.       |
| `langfuse.greptime.region_rows`   | Row count.                                         |
| `langfuse.greptime.disk_size`     | On-disk bytes.                                     |
| `langfuse.greptime.memtable_size` | In-memory (un-flushed) bytes.                      |

**Alert on `langfuse.greptime.sst_files_max` approaching 384** (e.g. warn at ~200). That is the value that trips the wall, so it is a better signal than the sum. A steady climb means ingest is outrunning background compaction.

If steady-state compaction genuinely cannot keep up (sustained high `sst_files_max` with no backfill in flight), tune the table-level TWCS options (`compaction.twcs.*`) on the GreptimeDB side rather than relying on repeated manual `compact_table` calls. Treat engine-side tuning as the last step, after confirming the climb is steady-state and not a one-off backfill.

## Hot tables

The tables that fragment fastest under load are the ingest-heavy ones: `observations`, `observations_usage_cost`, and the other observation EAV side-tables (`observations_metadata`, `observations_tool_definitions`, `observations_tool_calls`), then `traces` / `scores` and their EAV tables. Prioritize these when compacting after a backfill.
