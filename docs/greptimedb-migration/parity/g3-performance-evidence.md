# Quality Gate C — Gate 3 performance evidence

Independent of Gate 1 (does NOT affect parity PASS/FAIL). Fork GreptimeDB v1.1.0 (`:4002`, db
`openfuse`), project `smoke-proj`, seeded via the seed CLI (no ad-hoc loadgen). Method: mysql
client + `EXPLAIN ANALYZE VERBOSE` (the MCP `explain_query` omits VERBOSE → no index metrics).
Reproduce with `g3-explain-snapshot.sh`.

## Scale seeded
`pnpm run seed -- many-traces --count 100000` + `--count 200000` (project smoke-proj, 30-day spread)
→ **traces 300k / observations 1.5M / scores 600k**. (Prior F5 millions were gone — volume reset.)
Compacted with `ADMIN compact_table('<t>','strict_window','86400')` before measuring (index is
lazy-built onto SSTs).

## G3.1 — index prune snapshot

v1.1.0 `ScanMetricsSet` keys: `rg_total` (row groups considered), `rg_bloom_filtered`,
`rg_inverted_filtered`, `rg_minmax_filtered` (row groups pruned by each), `num_sst_rows` (rows read
from SST), `prefilter_filtered_rows`. All ~40–60 ms at this scale.

### Headline findings (evidence-gated)

1. **Indexes are present and DO prune.** Confirmed directly: a `trace_id` equality query on a freshly
   compacted SST pruned to `num_sst_rows: 5` (exactly the trace's 5 observations) with
   `rg_bloom_filtered` > 0. `SHOW INDEX` confirms `SKIPPING_INDEX_trace_id` (bloom),
   `INVERTED_INDEX_{type,level,environment}`, plus the 0006/0007 set on scores/traces.

2. **Background TWCS compaction confounds the snapshot.** After a manual `compact_table`, GreptimeDB's
   *background* compaction keeps re-merging SSTs; the freshly merged large SST is briefly **un-indexed**
   (lazy index build), so a query against it scans the whole SST (`rg_bloom_filtered=0`,
   `num_sst_rows` ~116k+65k) until that SST is re-indexed. Successive snapshot runs flip between
   "pruned to 5 rows" and "scans 182k rows" purely from compaction timing — **not** a query-correctness
   issue. This is the same operational truth as the F5 finding: *compaction is the lever; monitor SST
   count and let compaction settle before trusting prune numbers.*

3. **Low-cardinality enum filters prune via `rg_minmax_filtered`, not the inverted index, in this seed
   layout.** Rare values (`type=EVENT` 6 rows, `level=WARNING` 6, `environment=production` 8) show
   `rg_minmax_filtered` > 0 and `rg_inverted_filtered = 0`. Because many-traces writes enum values
   correlated with time/id ordering, min/max on the row-group already excludes most groups, so the
   inverted index adds little *on this data shape*. Dominant values (`type=GENERATION` 60%,
   `data_type=NUMERIC` ~100%) correctly scan broadly (index rightly not used). **This does not prove the
   inverted index is useless in production** — production enum distribution/clustering differs (cf. the
   0007 validation, which observed inverted pruning on a different layout). Re-run on production-shaped
   data before any index-removal decision.

### Snapshot table (one representative, freshly-compacted run)

| column (filter) | index | result rows | sst_rows scanned | rg_total | rg_bloom | rg_inverted | rg_minmax | latency |
|---|---|---|---|---|---|---|---|---|
| observations.trace_id (eq) | bloom | 5 | 5–182k* | 31 | >0 | 0 | 0 | ~60 ms |
| traces.session_id (eq) | bloom | 318 | 18.5k | 8 | 0–* | 0 | 1 | ~42 ms |
| traces.user_id (eq) | bloom | 102 | 18.5k | 8 | 0–* | 0 | 1 | ~41 ms |
| scores.trace_id (eq) | bloom | 2 | 201k | 31 | 0–* | 0 | 0 | ~50 ms |
| observations.type=EVENT (6) | inverted | 0 | 182k | 31 | 0 | 0 | 21 | ~54 ms |
| observations.level=WARNING (6) | inverted | 0 | 182k | 31 | 0 | 0 | 21 | ~56 ms |
| observations.environment=production (8) | inverted | 0 | 182k | 33 | 0 | 0 | 21 | ~57 ms |
| scores.source=EVAL (4) | inverted | 4 | 201k | 32 | 0 | 0 | 1 | ~48 ms |
| observations.type=GENERATION (60%) | inverted | 900k | 812k | 31 | 0 | 0 | 0 | ~56 ms |

`*` bloom `sst_rows` flips between 5 (indexed SST) and ~182k (un-indexed freshly-merged SST) depending
on background-compaction timing — see finding #2.

### Not flagged for index removal
No column showed a *stable* prune=0 with the index applied — bloom pruned to exact granules when SSTs
were indexed; min/max covered the rare enum values. The `rg_inverted_filtered=0` observation is
attributed to seed layout + compaction timing, not a dead index. **Recommendation:** a definitive
prune/index-removal snapshot needs (a) compaction fully settled (poll `region_statistics.sst_num`
until stable) and (b) production-shaped data, not the bulk-sequential many-traces layout.

## G3.2 — F7 dataset-run-items ROW_NUMBER dedup

The dedup (`datasetRunItems.ts` / `experiments.ts`, GreptimeDB has no QUALIFY) compiles to:

```
MergeScanExec → RepartitionExec Hash([project_id,dataset_id,dataset_run_id,dataset_item_id],16)
  → SortExec [project_id,dataset_id,dataset_run_id,dataset_item_id ASC, created_at DESC]
    → BoundedWindowAggExec row_number() (mode=Sorted)
      → FilterExec (rn = 1)
```

**Confirmed:** the dedup does a **full hash-repartition + sort** of all matching physical run-item rows
by the 4-column partition key before the windowed `ROW_NUMBER` — the O(n log n) cost F7 has always
flagged. At current scale (6 run-items) it is trivial (~52 µs window compute).

**Scale benchmark — measured** via the new `dataset-run-scale` seed scenario (many physical rows per
logical `(run,item)` key = re-run/update churn, GreptimeDB-only bulk write):

| physical rows | logical keys (dup factor) | dedup result | latency | spill |
|---|---|---|---|---|
| 50,000 | 10,000 (×5) | 10,000 ✓ | ~169 ms | none |
| 250,000 | 50,000 (×5) | 50,000 ✓ | ~382 ms | none |

Both compacted (`strict_window 86400`) before timing. Dedup count is exact (= distinct logical keys).
The full hash-repartition + sort scales **sub-linearly** here (5× rows → ~2.3× latency, dominated by
scan not sort) and does **not spill** at 250k. No knee within this range; the ROW_NUMBER sort is not a
concern at these scales. Reproduce:
`pnpm run seed -- dataset-run-scale --runs 100 --items 500 --duplicates 5 --project <p>` then the dedup
`EXPLAIN ANALYZE`. For 10× larger, raise `--items`/`--duplicates` (watch for `spill_count > 0`, the
real knee signal).
