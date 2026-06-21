import { greptimeQuery, logger } from "@langfuse/shared/src/server";

import { env } from "../../env";
import { PeriodicRunner } from "../../utils/PeriodicRunner";
import { RedisLock } from "../../utils/RedisLock";

/**
 * Periodically flushes only the raw_events memtable to SST via `ADMIN flush_table`. Ingestion
 * point-reads an entity's full raw_events history per event; on the bulk memtable that read has no
 * primary-key seek and degrades to an O(memtable) scan until the data flushes to a prunable SST (the
 * measured drain bottleneck). `auto_flush_interval` is engine-global, so a table-scoped flush keeps
 * the aggressive flushing (and its compaction cost) confined to the one read-amplified table. The
 * Redis bucket lock stops staggered replicas from double-flushing the same interval.
 */
export class GreptimeRawEventsFlushRunner extends PeriodicRunner {
  protected get name(): string {
    return "greptime-raw-events-flush-runner";
  }

  protected get defaultIntervalMs(): number {
    return env.LANGFUSE_GREPTIME_RAW_EVENTS_FLUSH_INTERVAL_MS;
  }

  protected async execute(): Promise<void> {
    const lockResult = await this.createBucketLock().acquire();
    if (lockResult === "held_by_other") return;

    // ADMIN takes a string literal, not a bind param; guard the (trusted) config value anyway.
    const table = env.GREPTIME_RAW_EVENTS_TABLE;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      logger.error(
        `${this.name}: refusing to flush, unsafe table name '${table}'`,
      );
      return;
    }

    await greptimeQuery({ query: `ADMIN flush_table('${table}')` });
  }

  private createBucketLock(nowMs: number = Date.now()): RedisLock {
    const intervalMs = env.LANGFUSE_GREPTIME_RAW_EVENTS_FLUSH_INTERVAL_MS;
    const bucket = Math.floor(nowMs / intervalMs);
    return new RedisLock(`langfuse:greptime-raw-events-flush:${bucket}`, {
      ttlSeconds: Math.ceil((intervalMs * 2) / 1000),
      name: this.name,
    });
  }
}
