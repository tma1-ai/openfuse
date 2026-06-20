import { type z } from "zod";
import { type QueryType, type granularities } from "../types";
import { GreptimeQueryBuilder, type PostProcess } from "./greptimeQueryBuilder";
import { greptimeQuery } from "../../../server/greptime/client";
import { greptimeJson } from "../../../server/greptime/sql/rowContract";
import { mergeUsageOrCostMaps } from "../../../server/repositories/greptime/rollup";

/**
 * GreptimeDB dashboard query executor (04-read-path.md, P3). Builds GreptimeDB SQL via
 * `GreptimeQueryBuilder`, runs it, then applies the app-side post-processing the builder cannot
 * express in GreptimeDB SQL:
 *  - dynamic-key by-type expansion (costByType/usageByType) — GreptimeDB cannot enumerate JSON map
 *    keys in SQL, so the per-entity raw JSON is summed per dynamic key app-side;
 *  - time-series gap-fill — GreptimeDB has no `WITH FILL`, so missing buckets are emitted with zeros;
 *  - numeric coercion — mysql2 returns DECIMAL/BIGINT as strings; metric columns are coerced to
 *    numbers and `time_dimension` to an ISO string, matching the ClickHouse row shape.
 *
 * Returns `Array<Record<string, unknown>>` with the same column aliases the ClickHouse engine
 * produced (dimension aliases, `time_dimension`, `<agg>_<measure>`), so callers stay unchanged.
 */

type Granularity = z.infer<typeof granularities>;

const FIXED_BUCKET_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  "5m": 300_000,
  "10m": 600_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "2d": 172_800_000,
  "1w": 604_800_000,
};

const msOf = (v: unknown): number =>
  v instanceof Date ? v.getTime() : new Date(String(v)).getTime();

// Granularities ClickHouse formats as a bare date (YYYY-MM-DD); the rest as ISO seconds + Z.
const DATE_GRANULARITIES = new Set(["day", "week", "month", "1d", "2d", "1w"]);

/**
 * Format a bucket epoch to match the ClickHouse `time_dimension` string exactly:
 *  - day/week/month -> `YYYY-MM-DD`
 *  - minute/hour (and sub-hour windows) -> `YYYY-MM-DDTHH:mm:ssZ` (no milliseconds)
 */
const formatBucket = (ms: number, granularity?: string): string => {
  const iso = new Date(ms).toISOString();
  if (granularity && DATE_GRANULARITIES.has(granularity)) return iso.slice(0, 10);
  return iso.replace(/\.\d{3}Z$/, "Z");
};

/** Bucket start epochs across [from, to], matching date_trunc (week/month) / date_bin (fixed). */
const bucketGrid = (
  granularity: Exclude<Granularity, "auto">,
  fromMs: number,
  toMs: number,
): number[] => {
  const starts: number[] = [];
  if (granularity === "month") {
    const d = new Date(fromMs);
    let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (cur <= toMs) {
      starts.push(cur);
      const c = new Date(cur);
      cur = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
    }
    return starts;
  }
  if (granularity === "week") {
    // date_trunc('week') aligns to Monday 00:00 UTC
    const d = new Date(fromMs);
    const diffToMonday = (d.getUTCDay() + 6) % 7;
    let cur = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - diffToMonday,
    );
    while (cur <= toMs) {
      starts.push(cur);
      cur += FIXED_BUCKET_MS["1w"];
    }
    return starts;
  }
  const stepMs = FIXED_BUCKET_MS[granularity];
  const start = Math.floor(fromMs / stepMs) * stepMs;
  const end = Math.floor(toMs / stepMs) * stepMs;
  for (let b = start; b <= end; b += stepMs) starts.push(b);
  return starts;
};

/**
 * Single result-shaping pass ("middleware") applied to every output row so the GreptimeDB result
 * matches the ClickHouse row shape exactly:
 *  - integer-typed metrics (count/uniq/sum of integers) -> JSON string ("2"), as ClickHouse serializes
 *    UInt64/Int64; float-typed metrics (avg, costs, percentiles) -> JSON number (0.0028, trailing
 *    zeros trimmed), as ClickHouse serializes Float64;
 *  - `time_dimension` -> ClickHouse's per-granularity string (idempotent if already formatted).
 * Array dimensions (tags) are returned natively by GreptimeDB (the query builder groups them raw
 * instead of `min()`, which would emit a binary buffer) so they need no shaping here.
 */
const shapeRow = (
  row: Record<string, unknown>,
  metricColumns: Array<{ col: string; integer: boolean }>,
  hasTime: boolean,
  granularity?: string,
): Record<string, unknown> => {
  for (const { col, integer } of metricColumns) {
    if (col in row && row[col] != null) {
      row[col] = integer ? String(row[col]) : Number(row[col]);
    }
  }
  if (hasTime && row.time_dimension != null) {
    row.time_dimension = formatBucket(msOf(row.time_dimension), granularity);
  }
  return row;
};

