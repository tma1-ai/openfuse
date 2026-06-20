# Openfuse

**Openfuse is a developer-preview fork of [Langfuse](https://github.com/langfuse/langfuse) that replaces ClickHouse with [GreptimeDB](https://github.com/GreptimeTeam/greptimedb) as the observability event store.** It keeps the Langfuse product shape and SDK compatibility — tracing, evals, prompt management, datasets, dashboards — while making GreptimeDB the source of truth for traces, observations, scores, and analytics projections.

> **Status: alpha / developer preview.** The core storage migration is in place and verified against upstream for parity, but this is not positioned as production-ready and is not a no-qualifications drop-in. Run it to evaluate GreptimeDB-backed Langfuse, in dev/staging, and on data you can afford to lose. See [Known limitations](docs/known-limitations.md).

## What this is

Langfuse stores its analytics data in ClickHouse. Openfuse swaps that backend for GreptimeDB — roughly the relationship OpenSearch has to Elasticsearch. The Langfuse application, public APIs, and SDKs are unchanged; only the analytics storage layer is rebuilt. GreptimeDB owns an append-only `raw_events` table as the source of truth, plus merge-mode projection tables and indexed EAV side-tables for metadata/tag/tool filtering.

## What works today

- **Ingestion** — the public ingestion API and OTel endpoint write to GreptimeDB `raw_events`; the worker replays full event history into merged projections.
- **Read path** — traces, observations, scores, sessions (list + detail), dashboards/metrics, datasets, experiments, daily metrics, export streams, and public API GET endpoints read from GreptimeDB.
- **Dashboards** — the metrics query engine runs on GreptimeDB, including metadata/tag/tool filters and breakdowns. Read-path outputs are verified byte-for-byte against upstream Langfuse (see [parity report](docs/greptimedb-migration/parity/PARITY-REPORT.md)).
- **Mutations** — UI trace/score edits write synthetic events to `raw_events` (durable, replayable), not projection-only.
- **Deletion & replay** — entity/project deletes tombstone in `raw_events`; replay rebuilds soft-deleted, no resurrection.
- **Bulk backfill** — an Arrow Flight bulk writer for fleet-wide reconciliation.
- **Object storage is optional** — ingestion no longer requires S3/MinIO (see [deployment](docs/deployment.md)).

For the gaps that remain, read [Known limitations](docs/known-limitations.md) before deploying.

## 5-minute quickstart (Docker Compose)

Requirements: Docker + Docker Compose. The stack is `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, `redis` (object storage is off by default).

```bash
git clone https://github.com/tma1-ai/openfuse.git
cd openfuse
cp .env.prod.example .env          # then edit every `# CHANGEME` value (secrets)

# 1. bring up infra first
docker compose up -d greptimedb postgres redis

# 2. bootstrap the GreptimeDB schema (once per environment, before serving traffic)
pnpm install
pnpm --filter=@langfuse/shared run greptime:migrate

# 3. start the app
docker compose up -d              # langfuse-web + langfuse-worker
```

Open <http://localhost:3000>, create an org/project/user, and point any Langfuse SDK at it.

> **Important — schema bootstrap is a required step.** The container entrypoint runs Postgres migrations automatically but **not** the GreptimeDB schema. Run `greptime:migrate` after GreptimeDB is healthy and before the web/worker serve traffic, and again after pulling new `packages/shared/greptime/migrations/*.sql`. The migrations are idempotent (`CREATE ... IF NOT EXISTS`), so re-running is safe. Full guide: [deployment](docs/deployment.md).

## Published images

Release images are published to Docker Hub:

- `tma1ai/openfuse-web`
- `tma1ai/openfuse-worker`

Tag policy: a pushed `v*` tag publishes the full semver (`1.2.0`), the floating `major.minor` and `major` (non-`-rc` only), and a commit-SHA tag; `latest` moves only on non-`-rc` `v*` releases. To run published images instead of building locally, set `OPENFUSE_WEB_IMAGE` / `OPENFUSE_WORKER_IMAGE` in `.env` to the tags you want and `docker compose up -d`.

## Architecture

```
        SDKs / OTel
            │ ingest
            ▼
      ┌───────────┐        ┌───────────┐
      │ langfuse  │        │ langfuse  │
      │   web     │        │  worker   │
      └─────┬─────┘        └─────┬─────┘
            │                    │
   auth/config│           replay │ raw_events → projections
            ▼                    ▼
      ┌───────────┐        ┌─────────────────────────┐
      │ Postgres  │        │       GreptimeDB         │
      │ (app data)│        │ raw_events (SoT)         │
      └───────────┘        │ traces/observations/...  │
      ┌───────────┐        │ EAV: metadata/tags/tools │
      │   Redis    │       └─────────────────────────┘
      │  (queues)  │
      └───────────┘        Object storage (S3/MinIO) — optional
```

- **Postgres** — application/config data (users, projects, prompts, dataset definitions, API keys).
- **GreptimeDB** — the analytics event store: `raw_events` source of truth, merged projections, and EAV side-tables for filtering.
- **Redis** — BullMQ queues.
- **Object storage** — optional; only for media uploads, the OTel carrier, and batch/blob exports (all default to a local filesystem backend).

Full write-up: [architecture](docs/architecture.md).

## Compatibility with Langfuse

- **Tracks upstream Langfuse `v3.184.1`.** Existing Langfuse SDKs and the public ingestion/REST APIs work unchanged.
- **Dashboard/metrics outputs are verified byte-for-byte against upstream** for the covered query surface; the few intentional divergences (all where the fork is equal or more correct) are listed in the [parity ledger](docs/greptimedb-migration/parity/ledger.md).
- **Postgres migrations are upstream Langfuse's**, applied as-is. The GreptimeDB schema is fork-specific and bootstrapped separately.
- This fork is **not** affiliated with or endorsed by Langfuse. See [migration from Langfuse](docs/migration-from-langfuse.md) for the full compatibility statement.

## Documentation

- [Deployment](docs/deployment.md) — self-host with Docker Compose, env, schema bootstrap, object storage.
- [Development](docs/development.md) — local dev setup, GreptimeDB schema, targeted tests.
- [Architecture](docs/architecture.md) — what lives where, and why ClickHouse is gone.
- [Known limitations](docs/known-limitations.md) — read before deploying.
- [Operations: compaction](docs/operations/compaction.md) — the one performance lever, metrics, and alerts.
- [Migration from Langfuse](docs/migration-from-langfuse.md) — compatibility and what differs.
- [Design history](docs/greptimedb-migration/) — the migration engineering record (design notes, reviews, parity harness).

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute to this fork.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability.

## License

This fork inherits upstream Langfuse licensing: the core is MIT; `ee/` is under the Langfuse EE license. Openfuse is a community fork of Langfuse and retains upstream copyright and attribution. See [LICENSE](LICENSE).
