# Quality Gate C — GreptimeDB fork vs upstream Langfuse: parity report

Pre-release quality verification for the openfuse fork (Langfuse with its ClickHouse analytics
backend replaced by GreptimeDB). The method: send the **same** public-API ingestion payloads to both
stacks and diff **all** major read-path outputs, then fix every real divergence. This report reflects
the **post-fix** state.

- Fork (GreptimeDB v1.1.1): `http://localhost:3000`, image `openfuse-web:local` (base v3.184.1)
- Upstream (ClickHouse 24.8): `http://localhost:3001`, `langfuse/langfuse:3.184.1`
- Both scoped to an identical project `parity-proj` (same API keys); environment equivalence locked —
  see `env-manifest.md`.
- Oracle: public REST only, including `/api/public/metrics` (the same `executeQuery`/QueryBuilder layer
  the dashboard UI uses). Harness: `harness/` (see `README.md`); reproducible, deterministic.

## Result (final run `mqm7km0t`)

| status | count | meaning |
|---|---|---|
| **PASS** | **199** | byte-shape identical to upstream |
| **FAIL** | **0** | real divergences — none remaining |
| KNOWN_LIMITATION | 96 | documented engine/config divergences (see `ledger.md`) |
| TYPE_REPR | 0 | representation differences — all fixed |
| STATUS_MISMATCH / ERROR_BOTH | 0 | — |

Coverage (per run): ingestion via the public API — trace create+update, generation create+update,
span create+update, event, a non-GENERATION observation, scores (numeric/categorical/boolean), datasets
+ items + run-items; reads — traces/observations/scores/sessions list+detail with filters,
generations, datasets, `metrics/daily`, and a **legal metrics matrix** of 262 queries (per-view
measures × type-valid aggregations × dimensions × granularities, including by-tool breakdown and
tool-name filter cases).

## Tool filter/breakdown parity (05-review-report Finding #1)

`toolNames` (available tools, `mapKeys(tool_definitions)`) and `calledToolNames` (`tool_call_names`)
were a parity gap — GreptimeDB SQL cannot enumerate JSON map keys, so the fork failed loud on them.
Closed by materialising two tool-name EAV tables (`observations_tool_definitions` /
`observations_tool_calls`, migration `0009`) at write time and routing **filters** through a
project-scoped EAV `EXISTS` (the tags pattern) and **breakdowns** through a relation join +
`GROUP BY tool_name` (the `arrayJoin` pattern). The harness adds by-tool breakdown cases (count /
totalCost / totalTokens) and tool-filter cases (any-of / none-of); all match upstream byte-for-byte.

One deliberate, documented divergence (KNOWN_LIMITATION, not FAIL): a **value** measure broken down
**by called tool**. ClickHouse `arrayJoin(tool_call_names)` explodes the call multiset, so a tool
called N times in one observation multiplies that observation's aggregate (cost/tokens) N×, inflating
the cross-bucket total above the observation's actual value — cost is not conserved. The fork's
tool-call EAV is keyed by distinct `tool_name`, so it attributes the value once per distinct called
tool, consistent with the `count` breakdown (which **both** stacks already report per distinct tool).
**The fork is the corrected semantics here; ClickHouse's multiplicity double-count is the divergence.**
Available-tool breakdown (`by:toolNames`) is a map key set, has no multiplicity, and is exact parity.

## What was found and fixed (earlier in this gate)

1. **Real bug — metrics `by:tags` returned a binary Arrow buffer instead of the tag array.** The
   two-level query builder collapsed leaf dimensions with `min(...)`, and `min()` over an array column
   yields GreptimeDB's binary encoding. Fixed by grouping array-typed dimensions raw (they are 1:1 per
   entity). Trace list/detail/`tags=` filter were never affected.
2. **Representation parity — ClickHouse serializes integer aggregates as JSON strings and floats as
   numbers.** The fork coerced everything to numbers. Fixed with one type-aware shaping pass in the
   executor (int → string, float → number with trailing zeros trimmed), plus per-granularity
   `time_dimension` formatting to match ClickHouse exactly.

After these fixes, every non-KNOWN read-path output matches upstream byte-for-byte.

## Known, accepted divergences (not blocking — `ledger.md`)

Quantile approximation (GreptimeDB uddsketch vs ClickHouse quantile), timeseries gap-fill (fork emits
zero buckets), fork-stricter query validation (rejects nonsensical aggregations upstream silently
accepts), degenerate nested aggregations of count measures, histogram binning, and the image-shipped
model-price catalog size (166 vs 87; cost computation itself is validated equal via a custom model).

## Performance evidence (Gate 3 — `g3-performance-evidence.md`)

- **Index pruning:** at 1.5M observations / 600k scores (compacted), GreptimeDB bloom/inverted/minmax
  pruning is present and effective (bloom narrowed a `trace_id` lookup to the exact 5 rows); all read
  queries ~40–60 ms. Background TWCS compaction transiently leaves freshly-merged SSTs un-indexed
  (lazy index build) — monitor SST count and let compaction settle.
- **F7 ROW_NUMBER dedup** (dataset-run-items, no QUALIFY → hash-repartition + sort + window): exact and
  fast at scale — 50k physical rows → ~169 ms, 250k → ~382 ms, sub-linear, no spill. Seeded with the
  new `dataset-run-scale` scenario.

## How to re-run

See `README.md`. In short: bring up the upstream stack, overlay `parity-proj` on the fork, then
`packages/shared/node_modules/.bin/tsx harness/run.ts`. GREEN = FAIL 0, TYPE_REPR 0, no new
STATUS_MISMATCH. Intended for periodic comparison.
