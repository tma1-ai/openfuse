import {
  greptimeQuery,
  logger,
  recordGauge,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import { PeriodicExclusiveRunner } from "../../utils/PeriodicExclusiveRunner";

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
 * series. The Redis lock is used as an interval cooldown: `acquire()` with a TTL of one interval and
 * never release, so a replica ticking mid-interval finds the lock held and skips. `withLock()` is
 * deliberately not used here — it releases on return, which would reopen the duplicate-emit window
 * for staggered replicas.
 */
export class GreptimeStatsRunner extends PeriodicExclusiveRunner {
  protected get defaultIntervalMs(): number {
    return env.LANGFUSE_GREPTIME_STATS_INTERVAL_MS;
  }

  constructor() {
    super({
      name: "greptime-stats-runner",
      lockKey: "langfuse:greptime-stats",
      // Cover one full interval so staggered replicas skip; the lock expires just before the next
      // tick (scheduled one interval after the previous run finished), letting that tick re-emit.
      lockTtlSeconds: Math.ceil(env.LANGFUSE_GREPTIME_STATS_INTERVAL_MS / 1000),
    });
  }

  protected async execute(): Promise<void> {
    const lockResult = await this.lock.acquire();
    if (lockResult === "held_by_other") {
      logger.debug(
        `${this.instanceName}: another replica sampled this interval, skipping`,
      );
      return;
    }
    // "acquired" holds the cooldown until the TTL expires; "skipped" (Redis unavailable) proceeds so
    // a single-replica or Redis-less deployment still emits the metric. Intentionally no release().

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
      `${this.instanceName}: emitted region statistics for ${rows.length} tables`,
    );
  }
}
