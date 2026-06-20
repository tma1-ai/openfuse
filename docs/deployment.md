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
| `LANGFUSE_GREPTIME_TTL`               | `730d`           | Database-level retention, applied automatically at startup (see §2).                   |

For a Compose deployment these point at the `greptimedb` service name. The non-GreptimeDB requirements (Postgres, Redis, `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, …) are unchanged from upstream Langfuse and also live in `.env.prod.example`.

### Object storage is optional

Ingestion and eval-generated scores persist to GreptimeDB `raw_events`, not to a blob store. The remaining object-storage consumers support a local-file backend, so a stock deployment needs **no** MinIO/S3:

| Variable                         | App default | Bundled Compose | Local backend                         |
| -------------------------------- | ----------- | --------------- | ------------------------------------- |
| `LANGFUSE_MEDIA_STORAGE_BACKEND` | `s3`        | `local`         | `local` + `LANGFUSE_MEDIA_LOCAL_PATH` |
| `LANGFUSE_EVENT_STORAGE_BACKEND` | `s3`        | `local`         | `local` + `LANGFUSE_EVENT_LOCAL_PATH` |

The application default for these variables is `s3`, but this repo's `docker-compose.yml` overrides both to `local` (`${...:-local}`), so the bundled stack starts with no object store. `LANGFUSE_EVENT_STORAGE_BACKEND` covers both the OTel carrier and the eval blob store; with `local` they share a filesystem volume, so web and worker must mount the same `LANGFUSE_EVENT_LOCAL_PATH` (the Compose files wire a shared `langfuse_event_data` volume). Only opt-in batch/blob **exports** still require an S3-compatible bucket. The Compose files default both backends to `local` and put MinIO behind a `s3` profile (`docker compose --profile s3 up`), so the default stack starts no object store.

## 2. Migrations run automatically on startup

Both schemas are applied by the container entrypoint when the app starts — you do not bootstrap anything by hand for a normal deployment:

- **Postgres** migrations run from the `langfuse-web` (and standalone) entrypoint, gated by `LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED`.
- **GreptimeDB** schema runs from the same entrypoint, gated by `LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED`. It applies every `packages/shared/greptime/migrations/*.sql` plus the database-level retention TTL (`ALTER DATABASE ... SET 'ttl'` from `LANGFUSE_GREPTIME_TTL`, default `730d`, covering every table at once).

Both are **idempotent** and **fail-closed**: the GreptimeDB runner re-applies the full set on every start (there is no migration ledger), tolerating only the one common non-idempotent re-run error (`ADD COLUMN` on an existing column), and a Postgres **advisory lock** serialises concurrent web replicas so two containers never migrate at once. If a migration fails, the container exits rather than serving against an un-migrated store. To change retention later, set `LANGFUSE_GREPTIME_TTL` and restart.

The `langfuse-worker` image does not run migrations (it relies on web/standalone having applied them first), matching upstream Langfuse.

### Running the GreptimeDB migration by hand

You only need this if you set `LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED=true` or are bootstrapping a host without the app containers (e.g. local dev — see [development](development.md)). It needs Node + pnpm via `corepack` (`pnpm install` once first) and, from the host, the `localhost` override for the container-only service name:

```bash
pnpm install
GREPTIME_GRPC_URL=localhost:4001 \
  GREPTIME_SQL_HOST=localhost \
  pnpm --filter=@langfuse/shared run greptime:migrate
```

## 3. The Docker Compose stack

`docker-compose.yml` is the production stack: `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, `redis`. `minio` is defined but gated behind the `s3` profile, so it does not start by default. By default Compose **builds** the web/worker images from this repo so the containers include the fork's GreptimeDB code. GreptimeDB runs in `standalone` mode and persists to the `langfuse_greptimedb_data` volume; web/worker `depends_on` GreptimeDB being healthy (`/health` on port `4000`).

First-run sequence — no manual schema step; the web container migrates both stores on startup (§2):

```bash
cp .env.prod.example .env     # edit every # CHANGEME value
docker compose up -d          # builds web/worker, starts the full stack
```

`langfuse-web` and `langfuse-worker` `depends_on` GreptimeDB/Postgres/Redis being healthy, so Compose starts them in the right order; the web entrypoint then applies the Postgres + GreptimeDB schemas before serving.

Validate Compose syntax before deploying:

```bash
docker compose -f docker-compose.yml config -q
```

### Running published images instead of building

Release images are published as `tma1ai/openfuse-web`, `tma1ai/openfuse-worker`, and `tma1ai/openfuse-standalone`. To run the split web/worker images instead of building locally, set the image overrides in `.env` and bring the stack up:

```bash
OPENFUSE_WEB_IMAGE=tma1ai/openfuse-web:<tag>
OPENFUSE_WORKER_IMAGE=tma1ai/openfuse-worker:<tag>
```

Tag policy: a pushed `v*` git tag publishes the full semver, the floating `major.minor` and `major` (non-`-rc` only), and a commit-SHA tag; `latest` moves only on non-`-rc` `v*` releases.

## Single-container (standalone)

For a single node — self-hosting or evaluation — `tma1ai/openfuse-standalone` runs **both** the web server and the worker in one container under a process supervisor, the GreptimeDB-standalone analogue for Openfuse. `docker-compose.standalone.yml` wires it to Postgres, Redis, and GreptimeDB:

```bash
docker compose -f docker-compose.standalone.yml up   # then open http://localhost:3000
```

The standalone entrypoint runs the same automatic Postgres + GreptimeDB migrations as the web image (§2) before starting either process. Set `OPENFUSE_STANDALONE_IMAGE=tma1ai/openfuse-standalone:<tag>` in `.env` to run a published image instead of building locally.

Use this for a single-node deployment; for independent web/worker scaling, use the split images and `docker-compose.yml` above. The supervisor treats the two processes as one unit: if either exits, the container stops so your restart policy restarts the whole thing.

## 4. Verify and persist

After bringing the stack up: create an org/project/user, ingest a trace with any Langfuse SDK, and confirm it appears in the trace list, an observation/score lands, a dashboard renders, and deletion works. Then restart the stack (`docker compose restart`) and confirm the data survives (GreptimeDB persists to its named volume).

## Known-pending validation

A full clean-checkout Compose smoke test and an image-based smoke test against the published `tma1ai/openfuse-*` images are part of the release checklist; see [`docs/greptimedb-migration/06-pre-release-report.md`](greptimedb-migration/06-pre-release-report.md).
