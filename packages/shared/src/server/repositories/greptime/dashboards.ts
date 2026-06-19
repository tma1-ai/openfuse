import { type FilterState } from "../../../types";
import { greptimeQuery } from "../../greptime/client";
import { createGreptimeFilterFromFilterState } from "../../greptime/sql/factory";
import {
  FilterList,
  type DateTimeFilter,
} from "../../greptime/sql/greptime-filter";
import { type GreptimeColumnMappings } from "../../greptime/sql/columnMappings";
import { greptimeString } from "../../greptime/sql/rowContract";
import { quoteIdent } from "../../greptime/schemaUtils";
import { greptimeTsParam, notDeleted } from "./queryHelpers";

// OBSERVATIONS_TO_TRACE_INTERVAL = "INTERVAL 2 DAY"; SCORE_TO_TRACE_OBSERVATIONS_INTERVAL = "INTERVAL 1 HOUR".
const OBSERVATIONS_TO_TRACE_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const SCORE_TO_TRACE_OBSERVATIONS_INTERVAL_MS = 60 * 60 * 1000;

/**
 * GreptimeDB dashboard rollup reads (04-read-path.md, P2). Replaces the ClickHouse dashboard repo:
 *   - getScoreAggregate: scores FINAL [JOIN traces FINAL] -> plain GROUP BY on the merged projection.
 *   - getObservation{Cost,Usage}ByTypeByTime: GreptimeDB SQL cannot enumerate JSON map keys, so the
 *     by-type breakdown reads two sources and merges them. The standard input/output/total keys come
 *     straight from the observations usage_details/cost_details JSON columns (covers all history,
 *     unchanged from before). Any custom/dynamic keys come from the pre-exploded
 *     observations_usage_cost EAV table -- populated for new writes, and for history once a
 *     reconciliation backfill runs. The writer only fans custom keys into the EAV table; the NOT IN
 *     guard on the standard keys is kept defensive (older rows written before that change still
 *     carried them). `toStartOfInterval ... WITH FILL` becomes `date_bin` + app-side gap fill.
 */

// Standard usage/cost keys read straight from the JSON columns so they never depend on the EAV
// backfill; every other key is a custom/dynamic key sourced from observations_usage_cost.
const KNOWN_DETAIL_KEYS = ["input", "output", "total"] as const;

