# Development

Local development setup for Openfuse (Langfuse on GreptimeDB). For deploying a self-hosted stack, see [deployment](deployment.md); for the codebase layout, see [architecture](architecture.md).

## Prerequisites

- Node (see `.nvmrc`).
- `corepack` enabled (pnpm version is pinned in `package.json`; use `corepack pnpm@<pinned>` to avoid resolution issues).
- Docker + Docker Compose.

## Setup

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

pnpm run dev          # all packages
# or: pnpm run dev:web / pnpm run dev:worker
```

`docker-compose.dev.yml` brings up GreptimeDB (gRPC `:4001`, MySQL wire `:4002`), Postgres, and Redis with no app containers; it is the reference for the `greptimedb` service definition. MinIO is gated behind the `s3` profile and is off by default (media and the eval blob store use local volumes).

## GreptimeDB schema

The schema lives in `packages/shared/greptime/migrations/*.sql` and is applied by `greptime:migrate` (the runner is `packages/shared/src/server/greptime/applyMigrations.ts`). It discovers `.sql` files by name order, strips comments, and applies idempotent DDL. Re-run `greptime:migrate` whenever you add or pull a migration; it is safe to run repeatedly.

Migrations are plain `CREATE ... IF NOT EXISTS` DDL with no ledger and no down-migrations (see [known limitations](known-limitations.md)). To inspect the schema directly:

```bash
mysql -h127.0.0.1 -P4002 -uroot openfuse -e "SHOW TABLES;"
```

> When running scripts on the host against the Compose GreptimeDB, override the service-name env with `GREPTIME_GRPC_URL=localhost:4001 GREPTIME_SQL_HOST=localhost GREPTIME_SQL_PORT=4002`.

## Tests

Targeted unit tests live next to the code:

```bash
# GreptimeDB write path, read repositories, query engine
pnpm --filter @langfuse/shared exec vitest run src/server/greptime src/features/query/server

# typecheck + lint (max-warnings 0)
pnpm run typecheck && pnpm run lint
```

After changing `packages/shared`, **rebuild its dist** so the worker resolves the new exports at runtime (the `@langfuse/shared/src/*` import path is served from the built output):

```bash
pnpm --filter @langfuse/shared run build
```

## Parity harness (read-path changes)

Read-path changes should keep dashboard output identical to upstream Langfuse. The harness in [`docs/greptimedb-migration/parity/`](greptimedb-migration/parity/) sends identical ingestion payloads to the fork and an upstream ClickHouse stack and diffs all major read-path outputs. Run it after any read-path change; a run is green when `FAIL = 0`. See the harness `README.md` for setup.

## Repo layout

```
web/                # Next.js app (UI + tRPC + public REST)
worker/             # queue consumers, replay, evals, GreptimeDB writers
packages/shared/    # domain, DB, queue contracts, repositories, GreptimeDB layer
  greptime/migrations/*.sql           # GreptimeDB schema
  src/server/greptime/**              # write path, deletion, schema runner
  src/server/repositories/greptime/** # read repositories
  src/features/query/**               # dashboard query engine
```

Dependency direction: `web` → `@langfuse/shared`, `worker` → `@langfuse/shared`; `@langfuse/shared` imports from neither. See `AGENTS.md` for the full agent/contributor guide.
