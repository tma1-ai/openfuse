# Known limitations

Openfuse is an alpha. The GreptimeDB migration is functionally complete and parity-verified for the covered surface. This page lists the genuine limitations — constraints and caveats that affect how you deploy, query, or recover.

It is **not** a list of output differences. Where the fork's dashboard/metrics output diverges from upstream Langfuse, the fork is equal or more correct; those intentional differences are summarised at the end and detailed in the [parity ledger](greptimedb-migration/parity/ledger.md).

## Functional

### Indexed full-text search is whole-term only

Full-text indexes on `input`, `output`, and metadata values back the explicit FTS operator through whole-term `matches_term`. Substring matching (`contains` / `starts with` / `ends with`) is not indexed — it compiles to case-insensitive `LIKE` and scans, which is correct but can be slow on large payload columns over wide time windows.

## Operational

### GreptimeDB migrations are idempotent DDL, with no ledger

The web and standalone entrypoints apply the GreptimeDB schema on startup (gated by `LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED`, serialised across replicas by a Postgres advisory lock). There is no applied-migrations ledger, so the runner re-applies every `.sql` on each start and every statement must stay idempotent: `CREATE ... IF NOT EXISTS`, declarative `ALTER ... SET INDEX`, applied in file order, with no down-migrations. It tolerates only the one common non-idempotent re-run error (`ADD COLUMN` on an existing column, errno 1060); any other migration error fails the container at startup. A migration that rewrites existing data must be written with this in mind, and a real migration ledger is on the roadmap. See [deployment](deployment.md).

### Object storage is optional, not gone

Ingestion needs no object store — traces, observations, and scores persist to GreptimeDB `raw_events`. Media uploads, the OTel carrier, and the eval blob store default to local filesystem volumes in the bundled Compose files. But opt-in batch/blob **exports** still require an S3-compatible bucket. See [deployment](deployment.md).

## Source-of-truth exception

### `dataset_run_items` deletion is a projection hard-delete

Traces, observations, and scores delete by appending a tombstone to `raw_events`, so replay rebuilds a soft-deleted row and a restored `raw_events` reconstructs deletion state. `dataset_run_items` instead hard-deletes the projection and relies on the replay path skipping deleted items; it keeps no per-entity tombstone in `raw_events`. So "`raw_events` is the complete source of truth" holds for traces/observations/scores but not for DRI. It works operationally; it is called out so the exception is explicit.

## Intentional differences from upstream Langfuse (not limitations)

These are documented behaviour differences, not defects: output can differ from upstream, but the fork is equal or more correct. Full detail and parity evidence are in the [parity ledger](greptimedb-migration/parity/ledger.md).

- **Approximate percentiles.** `p50`–`p99` use GreptimeDB `uddsketch`; upstream uses a different approximation. Values differ slightly; both are approximate.
- **Empty time buckets are filled.** Time-bucketed queries emit a zero-valued row for every empty bucket in range; upstream omits them. Buckets with data match exactly.
- **Stricter query validation.** The fork returns `400 InvalidRequestError` for some nonsensical dashboard queries that upstream silently accepts (e.g. `histogram` on a relation-backed measure, `sum` on a string measure).
- **By-called-tool value breakdowns conserve.** Breaking cost/tokens down by _called tool_ attributes an observation's value once per distinct tool; upstream multiplies by call multiplicity. Tool filters and available-tool breakdowns are exact parity.
- **Larger default model-price catalog.** The fork bundles more default model prices than the tracked upstream release; per-model cost is identical. Pin the same catalog for byte-identical `GET /api/public/models`.
