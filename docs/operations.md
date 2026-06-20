# Operations

Openfuse runs the Langfuse app against two stores: Postgres for app/config data and GreptimeDB for the analytics event store. Operating it is mostly operating those two databases. This page covers the **fork-specific** operational notes and points to the upstream runbooks for everything generic — it does not duplicate them.

- GreptimeDB operations: [GreptimeDB · Deployments & Administration](https://docs.greptime.com/user-guide/deployments-administration/overview/).
- Langfuse app/Postgres operations: [Langfuse · Self-hosting](https://langfuse.com/self-hosting).

For first-time setup (env, automatic migrations, Compose, images) see [deployment](deployment.md). For local dev see [development](development.md).

## Configuration

Configuration is split by store, so there is no single config file to learn:

- **Fork-specific** `GREPTIME_*`, retention (`LANGFUSE_GREPTIME_TTL`), object-storage, and the migration toggles are documented in [deployment · Configuration](deployment.md#1-configuration); the source of truth is `packages/shared/src/env.ts`.
- **Everything else** (auth/SSO, Postgres, Redis, secrets, headers, scaling) is upstream Langfuse and unchanged — see [Langfuse · Configuration](https://langfuse.com/self-hosting/configuration).
- **GreptimeDB server config** (data dir, object storage, WAL, table options) is GreptimeDB's own — see [GreptimeDB · Configuration](https://docs.greptime.com/user-guide/deployments-administration/configuration/).

## Monitoring

The worker samples per-table GreptimeDB region statistics every 60 s (`GreptimeStatsRunner`, gated by `LANGFUSE_GREPTIME_STATS_ENABLED`, period `LANGFUSE_GREPTIME_STATS_INTERVAL_MS`) and emits these gauges, all tagged by `table`:

| Metric                            | Meaning                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `langfuse.greptime.sst_files_max` | Per-region maximum SST count; **hits the 384 wall first** — the one to alert on. |
| `langfuse.greptime.sst_files`     | Sum of SST files across the table's regions.                                     |
| `langfuse.greptime.region_rows`   | Row count.                                                                       |
| `langfuse.greptime.disk_size`     | On-disk bytes.                                                                   |
| `langfuse.greptime.memtable_size` | In-memory (un-flushed) bytes.                                                    |

For the database itself, use GreptimeDB's own tooling: [check DB status](https://docs.greptime.com/user-guide/deployments-administration/monitoring/check-db-status/), [self-monitoring/metrics](https://docs.greptime.com/user-guide/deployments-administration/monitoring/overview/), and [slow queries](https://docs.greptime.com/user-guide/deployments-administration/monitoring/slow-query/). Application-level health, logs, and tracing for the Langfuse web/worker are unchanged from [Langfuse · Self-hosting](https://langfuse.com/self-hosting).

## Performance: compaction

The one performance lever for the GreptimeDB read path is **SST compaction**, not indexing or query shape. By-type dashboard queries scan a time range and group by key; latency is dominated by **how many SST files the scan has to merge**. Measured on the same query (GreptimeDB 1.1.x, ~3.5M observations): 1022 un-compacted SST files → **9.6 s**; after `compact_table` (1 file) → **0.2 s**. A `key` skipping index does not help, so do not add one.

GreptimeDB enforces a hard ceiling of **384 SST files per region**: above it even `count(*)` fails with `Too many files (max allowed: 384)` until background compaction catches up. The writer flushes roughly every second under load, so high ingest or a bulk backfill produces small SSTs fast.

**After a large backfill, compact the hot tables once.** Fleet reconciliation replays history through the write path and can land thousands of small SSTs (measured: ~2.5M observations → ~4032 SST files on `observations_usage_cost`), enough to trip the wall. After the backfill drains, run over the MySQL wire (`:4002`) against `GREPTIME_DB`:

```sql
ADMIN compact_table('observations_usage_cost', 'strict_window', 86400);
ADMIN compact_table('observations',            'strict_window', 86400);
```

`strict_window` with an explicit window (86400 s = 1 day) compacts within day-aligned windows; prefer a real window over a bare `0`, which collapses the whole table in one pass and is disruptive on a long-TTL production table. Run fire-and-forget and watch `sst_files_max` drop back to single digits. The hot tables are the ingest-heavy ones — `observations`, `observations_usage_cost`, and the observation EAV side-tables — then `traces` / `scores` and their EAV tables.

**Alert on `langfuse.greptime.sst_files_max` approaching 384** (e.g. warn at ~200). A steady climb with no backfill in flight means ingest is outrunning background compaction; tune the table-level TWCS options ([`compaction.twcs.*`](https://docs.greptime.com/user-guide/deployments-administration/manage-data/compaction/)) rather than relying on repeated manual compaction.

Background: GreptimeDB [compaction](https://docs.greptime.com/user-guide/deployments-administration/manage-data/compaction/) and [performance-tuning tips](https://docs.greptime.com/user-guide/deployments-administration/performance-tuning/performance-tuning-tips/). The deep fork-specific runbook with the scale evidence is [`greptimedb-migration/08-compaction-runbook.md`](greptimedb-migration/08-compaction-runbook.md).

## Capacity planning and retention

Retention is database-level TTL: `LANGFUSE_GREPTIME_TTL` (default `730d`) is applied at startup via `ALTER DATABASE ... SET 'ttl'`, covering every table at once. To change it, set the env and restart.

GreptimeDB stores data in object storage with local disk as cache, so storage scales independently of compute. For sizing disk, object storage, and compute, see [GreptimeDB · Capacity plan](https://docs.greptime.com/user-guide/deployments-administration/capacity-plan/). For scaling the Langfuse web/worker tier, see [Langfuse · Scaling](https://langfuse.com/self-hosting/scaling).

## Backup and disaster recovery

Two stores to protect:

- **Postgres** (app/config data — the irreplaceable side, since it holds users, projects, prompts, and keys): standard Postgres backup; see [Langfuse · Postgres](https://langfuse.com/self-hosting/infrastructure/postgres).
- **GreptimeDB** (analytics events): [GreptimeDB · Disaster recovery](https://docs.greptime.com/user-guide/deployments-administration/disaster-recovery/overview/), and specifically the [standalone DR solution](https://docs.greptime.com/user-guide/deployments-administration/disaster-recovery/dr-solution-for-standalone/) for single-node deployments.

GreptimeDB's `raw_events` is the analytics source of truth, so a restored `raw_events` can rebuild every projection by replay. Object storage already gives the analytics data cloud-level durability when GreptimeDB is backed by S3.

## Maintenance and upgrades

- **GreptimeDB**: [maintenance mode](https://docs.greptime.com/user-guide/deployments-administration/maintenance/maintenance-mode/) and [version upgrades](https://docs.greptime.com/user-guide/deployments-administration/upgrade/).
- **Openfuse app**: roll the `tma1ai/openfuse-*` images forward by pinning a newer tag and re-running `docker compose up -d --pull always` (see [deployment](deployment.md#published-images-and-tags)). The web/standalone entrypoint re-applies the Postgres and GreptimeDB migrations on startup, so an upgrade that ships new schema migrates automatically; the GreptimeDB runner is idempotent and re-applies the full set on every start. Langfuse-specific upgrade notes: [Langfuse · Upgrade](https://langfuse.com/self-hosting/upgrade).
