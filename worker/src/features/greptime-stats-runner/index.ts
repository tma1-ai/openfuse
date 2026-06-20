import {
  greptimeQuery,
  logger,
  recordGauge,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import { PeriodicRunner } from "../../utils/PeriodicRunner";
import { RedisLock } from "../../utils/RedisLock";

const METRIC_PREFIX = "langfuse.greptime";

/**
 * One row of GreptimeDB region statistics rolled up per physical table. Counters arrive over the
 * MySQL wire as strings (the pool keeps BIGINT as strings to preserve precision), so coerce.
 */
type RegionStatsRow = {
  table_name: string;
  sst_num_max: string | number | null;
  sst_num_sum: string | number | null;
  region_rows: string | number | null;
  disk_size: string | number | null;
  memtable_size: string | number | null;
};

// `engine = 'mito'` skips the metric-engine physical table and system tables, which have no
// per-table region semantics. DATABASE() resolves to GREPTIME_DB (the pool is pinned to it), so the
// rollup is scoped to our tables without interpolating the database name into SQL.
const REGION_STATS_QUERY = `
  SELECT t.table_name          AS table_name,
         MAX(rs.sst_num)       AS sst_num_max,
         SUM(rs.sst_num)       AS sst_num_sum,
         SUM(rs.region_rows)   AS region_rows,
         SUM(rs.disk_size)     AS disk_size,
         SUM(rs.memtable_size) AS memtable_size
  FROM information_schema.tables t
  LEFT JOIN information_schema.region_statistics rs ON t.table_id = rs.table_id
  WHERE t.table_schema = DATABASE() AND t.engine = 'mito'
  GROUP BY t.table_name`;

const toNumber = (value: string | number | null): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Samples per-table GreptimeDB region statistics and emits them as gauges. The SST file count is the
 * signal that matters: a region approaching the engine's "max allowed: 384" file limit silently
 * degrades every by-type dashboard until background compaction catches up (see the F5 scale
 * benchmark). `sst_files_max` is the per-region maximum — the value that actually hits the wall.
 *
 * region_statistics is cluster-global, so emitting from every worker would publish N identical
 * series. The Redis lock is keyed by wall-clock interval bucket; this lets the next bucket emit on
 * time while still keeping staggered replicas in the same bucket from duplicating the sample.
 */
export class GreptimeStatsRunner extends PeriodicRunner {
  protected get name(): string {
    return "greptime-stats-runner";
  }

  protected get defaultIntervalMs(): number {
    return env.LANGFUSE_GREPTIME_STATS_INTERVAL_MS;
  }

  public async processBatch(): Promise<void> {
    return this.execute();
  }

  protected async execute(): Promise<void> {
    const lock = this.createBucketLock();
    const lockResult = await lock.acquire();
    if (lockResult === "held_by_other") {
      logger.debug(
        `${this.name}: another replica sampled this interval, skipping`,
      );
      return;
    }
    // "acquired" holds the bucket key until the TTL expires; "skipped" (Redis unavailable) proceeds
    // so a single-replica or Redis-less deployment still emits the metric. Intentionally no release().

    const rows = await greptimeQuery<RegionStatsRow>({
      query: REGION_STATS_QUERY,
      readOnly: true,
    });

    for (const row of rows) {
      const table = row.table_name;
      recordGauge(`${METRIC_PREFIX}.sst_files_max`, toNumber(row.sst_num_max), {
        table,
        unit: "files",
      });
      recordGauge(`${METRIC_PREFIX}.sst_files`, toNumber(row.sst_num_sum), {
        table,
        unit: "files",
      });
      recordGauge(`${METRIC_PREFIX}.region_rows`, toNumber(row.region_rows), {
        table,
        unit: "rows",
      });
      recordGauge(`${METRIC_PREFIX}.disk_size`, toNumber(row.disk_size), {
        table,
        unit: "bytes",
      });
      recordGauge(
        `${METRIC_PREFIX}.memtable_size`,
        toNumber(row.memtable_size),
        { table, unit: "bytes" },
      );
    }

    logger.debug(
      `${this.name}: emitted region statistics for ${rows.length} tables`,
    );
  }

  private createBucketLock(nowMs: number = Date.now()): RedisLock {
    const intervalMs = env.LANGFUSE_GREPTIME_STATS_INTERVAL_MS;
    const bucket = Math.floor(nowMs / intervalMs);
    return new RedisLock(`langfuse:greptime-stats:${bucket}`, {
      // Keep the bucket key long enough for slow or staggered replicas, but do not block the next
      // bucket because it uses a different key.
      ttlSeconds: Math.ceil((intervalMs * 2) / 1000),
      name: this.name,
    });
  }
}