// Greptime dashboard filter mapping (mirrors `tableDefinitions/mapDashboards.ts`). Each column carries
// the conventional alias of its table in the dashboard queries (traces=t, observations=o, scores=s).
// `toolNames` / `calledToolNames` are intentionally absent (JSON-key membership is not expressible);
// filtering by them throws loudly rather than mis-filtering.
const dashboardGreptimeColumnDefinitions: GreptimeColumnMappings = [
  { uiTableName: "Trace Name", uiTableId: "traceName", greptimeTableName: "traces", greptimeSelect: "name", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Tags", uiTableId: "traceTags", greptimeTableName: "traces", greptimeSelect: "tags", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Timestamp", uiTableId: "timestamp", greptimeTableName: "traces", greptimeSelect: "timestamp", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Score Name", uiTableId: "scoreName", greptimeTableName: "scores", greptimeSelect: "name", queryPrefix: "s" }, // prettier-ignore
  { uiTableName: "Score Timestamp", uiTableId: "scoreTimestamp", greptimeTableName: "scores", greptimeSelect: "timestamp", queryPrefix: "s" }, // prettier-ignore
  { uiTableName: "Score Source", uiTableId: "scoreSource", greptimeTableName: "scores", greptimeSelect: "source", queryPrefix: "s" }, // prettier-ignore
  { uiTableName: "Scores Data Type", uiTableId: "scoreDataType", greptimeTableName: "scores", greptimeSelect: "data_type", queryPrefix: "s" }, // prettier-ignore
  { uiTableName: "value", uiTableId: "value", greptimeTableName: "scores", greptimeSelect: "value", queryPrefix: "s" }, // prettier-ignore
  { uiTableName: "Start Time", uiTableId: "startTime", greptimeTableName: "observations", greptimeSelect: "start_time", queryPrefix: "o" }, // prettier-ignore
  { uiTableName: "End Time", uiTableId: "endTime", greptimeTableName: "observations", greptimeSelect: "end_time", queryPrefix: "o" }, // prettier-ignore
  { uiTableName: "Type", uiTableId: "type", greptimeTableName: "observations", greptimeSelect: "type", queryPrefix: "o" }, // prettier-ignore
  { uiTableName: "Level", uiTableId: "level", greptimeTableName: "observations", greptimeSelect: "level", queryPrefix: "o" }, // prettier-ignore
  { uiTableName: "User", uiTableId: "userId", greptimeTableName: "traces", greptimeSelect: "user_id", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Release", uiTableId: "release", greptimeTableName: "traces", greptimeSelect: "release", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Version", uiTableId: "version", greptimeTableName: "traces", greptimeSelect: "version", queryPrefix: "t" }, // prettier-ignore
  { uiTableName: "Model", uiTableId: "model", greptimeTableName: "observations", greptimeSelect: "provided_model_name", queryPrefix: "o" }, // prettier-ignore
  { uiTableName: "Environment", uiTableId: "environment", greptimeTableName: "traces", greptimeSelect: "environment", queryPrefix: "t" }, // prettier-ignore
];

const splitEnvFilter = (
  filter: FilterState,
): { envFilter: FilterState; rest: FilterState } => ({
  envFilter: filter.filter((f) => f.column === "environment"),
  rest: filter.filter((f) => f.column !== "environment"),
});

// Environment exists on every projection; bind it to the primary table's alias of each query.
const envFilterList = (envFilter: FilterState, prefix: string): FilterList =>
  new FilterList(
    createGreptimeFilterFromFilterState(envFilter, [
      {
        uiTableName: "Environment",
        uiTableId: "environment",
        greptimeTableName: "traces",
        greptimeSelect: "environment",
        queryPrefix: prefix,
      },
    ]),
  );

// ---------------------------------------------------------------------------
// getScoreAggregate
// ---------------------------------------------------------------------------

export const getScoreAggregateGreptime = async (
  projectId: string,
  filter: FilterState,
): Promise<
  Array<{
    name: string;
    count: string;
    avg_value: string;
    source: string;
    data_type: string;
  }>
> => {
  const { envFilter, rest } = splitEnvFilter(filter);
  const env = envFilterList(envFilter, "s").apply();
  const restList = new FilterList(
    createGreptimeFilterFromFilterState(
      rest,
      dashboardGreptimeColumnDefinitions,
    ),
  );
  const restRes = restList.apply();

  const hasTraceFilter = restList.some((f) => f.table === "traces");
  const timeFilter = restList.find(
    (f) =>
      f.field === "timestamp" && (f.operator === ">=" || f.operator === ">"),
  ) as DateTimeFilter | undefined;

  const useLookback = Boolean(timeFilter && hasTraceFilter);
  const params: Record<string, unknown> = {
    projectId,
    ...restRes.params,
    ...env.params,
  };
  if (useLookback && timeFilter) {
    params.tracesTimestamp = greptimeTsParam(
      new Date(
        timeFilter.value.getTime() - SCORE_TO_TRACE_OBSERVATIONS_INTERVAL_MS,
      ),
    );
  }

  const rows = await greptimeQuery<{
    name: string;
    count: string | number;
    avg_value: string | number | null;
    source: string;
    data_type: string;
  }>({
    query: `
      SELECT s.name AS name, count(*) AS count, avg(s.value) AS avg_value,
        s.source AS source, s.data_type AS data_type
      FROM scores s
      ${hasTraceFilter ? "JOIN traces t ON t.id = s.trace_id AND t.project_id = s.project_id AND " + notDeleted("t") : ""}
      WHERE s.project_id = :projectId AND ${notDeleted("s")}
        ${restRes.query ? `AND ${restRes.query}` : ""}
        ${env.query ? `AND ${env.query}` : ""}
        ${useLookback ? "AND t.timestamp >= :tracesTimestamp" : ""}
      GROUP BY s.name, s.source, s.data_type
      ORDER BY count(*) DESC`,
    params,
    readOnly: true,
  });

  return rows.map((r) => ({
    name: greptimeString(r.name) ?? "",
    count: String(r.count ?? 0),
    avg_value: String(r.avg_value ?? 0),
    source: greptimeString(r.source) ?? "",
    data_type: greptimeString(r.data_type) ?? "",
  }));
};

// ---------------------------------------------------------------------------
// cost / usage by type by time (known-key allowlist + app-side gap fill)
// ---------------------------------------------------------------------------

type TypeByTimeRow = { intervalStart: Date; key: string; sum: number };

const getObservationDetailByTypeByTime = async (opts: {
  projectId: string;
  filter: FilterState;
  jsonColumn: "cost_details" | "usage_details";
  fromTime: number;
  toTime: number;
  bucketSizeSeconds: number;
}): Promise<TypeByTimeRow[]> => {
  const { projectId, filter, jsonColumn, fromTime, toTime, bucketSizeSeconds } =
    opts;
  const { envFilter, rest } = splitEnvFilter(filter);
  const env = envFilterList(envFilter, "o").apply();
  const restList = new FilterList(
    createGreptimeFilterFromFilterState(
      rest,
      dashboardGreptimeColumnDefinitions,
    ),
  );
  const restRes = restList.apply();

  const hasTraceFilter = restList.some((f) => f.table === "traces");
  // CH derived the trace lookback from an observation start_time lower bound, only when a trace
  // filter forced the join.
  const obsStartLowerBound = restList.find(
    (f) =>
      f.table === "observations" &&
      f.field.includes("start_time") &&
      (f.operator === ">=" || f.operator === ">"),
  ) as DateTimeFilter | undefined;
  const useLookback = Boolean(hasTraceFilter && obsStartLowerBound);

  const params: Record<string, unknown> = {
    projectId,
    winFrom: greptimeTsParam(new Date(fromTime)),
    winTo: greptimeTsParam(new Date(toTime)),
    ...restRes.params,
    ...env.params,
  };
  if (useLookback && obsStartLowerBound) {
    params.traceTimestamp = greptimeTsParam(
      new Date(
        obsStartLowerBound.value.getTime() - OBSERVATIONS_TO_TRACE_INTERVAL_MS,
      ),
    );
  }

  // 'usage_details' / 'cost_details' -> the observations_usage_cost `kind` discriminator + alias.
  const kind = jsonColumn === "cost_details" ? "cost" : "usage";
  params.kind = kind;

  const traceJoin = hasTraceFilter
    ? `LEFT JOIN traces t ON o.trace_id = t.id AND o.project_id = t.project_id AND ${notDeleted("t")}`
    : "";
  const restClause = restRes.query ? `AND ${restRes.query}` : "";
  const envClause = env.query ? `AND ${env.query}` : "";
  const lookbackClause = useLookback
    ? "AND t.timestamp >= :traceTimestamp"
    : "";

  const byBucket = new Map<number, Record<string, number>>();
  const allKeys = new Set<string>();
  const setSum = (bucketMsKey: number, key: string, value: number) => {
    allKeys.add(key);
    const perKey = byBucket.get(bucketMsKey) ?? {};
    perKey[key] = value;
    byBucket.set(bucketMsKey, perKey);
  };
  const bucketOf = (raw: Date | string | undefined): number =>
    (raw instanceof Date ? raw : new Date(String(raw))).getTime();

  // Q1: standard input/output/total read straight from the observations JSON columns. Covers every
  // observation (including history that has no EAV rows yet), so the canonical series never regress.
  const knownSums = KNOWN_DETAIL_KEYS.map(
    (k) =>
      `sum(coalesce(json_get_float(o.${jsonColumn}, '${k}'), 0)) AS ${kind}_${k}`,
  ).join(",\n        ");
  // Q1 and Q2 are independent read-only aggregations; run them concurrently so the by-type read is
  // one round-trip wide, not two. (mysql2 named-placeholder substitution ignores Q1's unused :kind.)
  const [knownRows, customRows] = await Promise.all([
    greptimeQuery<Record<string, unknown>>({
      query: `
      SELECT date_bin(INTERVAL '${bucketSizeSeconds}' second, o.start_time) AS bucket,
        ${knownSums}
      FROM observations o
      ${traceJoin}
      WHERE o.project_id = :projectId AND ${notDeleted("o")}
        AND o.start_time >= :winFrom AND o.start_time < :winTo
        ${restClause}
        ${envClause}
        ${lookbackClause}
      GROUP BY bucket
      ORDER BY bucket ASC`,
      params,
      readOnly: true,
    }),
    // Q2: custom (non-standard) keys from the pre-exploded EAV table -- GROUP BY key sums each
    // dynamic key server-side. The writer no longer fans standard keys into the EAV table, but the
    // NOT IN guard stays defensive so any older rows that still carry them are not double-counted
    // against Q1 (the authoritative JSON map). The EAV row's `timestamp` carries the observation
    // start_time; observations is joined as `o` so the compiled filter predicates compose unchanged.
    greptimeQuery<{
      bucket: Date | string;
      detail_key: string;
      sum: string | number | null;
    }>({
      query: `
      SELECT date_bin(INTERVAL '${bucketSizeSeconds}' second, uc.${quoteIdent("timestamp")}) AS bucket,
        uc.${quoteIdent("key")} AS detail_key,
        sum(uc.${quoteIdent("value")}) AS sum
      FROM observations_usage_cost uc
      JOIN observations o ON uc.entity_id = o.id AND uc.project_id = o.project_id AND ${notDeleted("o")}
      ${traceJoin}
      WHERE uc.${quoteIdent("kind")} = :kind
        AND uc.project_id = :projectId AND ${notDeleted("uc")}
        AND uc.${quoteIdent("timestamp")} >= :winFrom AND uc.${quoteIdent("timestamp")} < :winTo
        AND uc.${quoteIdent("key")} NOT IN ('input', 'output', 'total')
        ${restClause}
        ${envClause}
        ${lookbackClause}
      GROUP BY bucket, uc.${quoteIdent("key")}
      ORDER BY bucket ASC`,
      params,
      readOnly: true,
    }),
  ]);
  for (const row of knownRows) {
    const b = bucketOf(row.bucket as Date | string);
    for (const k of KNOWN_DETAIL_KEYS)
      setSum(b, k, Number(row[`${kind}_${k}`] ?? 0));
  }
  for (const row of customRows) {
    const key = greptimeString(row.detail_key);
    if (key == null) continue;
    setSum(bucketOf(row.bucket), key, Number(row.sum ?? 0));
  }

  // Keep only keys that carry a nonzero sum somewhere (mirror CH's "types present in data").
  const keptKeys = Array.from(allKeys).filter((k) =>
    Array.from(byBucket.values()).some((m) => (m[k] ?? 0) !== 0),
  );

  const bucketMs = bucketSizeSeconds * 1000;
  const alignedFrom = Math.floor(fromTime / bucketMs) * bucketMs;
  const alignedTo = Math.floor(toTime / bucketMs) * bucketMs;

  const result: TypeByTimeRow[] = [];
  for (let b = alignedFrom; b <= alignedTo; b += bucketMs) {
    const perKey = byBucket.get(b);
    for (const key of keptKeys) {
      result.push({
        intervalStart: new Date(b),
        key,
        sum: perKey?.[key] ?? 0,
      });
    }
  }
  return result;
};

export const getObservationCostByTypeByTimeGreptime = (opts: {
  projectId: string;
  filter: FilterState;
  fromTime: number;
  toTime: number;
  bucketSizeSeconds: number;
}): Promise<TypeByTimeRow[]> =>
  getObservationDetailByTypeByTime({ ...opts, jsonColumn: "cost_details" });

export const getObservationUsageByTypeByTimeGreptime = (opts: {
  projectId: string;
  filter: FilterState;
  fromTime: number;
  toTime: number;
  bucketSizeSeconds: number;
}): Promise<TypeByTimeRow[]> =>
  getObservationDetailByTypeByTime({ ...opts, jsonColumn: "usage_details" });
