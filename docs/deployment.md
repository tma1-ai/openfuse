# Deployment

How to self-host Openfuse (Langfuse on GreptimeDB) with Docker Compose. The store is GreptimeDB: gRPC `:4001` for ingest writes, MySQL wire `:4002` for reads and migrations. There is no ClickHouse in this build.

For local development (no app containers), see [development](development.md). For the one performance lever, compaction, see [operations: compaction](operations/compaction.md).

## 1. Configuration

Copy the reference env and edit the secrets:

```bash
cp .env.prod.example .env     # then edit every `# CHANGEME` value
```

The source of truth for every `GREPTIME_*` variable is `packages/shared/src/env.ts`; `.env.prod.example` is the deploy-time reference.

GreptimeDB variables:

| Variable                              | Default          | Notes                                                                                  |
| ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `GREPTIME_GRPC_URL`                   | `localhost:4001` | Ingest SDK endpoint (writes). One address, or comma-separated frontends for a cluster. |
| `GREPTIME_SQL_HOST`                   | `localhost`      | MySQL-wire host (reads + migrations).                                                  |
| `GREPTIME_SQL_PORT`                   | `4002`           | MySQL-wire port.                                                                       |
| `GREPTIME_SQL_READ_ONLY_HOST`         | _(unset)_        | Optional dedicated read host; falls back to `GREPTIME_SQL_HOST`.                       |
| `GREPTIME_DB`                         | `openfuse`       | Target database.                                                                       |
| `GREPTIME_USER` / `GREPTIME_PASSWORD` | `""`             | Empty for an unauthenticated single node; set both for a secured deployment.           |
| `GREPTIME_SQL_MAX_OPEN_CONNECTIONS`   | `25`             | MySQL read-pool size.                                                                  |
| `GREPTIME_RAW_EVENTS_TABLE`           | `raw_events`     | Write-path source-of-truth table.                                                      |
| `LANGFUSE_GREPTIME_TTL`               | `730d`           | Database-level retention, applied by `greptime:migrate`.                               |

For a Compose deployment these point at the `greptimedb` service name. The non-GreptimeDB requirements (Postgres, Redis, `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, …) are unchanged from upstream Langfuse and also live in `.env.prod.example`.

### Object storage is optional

Ingestion and eval-generated scores persist to GreptimeDB `raw_events`, not to a blob store. The remaining object-storage consumers support a local-file backend, so a stock deployment needs **no** MinIO/S3:

| Variable                         | App default | Bundled Compose | Local backend                         |
| -------------------------------- | ----------- | --------------- | ------------------------------------- |
| `LANGFUSE_MEDIA_STORAGE_BACKEND` | `s3`        | `local`         | `local` + `LANGFUSE_MEDIA_LOCAL_PATH` |
| `LANGFUSE_EVENT_STORAGE_BACKEND` | `s3`        | `local`         | `local` + `LANGFUSE_EVENT_LOCAL_PATH` |

The application default for these variables is `s3`, but this repo's `docker-compose.yml` overrides both to `local` (`${...:-local}`), so the bundled stack starts with no object store. `LANGFUSE_EVENT_STORAGE_BACKEND` covers both the OTel carrier and the eval blob store; with `local` they share a filesystem volume, so web and worker must mount the same `LANGFUSE_EVENT_LOCAL_PATH` (the Compose files wire a shared `langfuse_event_data` volume). Only opt-in batch/blob **exports** still require an S3-compatible bucket. The Compose files default both backends to `local` and put MinIO behind a `s3` profile (`docker compose --profile s3 up`), so the default stack starts no object store.

## 2. Bootstrap the GreptimeDB schema (required, before first start)

Postgres migrations run automatically from the web container entrypoint. The GreptimeDB schema does not; the entrypoint deliberately leaves it out. Apply it out of band, once per environment, before the web/worker containers serve traffic, and again after pulling new `packages/shared/greptime/migrations/*.sql`:

For the default Compose deployment, run the migration from your host shell (this needs Node and pnpm via `corepack`; run `pnpm install` once first) and override the container-only service name from `.env`:

```bash
pnpm install
GREPTIME_GRPC_URL=localhost:4001 \
  GREPTIME_SQL_HOST=localhost \
  pnpm --filter=@langfuse/shared run greptime:migrate
```

Migrations are idempotent (`CREATE DATABASE / TABLE IF NOT EXISTS`), so re-running is safe. The same command also applies the database-level retention TTL: an idempotent `ALTER DATABASE ... SET 'ttl'` built from `LANGFUSE_GREPTIME_TTL` (default `730d`) that covers every table at once. To change retention, set `LANGFUSE_GREPTIME_TTL` and re-run; a manual `ALTER DATABASE` is reverted on the next bootstrap.

> If you skip this step, the stack starts but reads fail later in the product path. There is no automatic schema check at startup yet, so treat `greptime:migrate` as a mandatory deploy step.

## 3. The Docker Compose stack

`docker-compose.yml` is the production stack: `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, `redis`. `minio` is defined but gated behind the `s3` profile, so it does not start by default. By default Compose **builds** the web/worker images from this repo so the containers include the fork's GreptimeDB code. GreptimeDB runs in `standalone` mode and persists to the `langfuse_greptimedb_data` volume; web/worker `depends_on` GreptimeDB being healthy (`/health` on port `4000`).

First-run sequence:

```bash
cp .env.prod.example .env                          # edit every # CHANGEME value

docker compose up -d greptimedb postgres redis     # infra first (add `minio` only if using S3)
# wait for greptimedb /health, then bootstrap the schema (needs Node + pnpm on the host):
pnpm install
GREPTIME_GRPC_URL=localhost:4001 \
  GREPTIME_SQL_HOST=localhost \
  pnpm --filter=@langfuse/shared run greptime:migrate # schema bootstrap (section 2)

docker compose up -d                               # start web + worker
```

Validate Compose syntax before deploying:

```bash
docker compose -f docker-compose.yml config -q
```

### Running published images instead of building

Release images are published as `tma1ai/openfuse-web` and `tma1ai/openfuse-worker`. To run those instead of building locally, set the image overrides in `.env` and bring the stack up:

```bash
OPENFUSE_WEB_IMAGE=tma1ai/openfuse-web:<tag>
OPENFUSE_WORKER_IMAGE=tma1ai/openfuse-worker:<tag>
```

Tag policy: a pushed `v*` git tag publishes the full semver, the floating `major.minor` and `major` (non-`-rc` only), and a commit-SHA tag; `latest` moves only on non-`-rc` `v*` releases.

## 4. Verify and persist

After bringing the stack up: create an org/project/user, ingest a trace with any Langfuse SDK, and confirm it appears in the trace list, an observation/score lands, a dashboard renders, and deletion works. Then restart the stack (`docker compose restart`) and confirm the data survives (GreptimeDB persists to its named volume).

## Known-pending validation

A full clean-checkout Compose smoke test and an image-based smoke test against the published `tma1ai/openfuse-*` images are part of the release checklist; see [`docs/greptimedb-migration/06-pre-release-report.md`](greptimedb-migration/06-pre-release-report.md).
