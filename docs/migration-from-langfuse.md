# Migration from Langfuse / compatibility

Openfuse is a fork of Langfuse with the analytics store swapped from ClickHouse to GreptimeDB. This page states what is compatible, what differs, and what a move from upstream Langfuse does and does not cover.

> Openfuse is a community fork and is **not** affiliated with or endorsed by Langfuse.

## Version tracked

This fork currently tracks upstream Langfuse `v3.184.1`. The web app, public APIs, Postgres schema, and SDK contracts come from that release.

## SDK and API compatibility

Existing Langfuse SDKs work unchanged: the public ingestion API and the OTel endpoint are the same, so pointing any Langfuse SDK at your Openfuse URL with project keys ingests normally.

The public REST GET endpoints (traces, observations, sessions, scores, datasets, metrics) are served from GreptimeDB and return the same shapes. Dashboard and metrics output is checked byte-for-byte against upstream for the covered surface; the few intentional divergences are listed in [known limitations](known-limitations.md) and the [parity ledger](greptimedb-migration/parity/ledger.md), all cases where the fork is equal or more correct.

One thing to watch: the fork rejects a handful of nonsensical dashboard queries with `400 InvalidRequestError` that upstream silently accepts, so a client relying on upstream's leniency may need to adjust.

## What differs from upstream

| Area                      | Upstream Langfuse     | Openfuse                                                                                                 |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| Analytics store           | ClickHouse            | GreptimeDB                                                                                               |
| Event source of truth     | S3/blob event store   | GreptimeDB `raw_events` (append-only)                                                                    |
| Object storage for ingest | required              | optional (local-file backends default)                                                                   |
| Schema bootstrap          | automatic             | GreptimeDB schema is a manual `greptime:migrate` step                                                    |
| Dashboard percentiles     | ClickHouse `quantile` | GreptimeDB `uddsketch` (approximate; small differences)                                                  |
| Tool/metadata/tag filters | `map`/`array` access  | EAV `EXISTS` / join (same results; see known limitations for the one called-tool value-breakdown nuance) |

See [architecture](architecture.md) for the full picture and [known limitations](known-limitations.md) for the behavior differences.

## Can I migrate an existing Langfuse deployment's data?

Not in place, and not automatically. Openfuse is a fresh-install target: there is no tool to copy historical ClickHouse data into GreptimeDB. Treat it as a new analytics backend, stand up a fresh Openfuse stack, and start ingesting. Postgres (app/config data) uses upstream Langfuse's schema and migrations, so that side is compatible, but the analytics history does not transfer.

If you need historical analytics data, keep it in your existing Langfuse deployment; this fork is for evaluating and running GreptimeDB-backed Langfuse on new data.

## Upstream Langfuse migrations

- Postgres migrations are upstream Langfuse's and are applied as-is by the web entrypoint.
- Analytics-store migrations from upstream (ClickHouse DDL) do not apply here; the GreptimeDB schema is fork-specific (`packages/shared/greptime/migrations/*.sql`). When porting upstream changes that touch the analytics store, re-express them against the GreptimeDB layer; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Posture

This is an alpha / developer preview. Do not position it as a production-ready or no-qualifications drop-in replacement. Run it in dev/staging and on data you can afford to lose while the operational story (backfill, compaction automation, migration ledger) matures.
