# 07 - Deployment

How to run the openfuse fork (Langfuse on GreptimeDB instead of ClickHouse) as a
self-hosted stack. This covers the required env, the one-time GreptimeDB schema
bootstrap, the Docker Compose stack, and the validation work that is still
pending.

This is an OSS self-hosted fork. The store is GreptimeDB (gRPC `4001` for ingest
writes, MySQL wire `4002` for reads + migrations). There is no ClickHouse client
in this build.

## 1. Required environment

The source of truth for every `GREPTIME_*` variable (names, types, defaults) is
`packages/shared/src/env.ts`. The deploy-time reference file is
[`.env.prod.example`](../../.env.prod.example) — copy it to `.env` and edit the
`# CHANGEME` entries.

GreptimeDB-specific variables:

| Variable                            | Default (env.ts) | Notes                                                                                  |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `GREPTIME_GRPC_URL`                 | `localhost:4001` | Ingest SDK endpoint (writes). One address, or comma-separated frontends for a cluster. |
| `GREPTIME_SQL_HOST`                 | `localhost`      | MySQL-wire host (reads + migrations).                                                  |
| `GREPTIME_SQL_PORT`                 | `4002`           | MySQL-wire port.                                                                       |
| `GREPTIME_SQL_READ_ONLY_HOST`       | _(unset)_        | Optional dedicated read host; falls back to `GREPTIME_SQL_HOST`.                       |
| `GREPTIME_DB`                       | `openfuse`       | Target database.                                                                       |
| `GREPTIME_USER`                     | `""`             | Empty for an unauthenticated single node; set for a secured deployment.                |
| `GREPTIME_PASSWORD`                 | `""`             | Set together with `GREPTIME_USER` when auth is enabled.                                |
| `GREPTIME_SQL_MAX_OPEN_CONNECTIONS` | `25`             | MySQL read-pool size.                                                                  |
| `GREPTIME_RAW_EVENTS_TABLE`         | `raw_events`     | Write-path source-of-truth table.                                                      |

For a Compose deployment the hosts point at the `greptimedb` service name. The
non-Greptime requirements (Postgres, Redis, S3/MinIO, `NEXTAUTH_SECRET`, `SALT`,
`ENCRYPTION_KEY`, …) are unchanged from upstream Langfuse and are also in
`.env.prod.example`.

## 2. Bootstrap the GreptimeDB schema (run before first start)

Postgres migrations run automatically from the web container entrypoint. The
GreptimeDB schema does **not** — the entrypoint deliberately leaves it out
(see the comment in `web/entrypoint.sh` and
`packages/shared/src/server/greptime/applyMigrations.ts`). You must apply it out
of band, once per environment, **before** the web/worker containers start
serving traffic, and again after pulling new
`packages/shared/greptime/migrations/*.sql`.

Run the D2 bootstrap CLI
(`packages/shared/scripts/applyGreptimeSchema.ts`):

```bash
# GreptimeDB must already be running and reachable at GREPTIME_SQL_HOST:GREPTIME_SQL_PORT.
# The script reads GREPTIME_* from .env (it uses dotenv -e ../../.env internally).
pnpm --filter=@langfuse/shared run greptime:migrate
```

The migrations are idempotent (`CREATE DATABASE / TABLE IF NOT EXISTS`), so
re-running is safe. The optional global TTL (`0002_retention.sql`) is part of the
same migration set — there is no separate retention step.

## 3. The Docker Compose stack

[`docker-compose.yml`](../../docker-compose.yml) is the production stack:
`langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, `redis`, and
`minio`. The web/worker services `depends_on` GreptimeDB being healthy
(`/health` on port `4000`). GreptimeDB runs in `standalone` mode and persists to
the `langfuse_greptimedb_data` volume.

[`docker-compose.dev.yml`](../../docker-compose.dev.yml) is the local dev variant
(GreptimeDB + MinIO + Redis + Postgres, no app containers) and is the reference
for the `greptimedb` service definition.

Typical first-run sequence:

```bash
cp .env.prod.example .env          # then edit every # CHANGEME value

docker compose up -d greptimedb postgres redis minio   # bring up infra first
# wait for greptimedb /health, then bootstrap the schema (section 2)
pnpm --filter=@langfuse/shared run greptime:migrate

docker compose up -d               # start langfuse-web + langfuse-worker
```

Validate Compose syntax before deploying:

```bash
docker compose -f docker-compose.yml config -q
```

## 4. Known-pending validation

These have **not** been validated end to end and remain open:

- **Full `docker compose up` smoke test.** Both compose files pass
  `docker compose config -q` (syntax + reference validation). A full stack
  bring-up — schema bootstrap, then write + read traffic through the running
  web/worker images against GreptimeDB — has not been exercised here.
- **Image publish.** `docker-compose.yml` pins the upstream
  `langfuse/langfuse:3` / `langfuse/langfuse-worker:3` images, which do **not**
  contain this fork's GreptimeDB code. Fork images must be built (see
  `docker-compose.build.yml`) and published, and the `image:` tags updated,
  before the published Compose stack runs the GreptimeDB backend.
