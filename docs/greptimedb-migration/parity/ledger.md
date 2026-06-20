# Quality Gate C — known-limitation ledger

Every non-PASS class from the backend parity run (fork GreptimeDB `:3000` vs upstream Langfuse
v3.184.1 ClickHouse `:3001`, project `parity-proj`), with an owner decision and release-blocking
verdict.

**Post-fix status:** the real bug (L1) and both representation divergences (L2, L3) are **FIXED** in
this PR. Final run `mqm2nj9t`: **PASS 191 / FAIL 0 / TYPE_REPR 0 / KNOWN 94 / STATUS_MISMATCH 0**.
A run is GREEN for release when FAIL = 0, TYPE_REPR = 0, and no new STATUS_MISMATCH / ERROR_BOTH —
only the documented KNOWN classes below remain. Re-run after any read-path change: see `README.md`.

---

## FIXED in this PR

### L1. Metrics grouped by `tags` returned the raw Arrow array buffer (FIXED)
- **Was:** `GET /api/public/metrics` with `dimensions:[{field:"tags"}]` returned a mojibake string
  (hex `ef bf bd 00 00 01 10 00 00 04 "beta"` = a length-prefixed Arrow string-array buffer) instead
  of `["beta"]`. Root cause: the two-level query builder collapses leaf dimensions with `min(...)`,
  and `min()` over an array column returns GreptimeDB's binary array encoding. Trace
  list/detail/`tags=` filter were never affected (they read the `traces_tags` EAV table).
- **Fix:** `greptimeQueryBuilder.ts` now groups array-typed dimensions (`type: "string[]"`) raw in
  the inner query (1:1 per entity, so grouping adds no cardinality) instead of `min()`. GreptimeDB
  returns a native array, matching ClickHouse. **Resolved** — both stacks identical.

### L2. Integer-vs-float aggregation serialization (FIXED)
- **Was:** the executor coerced every metric to a number, while ClickHouse serializes UInt64/Int64
  aggregates (count/uniq/sum-of-int) as JSON **strings** (`"2"`) and Float64 (avg/cost/percentiles)
  as JSON **numbers** (`0.0028`).
- **Fix:** `greptimeQueryExecutor.ts` applies one type-aware shaping pass — integer-typed metrics →
  string, float-typed → number (trailing zeros trimmed) — driven by the measure type + aggregation
  threaded from the builder. Matches ClickHouse exactly.

### L3. `time_dimension` format (FIXED)
- **Was:** fork `2026-06-20T05:00:00.000Z`; ClickHouse `2026-06-20T05:00:00Z` (minute/hour) /
  `2026-06-20` (day/week/month).
- **Fix:** the same shaping pass formats `time_dimension` per granularity to match ClickHouse.

---

## KNOWN_LIMITATION — documented engine/config divergence (96 cases, non-blocking)

### L4. Quantile aggregations differ (45) — `p50/p75/p90/p95/p99`
e.g. `latency/p95` fork `48548.07` vs upstream `47800`; `value/p50` fork `0.8436` vs `0.85`.
GreptimeDB uses **uddsketch** (approximate); ClickHouse `quantile()` uses a different approximation.
Small on continuous measures, inherent to the engines. **Verdict:** non-blocking, expected. Document
that dashboard percentiles are approximate. Owner: product note.

### L5. Timeseries gap-fill differs (8) — `*/ts:hour`, `*/ts:day`
Fork emits a row for every bucket in range (empty buckets `=0` via `date_bin`); upstream omits empty
buckets. Buckets **with data match**. **Verdict:** non-blocking (zeros are implied; arguably more
useful for charting). Owner: product note.

### L6. Fork stricter query validation (29) — fork `400 InvalidRequestError` vs upstream `200`
`histogram` only on a base (non-relation) numeric measure on GreptimeDB (9); `sum/avg/min/max/p*/
histogram` rejected on string measures `uniqueUserIds`/`uniqueSessionIds` ("Valid: count, uniq") (20)
— upstream silently accepts the nonsensical aggregation. **Verdict:** non-blocking; the fork is **more
correct**. A client relying on upstream's leniency would get a 400 — note in the migration guide.
Owner: product note.

### L7. Degenerate nested aggregation of a count/cardinality measure (10)
`avg/min/max/uniq` of `count`/`countScores`/`observationsCount`/… : fork returns the count, upstream
`1`. Meaningless query (no dashboard does `avg(count)`); engines differ on the nested aggregation.
**Verdict:** non-blocking (not a real query shape).

### L8. Histogram binning differs (1) — `value/histogram`
Different bin boundaries/counts (GreptimeDB floor-bucketing vs ClickHouse adaptive). **Verdict:**
non-blocking, expected; histogram is approximate. Owner: product note.

### L10. Called-tool breakdown of a value measure (2) — `totalCost|totalTokens/sum/by:calledToolNames`
Upstream `arrayJoin(tool_call_names)` explodes the call **multiset**, so a tool called N times in one
observation multiplies that observation's aggregate N× (e.g. search called twice → `sum_totalCost`
`0.0056` vs the observation's actual `0.0028`), inflating the cross-bucket total above the real value
— cost/tokens are **not conserved**. The fork's `observations_tool_calls` EAV is keyed by distinct
`tool_name`, attributing the value once per distinct called tool — consistent with the `count`
breakdown (which **both** stacks already report per distinct tool) and conserving. **Verdict:**
non-blocking; the fork is **more correct** (ClickHouse's multiplicity double-count is the divergence).
Available-tool breakdown (`by:toolNames`, a map key set) has no multiplicity and is **exact parity**.
Owner: product note.

### L9. Image-shipped model price catalog differs (1) — `GET /api/public/models`
Fork ships **166** default model prices, upstream v3.184.1 ships **87** (build-time config, not a
read-path bug). Cost-computation parity is validated separately via a custom model created identically
on both stacks (computed cost matches exactly). **Verdict:** non-blocking; pin the same
`default-model-prices.json` if strict catalog parity is wanted. Owner: build config.

---

## Excluded by design (not counted)
- Server-assigned `createdAt`/`updatedAt`, `htmlPath`, pagination `meta`/cursors.
- Server-generated ids that differ per stack: `modelId`, `usagePricingTierId`, dataset/run/run-item
  ids (datasets matched on name; run-items on natural key).
- `usagePricingTierName`: fork names the default tier "Standard"; upstream returns `null` — fork-only
  pricing-tier enrichment (additive feature). Owner: product note (additive).
