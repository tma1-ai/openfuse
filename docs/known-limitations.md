# Known limitations

Openfuse is an alpha. The GreptimeDB migration is functionally complete and parity-verified for the covered surface, but the items below are real and you should know them before deploying. None are silent: each is either a documented behavior difference or an operational requirement.

For the full engineering detail behind the dashboard items, see the [parity ledger](greptimedb-migration/parity/ledger.md).

## Operational

### Backfill and large-query performance depend on compaction

The one performance lever for the GreptimeDB read path is **SST compaction**, not indexing or query shape. A large backfill (e.g. fleet reconciliation) lands many small SST files; until they compact, by-type dashboard queries degrade, and GreptimeDB enforces a hard **384 SST files per region** ceiling above which even `count(*)` fails. After any large backfill you must compact the hot tables manually, and you should alert on `langfuse.greptime.sst_files_max`. Full procedure: [operations: compaction](operations/compaction.md).

### GreptimeDB schema bootstrap is a manual step

The container entrypoint runs Postgres migrations automatically but **not** the GreptimeDB schema. You must run `pnpm --filter=@langfuse/shared run greptime:migrate` after GreptimeDB is healthy and before serving traffic, and again after pulling new migrations. If you skip it, reads fail later in the product path rather than at startup. See [deployment](deployment.md).

### GreptimeDB migrations are idempotent DDL, with no ledger

Schema migrations are plain `CREATE ... IF NOT EXISTS` DDL applied by file order; there is no applied-migrations ledger and no down-migrations. Re-running is safe (idempotent), but a migration that needs to alter an existing table's data must be written carefully. A proper migration ledger is on the roadmap.

## Behavior differences vs upstream Langfuse

### Dashboard percentiles are approximate

GreptimeDB computes quantiles with `uddsketch` (approximate); ClickHouse uses a different approximation. `p50/p75/p90/p95/p99` values differ slightly on continuous measures. Both are approximations; neither is exact.

### Substring search is scan-prone; indexed search is term-based

Full-text indexes exist for `input`, `output`, and metadata values, and the explicit FTS operator uses whole-term `matches_term`. But `contains` / `starts with` / `ends with` still compile to case-insensitive `LIKE`, which is correct (matches ClickHouse substring semantics) but scan-prone on large payload columns over wide time windows.

### Timeseries gap-fill differs

For time-bucketed dashboard queries the fork emits a zero-valued row for every empty bucket in range; upstream omits empty buckets. Buckets with data match exactly. (Arguably more useful for charting.)

### Stricter query validation

The fork rejects some nonsensical dashboard queries with `400 InvalidRequestError` that upstream silently accepts (e.g. `histogram` on a relation-backed measure, `sum` on a string measure). A client relying on upstream's leniency will get a 400. The fork is the stricter / more correct side here.

### Called-tool value breakdowns attribute per distinct tool

Breaking a value measure (cost/tokens) down by _called tool_ attributes an observation's value once per **distinct** called tool. Upstream `arrayJoin(tool_call_names)` multiplies the value by call multiplicity (a tool called twice doubles that observation's cost in its bucket, which over-counts). The fork is the conserving / more correct side; this is the only place the by-tool numbers differ. Tool **filters** and available-tool (`toolNames`) breakdowns are exact parity.

### Default model-price catalog size differs

The fork ships a larger default `default-model-prices.json` than the tracked upstream release. Cost computation itself is identical for a given model price; only the count of bundled defaults differs. Pin the same catalog if you need byte-identical `GET /api/public/models`.

## Source-of-truth exception

### `dataset_run_items` deletion is a projection hard-delete

Traces, observations, and scores delete by appending a tombstone to `raw_events`, so replay rebuilds a soft-deleted row. `dataset_run_items` instead hard-deletes the projection and relies on the replay path skipping deleted items; it does not keep a per-entity tombstone in `raw_events`. This is a deliberate, documented exception ("`raw_events` is the complete source of truth" holds for traces/observations/scores, not DRI). It works operationally; it is called out so the invariant is explicit.

## Not blockers, but worth knowing

- Object storage is optional but not gone. Ingestion needs no S3/MinIO, but media uploads, the OTel carrier, and batch/blob exports still use a storage backend, defaulting to a local filesystem volume. See [deployment](deployment.md).
- Alpha posture: no long-term support or backports; only the latest pre-release is maintained. See [SECURITY.md](../SECURITY.md).
