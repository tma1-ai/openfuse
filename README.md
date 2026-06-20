<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="resources/openfuse_logo_dark.png" />
  <img alt="Openfuse" src="resources/openfuse_logo_horizontal.png" width="340" />
</picture>

### LLM engineering on a real observability database

[![Release](https://img.shields.io/badge/release-1.0.0--alpha1-f97316)](https://github.com/tma1-ai/openfuse/releases)
[![Status](https://img.shields.io/badge/status-alpha-eab308)](docs/known-limitations.md)
[![License](https://img.shields.io/badge/license-MIT-3b82f6)](LICENSE)
[![Based on Langfuse](https://img.shields.io/badge/based%20on-Langfuse%20v3.184.1-0ea5e9)](https://github.com/langfuse/langfuse)
[![Storage: GreptimeDB](https://img.shields.io/badge/storage-GreptimeDB-00b39f)](https://github.com/GreptimeTeam/greptimedb)
[![GitHub stars](https://img.shields.io/github/stars/tma1-ai/openfuse?style=flat&color=8b5cf6)](https://github.com/tma1-ai/openfuse/stargazers)

[Quickstart](#5-minute-quickstart-docker-compose) · [Deployment](docs/deployment.md) · [Operations](docs/operations.md) · [Architecture](docs/architecture.md) · [Known limitations](docs/known-limitations.md) · [中文](README.zh.md)

</div>

Openfuse is a developer-preview fork of [Langfuse](https://github.com/langfuse/langfuse) that swaps the analytics store from ClickHouse to [GreptimeDB](https://github.com/GreptimeTeam/greptimedb). The Langfuse product, public APIs, and SDKs stay the same; GreptimeDB becomes the source of truth for traces, observations, scores, and the analytics behind dashboards.

> **Status: alpha / developer preview.** The storage migration is in place and the read path is parity-checked against upstream, but treat this as preview software. Run it to evaluate GreptimeDB-backed Langfuse in dev or staging, on data you can afford to lose. It is not production-ready. See [Known limitations](docs/known-limitations.md).

## Why GreptimeDB

LLM traces are observability data: timestamped wide events with high-cardinality context. That is exactly [GreptimeDB](https://docs.greptime.com/user-guide/concepts/why-greptimedb)'s data model. GreptimeDB is a unified observability database — metrics, logs, and traces in one engine, SQL and PromQL/TQL queryable, OTLP-native, with compute–storage separation over object storage. Running Langfuse on it, instead of on a single-purpose columnar store, buys two things today:

- **Start small, scale as you grow.** Begin with a single `openfuse-standalone` container — the GreptimeDB-standalone analogue. GreptimeDB persists to local disk or object storage, and the same engine scales from one node to a cluster as your data grows; scaling down loses no data. Object storage is optional: ingestion needs no S3 or MinIO.
- **Cheap long retention.** Object-storage-native tiered storage plus a plain-SQL database TTL (`LANGFUSE_GREPTIME_TTL`) make multi-month or multi-year retention affordable — a sore point for ClickHouse-backed Langfuse, where configurable data retention is an Enterprise feature. The TTL here is deployment-wide, not per-project.

It also opens a direction that a single-purpose store cannot. Because the events already live in a real observability database, GreptimeDB could take Openfuse **beyond** Langfuse parity: PromQL-native metrics, logs ↔ traces correlation, OTLP-native ingestion, and Flow continuous aggregation for pre-computed rollups. These are **directional and not delivered** — tracked as ideas in [issue #8](https://github.com/tma1-ai/openfuse/issues/8), not features you can use today.

## What works today

- **Ingestion**: the public ingestion API and the OTel endpoint write to `raw_events`, and the worker replays the full event history into merged projections.
- **Reads**: traces, observations, scores, sessions, dashboards and metrics, datasets, experiments, daily metrics, exports, and the public GET endpoints all read from GreptimeDB.
- **Dashboards**: the metrics query engine runs on GreptimeDB, including metadata, tag, and tool filters and breakdowns. Output is checked byte-for-byte against upstream Langfuse (see the [parity report](docs/greptimedb-migration/parity/PARITY-REPORT.md)).
- **Mutations, deletion, replay**: UI edits and deletions append synthetic events to `raw_events`, so replay rebuilds the merged (or soft-deleted) state instead of resurrecting or losing it.
- **Automatic migrations**: the web and standalone containers migrate both Postgres and the GreptimeDB schema on startup — no manual bootstrap.

Read [Known limitations](docs/known-limitations.md) before you deploy.

## 5-minute quickstart (Docker Compose)

Requirements: Docker and Docker Compose. The stack is `langfuse-web`, `langfuse-worker`, `greptimedb`, `postgres`, and `redis`, with object storage off by default. Both schemas migrate automatically inside the container on startup.

```bash
git clone https://github.com/tma1-ai/openfuse.git
cd openfuse
cp .env.quickstart.example .env   # working dev defaults — no edits needed
docker compose up -d              # builds web/worker, starts the full stack
```

Open <http://localhost:3000>. The quickstart env auto-creates a demo project, so you can log in as `demo@example.com` / `langfuse-dev` or point any Langfuse SDK at the bundled keys (`pk-lf-1234567890` / `sk-lf-1234567890`) right away. Those values are insecure dev defaults — for a real deployment start from `.env.prod.example` and set your own secrets. Full guide: [deployment](docs/deployment.md).

### Single container (standalone)

For a single node, `tma1ai/openfuse-standalone` runs web + worker in one container (the GreptimeDB-standalone analogue):

```bash
docker compose -f docker-compose.standalone.yml up   # then open http://localhost:3000
```

## Published images

Release images are published to Docker Hub on each `v*` tag:

- `tma1ai/openfuse-web`
- `tma1ai/openfuse-worker`
- `tma1ai/openfuse-standalone` — web + worker in one container, for single-node self-hosting

The first preview is `1.0.0-alpha1`. To run the standalone image instead of building locally, pin a tag in `.env` (e.g. `OPENFUSE_STANDALONE_IMAGE=tma1ai/openfuse-standalone:1.0.0-alpha1`) and start with `docker compose -f docker-compose.standalone.yml up -d --pull always`. Full instructions for standalone, split web/worker images, and tag policy: [deployment](docs/deployment.md#published-images-and-tags).

## Architecture

Postgres holds application and config data (users, projects, prompts, dataset definitions, API keys), unchanged from upstream Langfuse. GreptimeDB is the analytics event store: an append-only `raw_events` table as the source of truth, plus merged projection tables and indexed EAV side-tables that back metadata, tag, and tool filtering. Redis runs the BullMQ queues. Object storage (S3/MinIO) is optional for the default stack: media uploads, the OTel carrier, and the eval blob store default to local filesystem paths. Opt-in batch/blob exports still need an S3-compatible bucket.

Full write-up: [architecture](docs/architecture.md).

## Compatibility with Langfuse

Openfuse `1.0.0-alpha1` is based on upstream Langfuse `v3.184.1`. Existing Langfuse SDKs and the public ingestion/REST APIs work unchanged. Dashboard and metrics output is checked byte-for-byte against upstream for the covered query surface; the few intentional divergences, all cases where the fork is equal or more correct, are listed in the [parity ledger](docs/greptimedb-migration/parity/ledger.md). Postgres migrations are upstream Langfuse's and apply as-is; the GreptimeDB schema is fork-specific and migrates automatically on container startup (idempotent, advisory-lock serialised, fail-closed).

Openfuse is a community fork and is not affiliated with or endorsed by Langfuse. See [migration from Langfuse](docs/migration-from-langfuse.md) for the full compatibility statement.

## Documentation

- [Deployment](docs/deployment.md): self-host with Docker Compose, env, automatic migrations, standalone and published images.
- [Operations](docs/operations.md): monitoring, performance and compaction, capacity, backup and recovery, upgrades.
- [Development](docs/development.md): local setup, GreptimeDB schema, targeted tests.
- [Architecture](docs/architecture.md): what lives where, and why ClickHouse is gone.
- [Known limitations](docs/known-limitations.md): read before deploying.
- [Migration from Langfuse](docs/migration-from-langfuse.md): compatibility and what differs.
- [Design history](docs/greptimedb-migration/): the migration engineering record (design notes, reviews, parity harness).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

This fork inherits upstream Langfuse licensing: the core is MIT; `ee/` is under the Langfuse EE license. Openfuse is a community fork of Langfuse and retains upstream copyright and attribution. See [LICENSE](LICENSE).