/** Expand a per-entity raw JSON fetch into one row per (bucket, group dims, dynamic key). */
const expandByType = (
  rows: Array<Record<string, unknown>>,
  desc: NonNullable<PostProcess["byType"]>,
  granularity?: string,
): Array<Record<string, unknown>> => {
  const groups = new Map<
    string,
    { time: string | null; dims: unknown[]; sums: Record<string, number> }
  >();
  for (const row of rows) {
    const map = greptimeJson<Record<string, number>>(row[desc.jsonColumn], {});
    const time = desc.hasTime ? formatBucket(msOf(row.time_dimension), granularity) : null;
    const dims = desc.groupDimensionAliases.map((a) => row[a]);
    const key = JSON.stringify([time, ...dims]);
    const g = groups.get(key) ?? { time, dims, sums: {} };
    g.sums = mergeUsageOrCostMaps([g.sums, map]);
    groups.set(key, g);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const g of groups.values()) {
    for (const [k, v] of Object.entries(g.sums)) {
      const r: Record<string, unknown> = {};
      desc.groupDimensionAliases.forEach((a, i) => (r[a] = g.dims[i]));
      r[desc.keyDimensionAlias] = k;
      if (desc.hasTime) r.time_dimension = g.time;
      r[desc.valueMetricAlias] = v; // raw; shapeRow applies the int/float ClickHouse representation
      out.push(r);
    }
  }
  return out;
};

/** Emit a row for every (grid bucket × observed dimension tuple), defaulting absent metrics to 0. */
const gapFill = (
  rows: Array<Record<string, unknown>>,
  fill: NonNullable<PostProcess["timeFill"]>,
): Array<Record<string, unknown>> => {
  const dims = fill.dimensionAliases;
  const tuples = new Map<string, unknown[]>();
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const tup = dims.map((a) => row[a]);
    tuples.set(JSON.stringify(tup), tup);
    const bMs = new Date(String(row.time_dimension)).getTime();
    byKey.set(JSON.stringify([bMs, ...tup]), row);
  }
  if (tuples.size === 0) tuples.set("[]", []);

  const grid = bucketGrid(
    fill.granularity,
    new Date(fill.fromTimestamp).getTime(),
    new Date(fill.toTimestamp).getTime(),
  );

  const out: Array<Record<string, unknown>> = [];
  for (const b of grid) {
    const iso = formatBucket(b, fill.granularity);
    for (const tup of tuples.values()) {
      const existing = byKey.get(JSON.stringify([b, ...tup]));
      if (existing) {
        out.push(existing);
        continue;
      }
      const r: Record<string, unknown> = { time_dimension: iso };
      dims.forEach((a, i) => (r[a] = tup[i]));
      for (const m of fill.metricAliases) r[m] = 0; // raw; shapeRow applies the ClickHouse repr
      out.push(r);
    }
  }
  return out;
};

/**
 * Two-pass histogram. `rows` is the min/max probe ({lo, hi, c}); we compute the bin width app-side
 * and run the bucketed count query, then assemble `histogram_value` ([lower, upper, count][]) — the
 * same column the ClickHouse `histogram()` aggregation produced.
 */
async function runHistogram(
  probeRows: Array<Record<string, unknown>>,
  parameters: Record<string, unknown>,
  histogram: NonNullable<PostProcess["histogram"]>,
): Promise<Array<Record<string, unknown>>> {
  const probe = probeRows[0] ?? {};
  const lo = probe.lo == null ? null : Number(probe.lo);
  const hi = probe.hi == null ? null : Number(probe.hi);
  const total = Number(probe.c ?? 0);
  if (lo == null || hi == null || Number.isNaN(lo) || Number.isNaN(hi) || total === 0) {
    return [{ histogram_value: [] }];
  }
  const range = hi - lo;
  if (range <= 0) {
    // All values identical: a single bin holding every row.
    return [{ histogram_value: [[lo, hi, total]] }];
  }
  const bins = histogram.bins;
  const binWidth = range / bins;
  const bucketRows = await greptimeQuery<{ bucket: unknown; c: unknown }>({
    query: histogram.bucketSql,
    params: { ...parameters, hmin: lo, hbinwidth: binWidth, hmaxbucket: bins - 1 },
    readOnly: true,
  });
  const counts = new Map<number, number>();
  for (const r of bucketRows) counts.set(Number(r.bucket), Number(r.c));
  const histogram_value: Array<[number, number, number]> = [];
  for (let b = 0; b < bins; b++) {
    histogram_value.push([
      lo + b * binWidth,
      lo + (b + 1) * binWidth,
      counts.get(b) ?? 0,
    ]);
  }
  return [{ histogram_value }];
}

export async function executeGreptimeQuery(
  projectId: string,
  query: QueryType,
): Promise<Array<Record<string, unknown>>> {
  const {
    query: sql,
    parameters,
    postProcess,
  } = new GreptimeQueryBuilder().build(query, projectId);

  const rows = await greptimeQuery<Record<string, unknown>>({
    query: sql,
    params: parameters,
    readOnly: true,
  });

  if (postProcess.histogram) {
    return runHistogram(rows, parameters, postProcess.histogram);
  }

  // Granularity for ClickHouse-matching time_dimension formatting ("auto" resolves in timeFill).
  const granularity =
    postProcess.timeFill?.granularity ?? query.timeDimension?.granularity;

  // Expand/gap-fill operate on raw rows; the single shapeRow pass below applies the ClickHouse
  // output shape (int->string / float->number / time format) uniformly to the final result.
  let result = postProcess.byType
    ? expandByType(rows, postProcess.byType, granularity)
    : rows;
  if (postProcess.timeFill) {
    result = gapFill(result, postProcess.timeFill);
  }
  return result.map((r) =>
    shapeRow(r, postProcess.metricColumns, postProcess.hasTimeDimension, granularity),
  );
}
