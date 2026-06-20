# Contributing to Openfuse

Thanks for your interest. Openfuse is a developer-preview fork of [Langfuse](https://github.com/langfuse/langfuse) that replaces ClickHouse with [GreptimeDB](https://github.com/GreptimeTeam/greptimedb) as the analytics store. This guide is for contributing to the fork. It is short on purpose; the alpha moves fast.

> **Where to file things.** Issues and PRs for the GreptimeDB backend, the fork's deployment, or fork-specific behavior go to this repo (`tma1-ai/openfuse`). Bugs in the Langfuse product that also reproduce on upstream belong [upstream](https://github.com/langfuse/langfuse). Bugs in GreptimeDB belong in [GreptimeDB](https://github.com/GreptimeTeam/greptimedb).

## What this fork changes

Only the analytics storage layer. Postgres (app/config data), Redis (queues), the web/worker apps, the public APIs, and the SDKs are upstream Langfuse. ClickHouse is removed; GreptimeDB owns `raw_events` (append-only source of truth), merged projection tables, and EAV side-tables for metadata/tag/tool filtering. The fork-specific code lives under:

- `packages/shared/src/server/greptime/**`: write path, schema, deletion, migrations runner
- `packages/shared/src/server/repositories/greptime/**`: read repositories
- `packages/shared/src/features/query/greptimeDataModel.ts` and `.../query/server/greptimeQueryBuilder.ts`: dashboard query engine
- `packages/shared/greptime/migrations/*.sql`: GreptimeDB schema
- `worker/src/services/GreptimeWriter/**`, `worker/src/services/GreptimeBulkWriter/**`: writers
- `worker/src/features/greptime-reconciliation/**`: rebuild/backfill

Read [`docs/architecture.md`](docs/architecture.md) first; the engineering history is in [`docs/greptimedb-migration/`](docs/greptimedb-migration/).

## Local development setup

Requirements: Node (see `.nvmrc`), `corepack` (pnpm pinned in `package.json`), Docker.

```bash
pnpm install

# infra: GreptimeDB + Postgres + Redis (+ optional MinIO behind the s3 profile)
docker compose -f docker-compose.dev.yml up -d

# Postgres schema (upstream Langfuse migrations)
pnpm run db:deploy

# GreptimeDB schema (fork-specific), required before the app
GREPTIME_GRPC_URL=localhost:4001 \
  GREPTIME_SQL_HOST=localhost \
  pnpm --filter=@langfuse/shared run greptime:migrate

pnpm run dev
```

GreptimeDB listens on gRPC `:4001` (ingest writes) and MySQL wire `:4002` (reads + migrations). The schema bootstrap is idempotent; re-run it whenever you add or pull a migration. See [`docs/development.md`](docs/development.md) for details.

## Running tests

- Targeted GreptimeDB unit tests live next to the code. `exec vitest run <path>` filters to the given paths (these are pure unit tests, no `.env` needed); `pnpm run test` runs the full shared suite.
  ```bash
  pnpm --filter @langfuse/shared exec vitest run src/server/greptime src/features/query/server
  ```
- Typecheck and lint before pushing:
  ```bash
  pnpm run typecheck && pnpm run lint
  ```
- After changing `packages/shared`, rebuild its dist so the worker resolves new exports at runtime:
  ```bash
  pnpm --filter @langfuse/shared run build
  ```
- Read-path changes should keep dashboard parity green; see the parity harness in [`docs/greptimedb-migration/parity/`](docs/greptimedb-migration/parity/).

## PR expectations

- Keep changes scoped; avoid unrelated refactors. Match the surrounding code style.
- Migration-sensitive changes (schema, write path, deletion, replay, read repositories, query engine) need tests, and a parity check where they touch the read path. Schema migrations must be idempotent DDL (`CREATE ... IF NOT EXISTS`); there is no migration ledger yet (see [known limitations](docs/known-limitations.md)).
- Don't commit secrets. Keep `.env*.example` in sync with required env vars.
- Commit messages and PR descriptions: plain and descriptive, no AI-generated attribution footers.

## Porting upstream Langfuse changes

This fork tracks a specific upstream Langfuse version (currently `v3.184.1`). When porting upstream changes:

- App/UI/API/Postgres changes usually port directly.
- Anything that touches the analytics store (ClickHouse reads/writes upstream) has to be re-expressed against the GreptimeDB layer; do not reintroduce a ClickHouse client. A CI guard fails the build on product-path ClickHouse tokens.
- Call out in the PR which upstream commit/version a change is ported from.

## Where help is most useful

- Closing remaining Langfuse parity gaps (see [known limitations](docs/known-limitations.md)).
- Production hardening for backfill and compaction (see [operations](docs/operations.md)).
- A GreptimeDB migration ledger (replace the idempotent-DDL convention).
- Compose/image smoke automation.
