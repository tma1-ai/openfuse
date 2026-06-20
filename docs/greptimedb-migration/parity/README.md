# Quality Gate C — backend parity harness (keep for periodic comparison)

Proves the GreptimeDB fork (openfuse) matches upstream Langfuse on every major public read path,
by sending the **same** ingestion payloads to both stacks and diffing all read outputs. Backend-
agnostic: drives only the public REST API (incl. `/api/public/metrics`, which runs the same
`executeQuery`/QueryBuilder layer the dashboard UI uses). Re-runnable on a schedule.

## What it covers

- **Ingestion entries:** trace create+update, generation create+update, span create+update, event,
  a non-GENERATION observation (agent), scores (numeric/categorical/boolean), datasets + items +
  run-items (the F7 ROW_NUMBER dedup path). (OTel is a separate, smaller suite — TODO.)
- **Read matrix:** traces/observations/scores/sessions list+detail with filters, generations,
  datasets, models, score-configs, `metrics/daily`, and a **legal metrics generator**
  (`metricsMatrix.ts`) that enumerates per-view measures × type-constrained aggregations × key
  dimensions × granularities — importing the repo's own view declarations so it tracks code drift.
- **Tiered diff** (`lib.ts`): canonicalize → drop volatile/server-id fields → numeric & datetime
  representation coercion → classify PASS / FAIL / KNOWN_LIMITATION / TYPE_REPR /
  SKIPPED_FORK_REMOVED / STATUS_MISMATCH.

## Layout

```
docker-compose.upstream.parity.yml   # isolated upstream v3.184.1 (ClickHouse), web on :3001 only
.env.upstream.parity                 # upstream secrets + shared parity project identity (gitignored)
.env.fork-parity.init                # fork parity-proj init overlay (gitignored)
env-manifest.md                      # G1.0 environment equivalence record
ledger.md                            # Gate 2 known-limitation ledger (review before release)
harness/                             # the framework (committed)
  lib.ts          config, HTTP, canonicalize, tiered diff, projection wait
  payloads.ts     deterministic batch + custom model + dataset spec + run manifest
  metricsMatrix.ts  legal metrics query generator (imports getViewDeclaration)
  reads.ts        list/detail read cases with run-unique env scoping
  run.ts          orchestrator → report-<runId>.{md,json}
report-<runId>.{md,json}             # per-run output (gitignored)
```

## Run it

```bash
# 1. bring up the isolated upstream stack (images cached: langfuse/langfuse{,-worker}:3.184.1)
cd docs/greptimedb-migration/parity
docker compose -p langfuse-upstream --env-file .env.upstream.parity \
  -f docker-compose.upstream.parity.yml up -d

# 2. add the identical parity-proj to the running fork stack (additive; smoke-proj untouched)
cd ../../..
docker compose -p langfuse --env-file .env \
  --env-file docs/greptimedb-migration/parity/.env.fork-parity.init \
  -f docker-compose.yml up -d --no-deps --force-recreate langfuse-web

# 3. run the harness (tsx lives in packages/shared/node_modules/.bin)
packages/shared/node_modules/.bin/tsx docs/greptimedb-migration/parity/harness/run.ts
```

Output: `report-<runId>.md` (human) + `.json` (machine). Tally is printed to stderr.

### Config (env overrides)

`PARITY_FORK_URL` (`:3000`), `PARITY_UPSTREAM_URL` (`:3001`), `PARITY_PUBLIC_KEY`,
`PARITY_SECRET_KEY`, `PARITY_PROJECT_ID` (`parity-proj`), `PARITY_NOW_MS` (pin the run anchor for a
reproducible window).

## Run isolation

Each run derives a `runId` from its anchor instant and salts all entity ids, the custom model, and
the two **run-unique environments** (`pe<runId>`/`se<runId>`). Broad list queries and every metrics
query are scoped to those environments + the run's time window, so periodic runs accumulating in the
same project never contaminate each other. No raw inserts, no ad-hoc data — public API only.

## Interpreting results — GREEN criteria

A run is release-green when `FAIL == 0` **and** `TYPE_REPR == 0` and there is no new
`STATUS_MISMATCH` or `ERROR_BOTH` (both stacks 5xx). `KNOWN_LIMITATION` is the set of expected
engine/config divergences enumerated in `ledger.md` — review that file when the counts change. Any
new `FAIL` or `TYPE_REPR` means triage.

## Known findings (see ledger.md)

- **L1–L3 (FIXED in this PR):** metrics `by:tags` array decoding, integer-vs-float serialization, and
  `time_dimension` format now match ClickHouse.
- **L4–L9 (KNOWN, non-blocking):** quantile approximation (uddsketch), timeseries gap-fill,
  fork-stricter validation, degenerate count-aggregations, histogram binning, model-catalog size.

## Teardown

```bash
docker compose -p langfuse-upstream -f docs/greptimedb-migration/parity/docker-compose.upstream.parity.yml down       # keep data
docker compose -p langfuse-upstream -f docs/greptimedb-migration/parity/docker-compose.upstream.parity.yml down -v    # wipe volumes
```
