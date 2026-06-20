# Deployment

How to self-host Openfuse (Langfuse on GreptimeDB) with Docker Compose. The store is GreptimeDB: gRPC `:4001` for ingest writes, MySQL wire `:4002` for reads and migrations. There is no ClickHouse in this build.

For local development (no app containers), see [development](development.md). For monitoring, performance/compaction, backup, and upgrades, see [operations](operations.md).

## 1. Configuration

There are two starting points:

- **Evaluation / quickstart** — `cp .env.quickstart.example .env`. This ships working dev defaults (insecure, public) plus an auto-provisioned demo project, so `docker compose up` boots with zero edits. Do not use it on a network you do not control.
- **Real deployment** — `cp .env.prod.example .env`, then set your own values for the secrets below.

| Variable                              | Purpose                                                          | How to set                                                                        |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NEXTAUTH_SECRET`                     | Signs NextAuth session tokens.                                   | `openssl rand -base64 32`                                                         |
| `SALT`                                | Salts the hash of project API keys.                              | `openssl rand -base64 32`                                                         |
| `ENCRYPTION_KEY`                      | Encrypts sensitive data at rest; must be 256-bit (64 hex chars). | `openssl rand -hex 32`                                                            |
| `POSTGRES_PASSWORD` + `DATABASE_URL`  | Postgres password (the server's and the app's must match).       | Pick a strong password; use it for `POSTGRES_PASSWORD` and inside `DATABASE_URL`. |
| `REDIS_AUTH`                          | Redis password (the server's and the app's must match).          | Pick a strong password.                                                           |
| `GREPTIME_USER` / `GREPTIME_PASSWORD` | GreptimeDB credentials. A non-empty password turns on enforced auth. | User defaults to `openfuse`. Set a strong `GREPTIME_PASSWORD` for any real deployment (see "GreptimeDB authentication" below). |

The source of truth for every `GREPTIME_*` variable is `packages/shared/src/env.ts`; `.env.prod.example` is the full deploy-time reference.

GreptimeDB variables:

| Variable                              | Default          | Notes                                                                                  |
| ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `GREPTIME_GRPC_URL`                   | `localhost:4001` | Ingest SDK endpoint (writes). One address, or comma-separated frontends for a cluster. |
| `GREPTIME_SQL_HOST`                   | `localhost`      | MySQL-wire host (reads + migrations).                                                  |
| `GREPTIME_SQL_PORT`                   | `4002`           | MySQL-wire port.                                                                       |
| `GREPTIME_SQL_READ_ONLY_HOST`         | _(unset)_        | Optional dedicated read host; falls back to `GREPTIME_SQL_HOST`.                       |
| `GREPTIME_DB`                         | `openfuse`       | Target database.                                                                       |
| `GREPTIME_USER` / `GREPTIME_PASSWORD` | `openfuse` / `""` | Empty password = unauthenticated single node; set a password to enforce auth.          |
| `GREPTIME_SQL_MAX_OPEN_CONNECTIONS`   | `25`             | MySQL read-pool size.                                                                  |
| `GREPTIME_RAW_EVENTS_TABLE`           | `raw_events`     | Write-path source-of-truth table.                                                      |
| `LANGFUSE_GREPTIME_TTL`               | `730d`           | Database-level retention, applied automatically at startup (see §2).                   |

For a Compose deployment these point at the `greptimedb` service name. The non-GreptimeDB requirements (Postgres, Redis, `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`, …) are unchanged from upstream Langfuse and also live in `.env.prod.example`; for the full set and their meaning, see [Langfuse · Configuration](https://langfuse.com/self-hosting/configuration).

### GreptimeDB authentication

GreptimeDB only enforces credentials when it is started with a [static user provider](https://docs.greptime.com/user-guide/deployments-administration/authentication/static/); a node started without one accepts any connection. The Compose files wire this for you through a small entrypoint (`docker/greptimedb/entrypoint.sh`):

- **`GREPTIME_PASSWORD` empty (default)** — the `greptimedb` container starts without a user provider, so it is unauthenticated. Fine for a local single node you fully control (quickstart, dev). Do not expose it.
- **`GREPTIME_PASSWORD` set** — the container writes a `user=password` credentials file (mode `600`) and starts with `--user-provider=static_user_provider:file:…`, so the password is actually enforced. The app authenticates with the same `GREPTIME_USER` (default `openfuse`) and `GREPTIME_PASSWORD`, so **the app and server values must match**. Set both in `.env` for any real deployment, just like `POSTGRES_PASSWORD` and `REDIS_AUTH`.

### GreptimeDB server config

The fork ships a small server config at `docker/greptimedb/config.toml`, mounted read-only and passed via `--config-file`. It keeps GreptimeDB's defaults and carries commented performance-tuning hints (cache and write-buffer sizes default to `Auto`, sized from machine memory — right for a single node). Tune it per the [GreptimeDB performance-tuning guide](https://docs.greptime.com/user-guide/deployments-administration/performance-tuning/performance-tuning-tips/); see also [operations](operations.md).

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

## 3. Run the stack

There are two topologies. Both read the same `.env`, both auto-migrate on startup (§2), and both persist GreptimeDB to a named volume. **Start with standalone**; move to the split topology when you need to scale web and worker independently — that is a deployment change, not a data migration (the stores outlive the app containers).

### Single container (standalone) — start here

`tma1ai/openfuse-standalone` runs **both** the web server and the worker in one container under a process supervisor — the GreptimeDB-standalone analogue for Openfuse. `docker-compose.standalone.yml` wires it to Postgres, Redis, and GreptimeDB.

Build from this repo:

```bash
docker compose -f docker-compose.standalone.yml up -d   # then open http://localhost:3000
```

Or run the published image instead of building locally — set the override in `.env` and pull:

```bash
OPENFUSE_STANDALONE_IMAGE=tma1ai/openfuse-standalone:1.0.0-alpha.1
```

```bash
docker compose -f docker-compose.standalone.yml up -d --pull always
```

The supervisor treats the two processes as one unit: if either exits, the container stops so your restart policy restarts the whole thing.

### Split web + worker (`docker-compose.yml`)

The production stack runs web and worker as separate, independently scalable services: `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, `redis` (`minio` is defined but gated behind the `s3` profile, so it does not start by default). GreptimeDB runs in `standalone` mode and persists to the `langfuse_greptimedb_data` volume.

