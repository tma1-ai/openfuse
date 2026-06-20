# Openfuse

Openfuse is a developer-preview fork of [Langfuse](https://github.com/langfuse/langfuse) that swaps the analytics store from ClickHouse to [GreptimeDB](https://github.com/GreptimeTeam/greptimedb). The Langfuse product, public APIs, and SDKs stay the same; GreptimeDB becomes the source of truth for traces, observations, scores, and the analytics projections behind dashboards.

> **Status: alpha / developer preview.** The storage migration is in place and the read path is parity-checked against upstream, but treat this as preview software. Run it to evaluate GreptimeDB-backed Langfuse in dev or staging, on data you can afford to lose. It is not production-ready. See [Known limitations](docs/known-limitations.md).

## What this is

Langfuse keeps its analytics data in ClickHouse. Openfuse replaces that backend with GreptimeDB, roughly the way OpenSearch relates to Elasticsearch. The application code, public APIs, and SDKs are untouched; only the analytics storage layer is rebuilt. GreptimeDB holds an append-only `raw_events` table as the source of truth, plus merge-mode projection tables and indexed EAV side-tables that back metadata, tag, and tool filtering.

## What works today

- Ingestion: the public ingestion API and the OTel endpoint write to `raw_events`, and the worker replays the full event history into merged projections.
- Reads: traces, observations, scores, sessions (list and detail), dashboards and metrics, datasets, experiments, daily metrics, export streams, and the public GET endpoints all read from GreptimeDB.
- Dashboards: the metrics query engine runs on GreptimeDB, with metadata, tag, and tool filters and breakdowns. The output is checked byte-for-byte against upstream Langfuse (see the [parity report](docs/greptimedb-migration/parity/PARITY-REPORT.md)).
- Mutations: UI edits to traces and scores append synthetic events to `raw_events`, so they survive replay instead of living only on the projection.
- Deletion and replay: deleting an entity or project writes a tombstone to `raw_events`; a later replay rebuilds the row as soft-deleted rather than resurrecting it.
- Bulk backfill: an Arrow Flight bulk writer for fleet-wide reconciliation.
- Object storage is optional: ingestion no longer needs S3 or MinIO (see [deployment](docs/deployment.md)).

Read [Known limitations](docs/known-limitations.md) before you deploy.

## 5-minute quickstart (Docker Compose)

Requirements: Docker and Docker Compose. The stack is `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, and `redis`, with object storage off by default. Both the Postgres and GreptimeDB schemas migrate automatically inside the container on startup — no manual bootstrap step.

```bash
git clone https://github.com/tma1-ai/openfuse.git
cd openfuse
cp .env.prod.example .env     # then edit every `# CHANGEME` value (secrets)
docker compose up -d          # builds web/worker, starts the full stack
```

Open <http://localhost:3000>, create an org/project/user, and point any Langfuse SDK at it.

> **Migrations are automatic.** The web container entrypoint applies the Postgres and GreptimeDB schemas on startup (idempotent; serialised across replicas by a Postgres advisory lock; fail-closed). Opt out with `LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED` / `LANGFUSE_AUTO_GREPTIME_MIGRATION_DISABLED`. Full guide: [deployment](docs/deployment.md).

### Single container (standalone)

For a single node, `tma1ai/openfuse-standalone` runs web + worker in one container (the GreptimeDB-standalone analogue):

```bash
docker compose -f docker-compose.standalone.yml up   # then open http://localhost:3000
```

## Published images

Release images are published to Docker Hub:

- `tma1ai/openfuse-web`
- `tma1ai/openfuse-worker`
- `tma1ai/openfuse-standalone` — web + worker in one container, for single-node self-hosting

A pushed `v*` tag publishes the full semver (`1.2.0`), the floating `major.minor` and `major` (non-`-rc` only), and a commit-SHA tag; `latest` moves only on non-`-rc` `v*` releases. To run published images instead of building locally, set `OPENFUSE_WEB_IMAGE` / `OPENFUSE_WORKER_IMAGE` (or `OPENFUSE_STANDALONE_IMAGE`) in `.env` and `docker compose up -d`.

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
      └───────────┘        Object storage (S3/MinIO), optional
```

Postgres holds application and config data: users, projects, prompts, dataset definitions, API keys. GreptimeDB is the analytics event store: `raw_events`, the merged projections, and the EAV side-tables used for filtering. Redis runs the BullMQ queues. Object storage is optional and only used for media uploads, the OTel carrier, and batch/blob exports, all of which default to a local filesystem path.

Full write-up: [architecture](docs/architecture.md).

## Compatibility with Langfuse

This fork tracks upstream Langfuse `v3.184.1`. Existing Langfuse SDKs and the public ingestion/REST APIs work unchanged. Dashboard and metrics output is checked byte-for-byte against upstream for the covered query surface; the few intentional divergences, all cases where the fork is equal or more correct, are listed in the [parity ledger](docs/greptimedb-migration/parity/ledger.md). Postgres migrations are upstream Langfuse's and apply as-is, while the GreptimeDB schema is fork-specific and bootstrapped separately.

Openfuse is a community fork and is not affiliated with or endorsed by Langfuse. See [migration from Langfuse](docs/migration-from-langfuse.md) for the full compatibility statement.

## Documentation

- [Deployment](docs/deployment.md): self-host with Docker Compose, env, automatic migrations, standalone image, object storage.
- [Development](docs/development.md): local setup, GreptimeDB schema, targeted tests.
- [Architecture](docs/architecture.md): what lives where, and why ClickHouse is gone.
- [Known limitations](docs/known-limitations.md): read before deploying.
- [Operations: compaction](docs/operations/compaction.md): the one performance lever, its metrics, and alerts.
- [Migration from Langfuse](docs/migration-from-langfuse.md): compatibility and what differs.
- [Design history](docs/greptimedb-migration/): the migration engineering record (design notes, reviews, parity harness).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

This fork inherits upstream Langfuse licensing: the core is MIT; `ee/` is under the Langfuse EE license. Openfuse is a community fork of Langfuse and retains upstream copyright and attribution. See [LICENSE](LICENSE).