Build from this repo (default):

```bash
docker compose up -d   # builds web/worker from source, starts the full stack
```

Or run the published images instead of building — pin the tags in `.env`:

```bash
OPENFUSE_WEB_IMAGE=tma1ai/openfuse-web:1.0.0-alpha.1
OPENFUSE_WORKER_IMAGE=tma1ai/openfuse-worker:1.0.0-alpha.1
```

```bash
docker compose up -d --pull always   # uses the pinned images instead of building
```

This Compose file defines both `build:` and `image:` for web/worker, so `--pull always` is what makes it pull the published image rather than build locally; a plain `docker compose up` would build. Validate the file first with `docker compose config -q`.

### Published images and tags

Images are published to Docker Hub by the `release-images.yml` workflow on each `v*` git tag: `tma1ai/openfuse-web`, `tma1ai/openfuse-worker`, `tma1ai/openfuse-standalone`. The first preview is `1.0.0-alpha.1`. A `v*` tag always publishes the exact semver (e.g. `1.0.0-alpha.1`) and a commit-SHA tag. The floating `major.minor` and `major` tags and `latest` are published only for stable releases — the workflow skips all of them for any SemVer pre-release (`-alpha` / `-beta` / `-rc`), which get only the exact `{{version}}` and commit-SHA tags. So during the alpha, `latest` does not move; pin an explicit tag. To upgrade later, bump the pinned tag and re-run `docker compose up -d --pull always`.

## 4. Verify and persist

After bringing the stack up: create an org/project/user, ingest a trace with any Langfuse SDK, and confirm it appears in the trace list, an observation/score lands, a dashboard renders, and deletion works. Then restart the stack (`docker compose restart`) and confirm the data survives (GreptimeDB persists to its named volume).

## Known-pending validation

A full clean-checkout Compose smoke test and an image-based smoke test against the published `tma1ai/openfuse-*` images are part of the release checklist; see [`docs/greptimedb-migration/06-pre-release-report.md`](greptimedb-migration/06-pre-release-report.md).
