import { type z } from "zod";
import {
  type QueryType,
  type ViewDeclarationType,
  type granularities,
  type metricAggregations,
  query as queryModel,
  getValidAggregationsForMeasureType,
} from "../types";
import {
  BYTYPE_SQL,
  assertGreptimeSupportedField,
  getGreptimeViewDeclaration,
} from "../greptimeDataModel";
import { InvalidRequestError } from "../../../errors";
import { createGreptimeFilterFromFilterState } from "../../../server/greptime/sql/factory";
import {
  FilterList,
  greptimeTimestampLiteral,
} from "../../../server/greptime/sql/greptime-filter";
import { type GreptimeColumnMapping } from "../../../server/greptime/sql/columnMappings";
import {
  greptimeTimeBucket,
  resolveAutoGranularity,
} from "../../../server/greptime/sql/time-bucket";
import {
  greptimeQuantile,
  PERCENTILE_P,
} from "../../../server/greptime/sql/quantile";
import { selectJsonColumn } from "../../../server/greptime/sql/rowContract";
import { quoteIdent } from "../../../server/greptime/schemaUtils";
import { notDeleted } from "../../../server/repositories/greptime/queryHelpers";

/**
 * GreptimeDB dashboard query builder (04-read-path.md, P3). Consumes the same `QueryType` as the
 * ClickHouse engine but emits GreptimeDB SQL (`:named` params) over the merged projection via
 * `greptimeDataModel`. See that file for the measure/dimension SQL contract.
 *
 * Levels:
 *  - SINGLE-level when no applied measure is relation-backed (the base row IS the entity, or only
 *    1:1 parent dimensions are joined): one SELECT applies the user aggregation directly.
 *  - TWO-level when any applied measure joins a 1:N child relation (observations/scores under a
 *    trace, scores under an observation): inner SELECT groups the join per base entity (relation
 *    measures = their inner aggregate, leaf measures / dims collapsed with `min()` since they are
 *    invariant per entity); outer SELECT applies the user aggregation across entities.
 *
 * Two query shapes need app-side post-processing in `greptimeQueryExecutor` (returned in
 * `postProcess`): dynamic-key by-type (costByType/usageByType) and time-series gap-fill.
 */

const PREFIX_TABLE: Record<string, string> = {
  t: "traces",
  o: "observations",
  s: "scores",
  sc: "scores",
  dri: "dataset_run_items",
};

// Relation time-window lookbacks (absolute lower bound on the joined relation's time dimension),
// keyed by relation table name. For CHILD joins (traces -> observations/scores) the child can start
// slightly after the parent. For PARENT joins (observations/scores -> traces) the parent trace
// starts BEFORE the child, by up to the obs↔trace interval; without a lookback the INNER join would
// drop in-window children whose parent trace started before `fromTimestamp` (silent under-count,
// e.g. a userId-filtered observations widget). 2 DAY covers the obs↔trace interval in both cases.
const RELATION_LOOKBACK_MS: Record<string, number> = {
  observations: 2 * 24 * 60 * 60 * 1000, // OBSERVATIONS_TO_TRACE_INTERVAL = 2 DAY
  traces: 2 * 24 * 60 * 60 * 1000, // parent trace of in-window observations/scores
  scores: 60 * 60 * 1000, // TRACE_TO_SCORES_INTERVAL = 1 HOUR
};

type Granularity = z.infer<typeof granularities>;
type Aggregation = z.infer<typeof metricAggregations>;

export type PostProcess = {
  // Output metric columns (`<agg>_<measure>` or `count`). Their values come back from mysql2 as
  // strings for DECIMAL/BIGINT; the executor coerces them to numbers to match the ClickHouse shape.
  // Output metric columns + whether ClickHouse serializes each as a string (integer) or number.
  metricColumns: Array<{ col: string; integer: boolean }>;
  // Whether the query produced a `time_dimension` column (coerced to an ISO string on output).
  hasTimeDimension: boolean;
  // Gap-fill descriptor (present when the query buckets by time).
  timeFill?: {
    granularity: Exclude<Granularity, "auto">;
    fromTimestamp: string;
    toTimestamp: string;
    dimensionAliases: string[];
    metricAliases: string[];
  };
  // Dynamic by-type expansion descriptor (present for costByType/usageByType queries). When set, the
  // built query is a per-entity raw fetch (no aggregation); the executor expands the JSON map.
  byType?: {
    jsonColumn: "usage_details" | "cost_details";
    keyDimensionAlias: string; // costType | usageType
    valueMetricAlias: string; // sum_costByType | sum_usageByType
    aggregation: Aggregation;
    groupDimensionAliases: string[]; // non-by-type dimensions
    hasTime: boolean;
  };
  // Histogram descriptor. GreptimeDB has no server-side `histogram()`, so the built `query` is a
  // min/max probe (one row: `lo`, `hi`, `c`); the executor then runs `bucketSql` with the computed
  // bin width to count rows per bucket and assembles `histogram_value` ([lower, upper, count][]),
  // matching the ClickHouse histogram output column.
  histogram?: {
    bins: number;
    bucketSql: string;
  };
};

export type GreptimeBuildResult = {
  query: string;
  parameters: Record<string, unknown>;
  postProcess: PostProcess;
};

type AppliedDimension = {
  field: string;
  alias: string;
  sql: string;
  relationTable?: string;
  isByType: boolean;
  byTypeJson?: "usage_details" | "cost_details";
  // Array-typed dimension (e.g. tags `string[]`). `min()` over an array column returns GreptimeDB's
  // binary array encoding instead of JSON text, so the two-level inner query must group by it raw.
  isArray: boolean;
};

type AppliedMeasure = {
  measure: string;
  alias: string;
  sql: string;
  aggregation: Aggregation;
  relationTable?: string;
  isByType: boolean;
  requiresDimension?: string;
  /** Declared measure type ("integer" | "decimal" | "number" | ...) — drives int-vs-float output. */
  type?: string;
};

const FLOAT_RESULT_AGGS = new Set([
  "avg",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
]);

/**
 * Whether the aggregation's result is integer-typed (ClickHouse serializes UInt64/Int64 aggregates as
 * JSON strings) vs float-typed (serialized as JSON numbers). count/uniq are always UInt64; avg and
 * percentiles are always Float64; sum/min/max preserve the measure's declared type.
 */
const isIntegerResult = (aggregation: string, measureType?: string): boolean => {
  if (aggregation === "count" || aggregation === "uniq") return true;
  if (FLOAT_RESULT_AGGS.has(aggregation)) return false;
  return measureType === "integer";
};

/** Output metric column descriptor: alias + whether ClickHouse serializes it as a string (integer). */
const metricColumnDescriptor = (m: AppliedMeasure): { col: string; integer: boolean } => ({
  col: `${m.aggregation}_${m.alias}`,
  integer: isIntegerResult(m.aggregation, m.type),
});

type QueryChartConfig = NonNullable<QueryType["chartConfig"]>;

const getChartConfig = (query: QueryType): QueryChartConfig | undefined =>
  ((query as unknown as { config?: QueryChartConfig }).config ??
    query.chartConfig) as QueryChartConfig | undefined;

const baseAlias = (view: ViewDeclarationType): string => {
  switch (view.baseCte) {
    case "traces":
      return "t";
    case "observations":
      return "o";
    case "scores":
      return "s";
    default:
      return view.baseCte;
  }
};

const translateAggregation = (agg: Aggregation, expr: string): string => {
  switch (agg) {
    case "sum":
      return `sum(${expr})`;
    case "avg":
      return `avg(${expr})`;
    case "max":
      return `max(${expr})`;
    case "min":
      return `min(${expr})`;
    case "count":
      return `count(*)`;
    case "uniq":
      return `count(distinct ${expr})`;
    case "p50":
    case "p75":
    case "p90":
    case "p95":
    case "p99":
      return greptimeQuantile(PERCENTILE_P[agg], expr);
    case "histogram":
      throw new InvalidRequestError(
        "histogram aggregation is not yet supported on GreptimeDB dashboards (P3 follow-up).",
      );
    default: {
      const exhaustive: never = agg;
      throw new InvalidRequestError(`Invalid aggregation: ${exhaustive}`);
    }
  }
};

/** Build the per-view filter column mapping from the GreptimeDB view declaration. */
const buildFilterMappings = (
  view: ViewDeclarationType,
): GreptimeColumnMapping[] => {
  const mappings: GreptimeColumnMapping[] = [];
  const base = baseAlias(view);
  const plainCol = /^(\w+)\.(\w+)$/;

  for (const [field, dim] of Object.entries(view.dimensions)) {
    if (dim.sql === BYTYPE_SQL) continue;
    const m = plainCol.exec(dim.sql);
    if (!m) continue; // expression dimensions (date_format(...)) are not directly filterable
    const [, prefix, col] = m;
    mappings.push({
      uiTableName: dim.alias ?? field,
      uiTableId: dim.alias ?? field,
      greptimeTableName: PREFIX_TABLE[prefix] ?? view.baseCte,
      greptimeSelect: col,
      queryPrefix: prefix,
    });
    // Fallback alias: a `scoreName` filter resolves to the `name` column (LFE-4838, mirrors the
    // ClickHouse builder's *Name -> name fallback for filters).
    if ((dim.alias ?? field) === "name") {
      mappings.push({
        uiTableName: "scoreName",
        uiTableId: "scoreName",
        greptimeTableName: PREFIX_TABLE[prefix] ?? view.baseCte,
        greptimeSelect: col,
        queryPrefix: prefix,
      });
    }
  }

  // time dimension + metadata (EAV) on the base table
  mappings.push({
    uiTableName: view.timeDimension,
    uiTableId: view.timeDimension,
    greptimeTableName: view.baseCte,
    greptimeSelect: view.timeDimension,
    queryPrefix: base,
  });
  mappings.push({
    uiTableName: "metadata",
    uiTableId: "metadata",
    greptimeTableName: view.baseCte,
    greptimeSelect: "metadata",
    queryPrefix: base,
  });
  // segment columns (e.g. data_type) are applied as constant filters via the factory
  for (const segment of view.segments) {
    if (mappings.some((m) => m.uiTableId === segment.column)) continue;
    mappings.push({
      uiTableName: segment.column,
      uiTableId: segment.column,
      greptimeTableName: view.baseCte,
      greptimeSelect: segment.column,
      queryPrefix: base,
    });
  }
  return mappings;
};

const resolveDimension = (
  viewName: string,
  view: ViewDeclarationType,
  field: string,
  aliasOverride?: string,
): AppliedDimension => {
  assertGreptimeSupportedField(field);
  // Fallback: scoreName/traceName etc. -> "name" dimension (LFE-4838, mirrors the ClickHouse builder).
  const dim =
    view.dimensions[field] ??
    (field.endsWith("Name") && "name" in view.dimensions
      ? view.dimensions["name"]
      : undefined);
  if (!dim) {
    throw new InvalidRequestError(
      `Invalid dimension '${field}' for view '${viewName}'. Must be one of ${Object.keys(view.dimensions).join(", ")}`,
    );
  }
  const isByType = dim.sql === BYTYPE_SQL;
  return {
    field,
    alias: aliasOverride ?? dim.alias ?? field,
    sql: dim.sql,
    relationTable: dim.relationTable,
    isByType,
    isArray: (dim.type ?? "").endsWith("[]"),
    byTypeJson: isByType
      ? dim.pairExpand?.valuesSql.includes("cost_details")
        ? "cost_details"
        : "usage_details"
      : undefined,
  };
};

const resolveDimensions = (
  query: QueryType,
  viewName: string,
  view: ViewDeclarationType,
): AppliedDimension[] =>
  query.dimensions.map((d) => resolveDimension(viewName, view, d.field));

const resolveMeasures = (
  query: QueryType,
  view: ViewDeclarationType,
): AppliedMeasure[] =>
  query.metrics.map((metric) => {
    assertGreptimeSupportedField(metric.measure);
    const measure = view.measures[metric.measure];
    if (!measure) {
      throw new InvalidRequestError(
        `Invalid measure '${metric.measure}' for view '${query.view}'. Must be one of ${Object.keys(view.measures).join(", ")}`,
      );
    }
    const validAggs = getValidAggregationsForMeasureType(measure.type);
    if (!validAggs.includes(metric.aggregation)) {
      throw new InvalidRequestError(
        `Aggregation '${metric.aggregation}' is not valid for measure '${metric.measure}' (type ${measure.type}). Valid: ${validAggs.join(", ")}`,
      );
    }
    return {
      measure: metric.measure,
      alias: measure.alias ?? metric.measure,
      sql: measure.sql,
      aggregation: metric.aggregation,
      relationTable: measure.relationTable,
      isByType: measure.sql === BYTYPE_SQL,
      requiresDimension: measure.requiresDimension,
      type: measure.type,
    };
  });

const timeBucketExpr = (
  query: QueryType,
  view: ViewDeclarationType,
): { expr: string; granularity: Exclude<Granularity, "auto"> } | null => {
  if (!query.timeDimension) return null;
  const granularity =
    query.timeDimension.granularity === "auto"
      ? resolveAutoGranularity(
          new Date(query.fromTimestamp).getTime(),
          new Date(query.toTimestamp).getTime(),
        )
      : query.timeDimension.granularity;
  const colRef = `${baseAlias(view)}.${view.timeDimension}`;
  return { expr: greptimeTimeBucket(granularity, colRef), granularity };
};

export class GreptimeQueryBuilder {
  build(query: QueryType, projectId: string): GreptimeBuildResult {
    const parsed = queryModel.safeParse(query);
    if (!parsed.success) {
      throw new InvalidRequestError(
        `Invalid query: ${JSON.stringify(parsed.error.issues)}`,
      );
    }

    const view = getGreptimeViewDeclaration(query.view);
    const dims = resolveDimensions(query, query.view, view);
    if (query.entityDimension) {
      const entityDimension = resolveDimension(
        query.view,
        view,
        query.entityDimension.field,
        "entity_dimension",
      );
      if (entityDimension.isByType) {
        throw new InvalidRequestError(
          `Invalid entity dimension: ${query.entityDimension.field}. Entity dimensions must be scalar view dimensions.`,
        );
      }
      dims.unshift(entityDimension);
    }
    const measures = resolveMeasures(query, view);

    // Auto-include the by-type key dimension (costType/usageType) required by costByType/usageByType
    // when the widget requests the metric alone — mirrors the ClickHouse builder's requiresDimension
    // auto-injection. Without it the dynamic-key fetch would have no key column and the query would
    // be rejected even though it is a supported widget shape.
    for (const m of measures) {
      if (
        m.requiresDimension &&
        !dims.some((d) => d.alias === m.requiresDimension)
      ) {
        dims.push(resolveDimension(query.view, view, m.requiresDimension));
      }
    }

    const histogramMetric = measures.find((m) => m.aggregation === "histogram");
    if (histogramMetric) {
      return this.buildHistogram(query, projectId, view, dims, measures);
    }

    const bucket = timeBucketExpr(query, view);

    const byTypeMeasure = measures.find((m) => m.isByType);
    if (byTypeMeasure) {
      return this.buildByType(query, projectId, view, dims, measures, bucket);
    }

    return this.buildAggregate(query, projectId, view, dims, measures, bucket);
  }

  // -------------------------------------------------------------------------
  // histogram (min/max probe + app-side bucketed count, executor runs both)
  // -------------------------------------------------------------------------
  private buildHistogram(
    query: QueryType,
    projectId: string,
    view: ViewDeclarationType,
    dims: AppliedDimension[],
    measures: AppliedMeasure[],
  ): GreptimeBuildResult {
    // Scope: a single base numeric measure, no dimensions, no time bucket (matches scoreHistogram /
    // the HISTOGRAM widget). Anything wider would need a per-group histogram shape we do not emit.
    const metric = measures[0];
    if (measures.length !== 1 || metric.aggregation !== "histogram") {
      throw new InvalidRequestError(
        "histogram requires exactly one metric with the histogram aggregation.",
      );
    }
    if (dims.length > 0 || query.timeDimension) {
      throw new InvalidRequestError(
        "histogram does not support dimensions or a time dimension on GreptimeDB.",
      );
    }
    if (metric.relationTable || metric.isByType || metric.sql === "*") {
      throw new InvalidRequestError(
        "histogram is only supported for a base (non-relation) numeric measure on GreptimeDB.",
      );
    }

    const bins = Math.max(1, Math.floor(getChartConfig(query)?.bins ?? 10));
    const valueExpr = metric.sql;
    const relations = this.collectRelations(query, view, [], measures);
    const { fromClause, parameters } = this.buildFromAndWhere(
      query,
      projectId,
      view,
      relations,
    );

    const nonNullValue = `(${valueExpr}) IS NOT NULL`;
    const minMaxSql = `SELECT min(${valueExpr}) AS lo, max(${valueExpr}) AS hi, count(*) AS c ${fromClause} AND ${nonNullValue}`;
    // `:hmin` / `:hbinwidth` / `:hmaxbucket` are supplied by the executor after the min/max probe.
    const bucketSql =
      `SELECT CAST(least(floor((${valueExpr} - :hmin) / :hbinwidth), :hmaxbucket) AS BIGINT) AS bucket, count(*) AS c ` +
      `${fromClause} AND ${nonNullValue} GROUP BY bucket`;

    return {
      query: minMaxSql,
      parameters,
      postProcess: {
        metricColumns: [] as Array<{ col: string; integer: boolean }>,
        hasTimeDimension: false,
        histogram: { bins, bucketSql },
      },
    };
  }

  // -------------------------------------------------------------------------
  // standard filters + relation joins (shared)
  // -------------------------------------------------------------------------
  private buildFromAndWhere(
    query: QueryType,
    projectId: string,
    view: ViewDeclarationType,
    relationTables: Set<string>,
  ): { fromClause: string; parameters: Record<string, unknown> } {
    const base = baseAlias(view);
    const mappings = buildFilterMappings(view);
    const parameters: Record<string, unknown> = {};

    // user filters + standard project_id / time-range / segment filters via the factory
    const standardFilters = [
      {
        column: "project_id",
        type: "string" as const,
        operator: "=" as const,
        value: projectId,
      },
      {
        column: view.timeDimension,
        type: "datetime" as const,
        operator: ">=" as const,
        value: new Date(query.fromTimestamp),
      },
      {
        column: view.timeDimension,
        type: "datetime" as const,
        operator: "<=" as const,
        value: new Date(query.toTimestamp),
      },
    ];
    const projectIdMapping: GreptimeColumnMapping = {
      uiTableName: "project_id",
      uiTableId: "project_id",
      greptimeTableName: view.baseCte,
      greptimeSelect: "project_id",
      queryPrefix: base,
    };

    const filterList = new FilterList(
      createGreptimeFilterFromFilterState(
        [...standardFilters, ...view.segments, ...query.filters],
        [...mappings, projectIdMapping],
      ),
    );
    const applied = filterList.apply();
    Object.assign(parameters, applied.params);

    let fromClause = `FROM ${quoteIdent(view.baseCte)} AS ${base}`;

    for (const rel of relationTables) {
      const relation = view.tableRelations[rel];
      if (!relation) {
        throw new InvalidRequestError(`Invalid relation table: ${rel}`);
      }
      const relAlias =
        rel === "scores" ? "sc" : baseAliasForTable(relation.name);
      // A `baseQuery` relation joins an inline subquery (the experiment relation joins a DISTINCT
      // projection of dataset_run_items) — the subquery already filters `is_deleted`, so no extra
      // notDeleted, and it carries no comparable time column, so `skipTimeBound` omits the window.
      const joinSource = relation.baseQuery
        ? `(${relation.baseQuery})`
        : quoteIdent(relation.name);
      fromClause += `\nINNER JOIN ${joinSource} AS ${relAlias} ${relation.joinConditionSql}`;
      if (!relation.baseQuery) {
        fromClause += ` AND ${notDeleted(relAlias)}`;
      }
      if (!relation.skipTimeBound) {
        // relation time-range lower bound (lookback) keeps the child scan bounded
        const lookback = RELATION_LOOKBACK_MS[relation.name] ?? 0;
        const from = greptimeTimestampLiteral(
          new Date(new Date(query.fromTimestamp).getTime() - lookback),
        );
        const to = greptimeTimestampLiteral(new Date(query.toTimestamp));
        fromClause +=
          ` AND ${relAlias}.${relation.timeDimension} >= '${from}'` +
          ` AND ${relAlias}.${relation.timeDimension} <= '${to}'`;
      }
    }

    fromClause += ` WHERE ${applied.query} AND ${notDeleted(base)}`;
    return { fromClause, parameters };
  }

  private collectRelations(
    query: QueryType,
    view: ViewDeclarationType,
    dims: AppliedDimension[],
    measures: AppliedMeasure[],
  ): Set<string> {
    const set = new Set<string>();
    for (const d of dims) if (d.relationTable) set.add(d.relationTable);
    for (const m of measures) if (m.relationTable) set.add(m.relationTable);
    for (const filter of query.filters) {
      const dimension = view.dimensions[filter.column];
      if (dimension?.relationTable) set.add(dimension.relationTable);
    }
    return set;
  }

  // -------------------------------------------------------------------------
  // aggregate query (single- or two-level)
  // -------------------------------------------------------------------------
  private buildAggregate(
    query: QueryType,
    projectId: string,
    view: ViewDeclarationType,
    dims: AppliedDimension[],
    measures: AppliedMeasure[],
    bucket: { expr: string; granularity: Exclude<Granularity, "auto"> } | null,
  ): GreptimeBuildResult {
    const base = baseAlias(view);
    const relations = this.collectRelations(query, view, dims, measures);
    const needsTwoLevel = measures.some((m) => m.relationTable);
    const { fromClause, parameters } = this.buildFromAndWhere(
      query,
      projectId,
      view,
      relations,
    );

    const dimAliases = dims.map((d) => d.alias);
    const groupOutAliases = [
      ...dimAliases,
      ...(bucket ? ["time_dimension"] : []),
    ];

    let sql: string;
    if (!needsTwoLevel) {
      // single-level
      const selectParts: string[] = [];
      for (const d of dims)
        selectParts.push(`${d.sql} AS ${quoteIdent(d.alias)}`);
      if (bucket) selectParts.push(`${bucket.expr} AS time_dimension`);
      for (const m of measures) {
        // A "*" (row-count) measure is always count(*) regardless of the requested aggregation.
        const expr =
          m.sql === "*"
            ? "count(*)"
            : translateAggregation(m.aggregation, m.sql);
        selectParts.push(
          `${expr} AS ${quoteIdent(`${m.aggregation}_${m.alias}`)}`,
        );
      }
      if (measures.length === 0) selectParts.push("count(*) AS count");
      const groupBy = [
        ...dims.map((d) => d.sql),
        ...(bucket ? ["time_dimension"] : []),
      ];
      sql =
        `SELECT ${selectParts.join(", ")} ${fromClause}` +
        (groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : "");
    } else {
      // two-level
      const innerParts: string[] = [`${base}.project_id`, `${base}.id`];
      const innerGroup: string[] = [`${base}.project_id`, `${base}.id`];
      for (const d of dims) {
        if (d.isArray) {
          // min() over an array column yields GreptimeDB's binary array encoding, not the JSON text
          // ClickHouse returns. The array is 1:1 per entity, so grouping by it raw (no extra
          // cardinality) preserves the JSON array (e.g. tags -> ["a","b"]).
          innerParts.push(`${d.sql} AS ${quoteIdent(d.alias)}`);
          innerGroup.push(d.sql);
        } else {
          // parent (1:1) dims are invariant per entity -> min() collapses fan-out
          innerParts.push(`min(${d.sql}) AS ${quoteIdent(d.alias)}`);
        }
      }
      if (bucket) innerParts.push(`min(${bucket.expr}) AS time_dimension`);
      // Project each measure once, keyed by its alias (the measure name). Several metrics may share
      // one measure (e.g. latency at p50/p90/p95/p99); the inner per-entity value is identical, and
      // the outer applies each aggregation to this single column. Emitting it per metric would
      // produce duplicate projection names, which GreptimeDB/DataFusion rejects.
      const seenInnerMeasure = new Set<string>();
      for (const m of measures) {
        if (seenInnerMeasure.has(m.alias)) continue;
        seenInnerMeasure.add(m.alias);
        const innerExpr = m.relationTable
          ? m.sql // already an aggregate over the child relation
          : m.sql === "*"
            ? "count(*)"
            : `min(${m.sql})`;
        innerParts.push(`${innerExpr} AS ${quoteIdent(m.alias)}`);
      }
      const inner =
        `SELECT ${innerParts.join(", ")} ${fromClause} ` +
        `GROUP BY ${innerGroup.join(", ")}`;

      const outerParts: string[] = [];
      for (const d of dims) outerParts.push(quoteIdent(d.alias));
      if (bucket) outerParts.push("time_dimension");
      for (const m of measures) {
        outerParts.push(
          `${translateAggregation(m.aggregation, quoteIdent(m.alias))} AS ${quoteIdent(`${m.aggregation}_${m.alias}`)}`,
        );
      }
      if (measures.length === 0) outerParts.push("count(*) AS count");
      sql =
        `SELECT ${outerParts.join(", ")} FROM (${inner}) AS inner_q` +
        (groupOutAliases.length
          ? ` GROUP BY ${groupOutAliases.map(quoteIdent).join(", ")}`
          : "");
    }

    sql += this.orderLimit(query, dims, measures, bucket);

    const postProcess: PostProcess = {
      metricColumns:
        measures.length > 0
          ? measures.map(metricColumnDescriptor)
          : [{ col: "count", integer: true }],
      hasTimeDimension: Boolean(bucket),
    };
    if (bucket) {
      postProcess.timeFill = {
        granularity: bucket.granularity,
        fromTimestamp: query.fromTimestamp,
        toTimestamp: query.toTimestamp,
        dimensionAliases: dimAliases,
        metricAliases:
          measures.length > 0
            ? measures.map((m) => `${m.aggregation}_${m.alias}`)
            : ["count"],
      };
    }
    return { query: sql, parameters, postProcess };
  }

  // -------------------------------------------------------------------------
  // by-type raw fetch (executor expands JSON map app-side)
  // -------------------------------------------------------------------------
  private buildByType(
    query: QueryType,
    projectId: string,
    view: ViewDeclarationType,
    dims: AppliedDimension[],
    measures: AppliedMeasure[],
    bucket: { expr: string; granularity: Exclude<Granularity, "auto"> } | null,
  ): GreptimeBuildResult {
    const base = baseAlias(view);
    const byTypeMeasure = measures.find((m) => m.isByType)!;
    // Dynamic-key by-type expansion sums each JSON map key app-side; non-sum aggregations would be
    // silently returned as sums under the requested alias, so reject them loudly.
    if (byTypeMeasure.aggregation !== "sum") {
      throw new InvalidRequestError(
        `Aggregation '${byTypeMeasure.aggregation}' is not supported for the by-type measure '${byTypeMeasure.measure}' on GreptimeDB (only 'sum').`,
      );
    }
    const keyDim = dims.find((d) => d.isByType);
    if (!keyDim) {
      throw new InvalidRequestError(
        `Measure '${byTypeMeasure.measure}' requires the '${byTypeMeasure.requiresDimension}' dimension.`,
      );
    }
    const jsonColumn = keyDim.byTypeJson ?? "usage_details";
    const groupDims = dims.filter((d) => !d.isByType);
    const relations = this.collectRelations(query, view, groupDims, []);
    const { fromClause, parameters } = this.buildFromAndWhere(
      query,
      projectId,
      view,
      relations,
    );

    // per-entity raw fetch: id + group dims + bucket + the JSON map (app-side expanded)
    const selectParts: string[] = [`${base}.id AS __entity_id`];
    for (const d of groupDims)
      selectParts.push(`${d.sql} AS ${quoteIdent(d.alias)}`);
    if (bucket) selectParts.push(`${bucket.expr} AS time_dimension`);
    selectParts.push(selectJsonColumn(jsonColumn, { tablePrefix: base }));

    const sql = `SELECT ${selectParts.join(", ")} ${fromClause}`;

    return {
      query: sql,
      parameters,
      postProcess: {
        metricColumns: [metricColumnDescriptor(byTypeMeasure)],
        hasTimeDimension: Boolean(bucket),
        byType: {
          jsonColumn,
          keyDimensionAlias: keyDim.alias,
          valueMetricAlias: `${byTypeMeasure.aggregation}_${byTypeMeasure.alias}`,
          aggregation: byTypeMeasure.aggregation,
          groupDimensionAliases: groupDims.map((d) => d.alias),
          hasTime: Boolean(bucket),
        },
        ...(bucket
          ? {
              timeFill: {
                granularity: bucket.granularity,
                fromTimestamp: query.fromTimestamp,
                toTimestamp: query.toTimestamp,
                dimensionAliases: [
                  keyDim.alias,
                  ...groupDims.map((d) => d.alias),
                ],
                metricAliases: [
                  `${byTypeMeasure.aggregation}_${byTypeMeasure.alias}`,
                ],
              },
            }
          : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // order by + limit
  // -------------------------------------------------------------------------
  private orderLimit(
    query: QueryType,
    dims: AppliedDimension[],
    measures: AppliedMeasure[],
    bucket: { expr: string; granularity: Exclude<Granularity, "auto"> } | null,
  ): string {
    const validAliases = new Set<string>([
      ...dims.map((d) => d.alias),
      ...(bucket ? ["time_dimension"] : []),
      ...measures.map((m) => `${m.aggregation}_${m.alias}`),
      ...(measures.length === 0 ? ["count"] : []),
    ]);

    // Bare measure names (e.g. `totalCost`, `count`) are accepted as orderBy fields by
    // `validateQuery.findMeasureInOrderByField`; normalize them to the aggregated output alias
    // `<agg>_<measure>` here so a query that passes validation does not throw at execution.
    const bareMeasureAlias = new Map<string, string>();
    for (const m of measures) {
      const out = `${m.aggregation}_${m.alias}`;
      bareMeasureAlias.set(m.measure, out);
      bareMeasureAlias.set(m.alias, out);
    }

    let order: Array<{ field: string; direction: string }> = [];
    if (query.orderBy && query.orderBy.length > 0) {
      order = query.orderBy.map((o) => {
        if (validAliases.has(o.field)) return o;
        const normalized = bareMeasureAlias.get(o.field);
        if (normalized) return { field: normalized, direction: o.direction };
        throw new InvalidRequestError(
          `Invalid orderBy field '${o.field}'. Must be one of ${[...validAliases].join(", ")}`,
        );
      });
    } else if (bucket) {
      order = [{ field: "time_dimension", direction: "asc" }];
    } else if (measures.length > 0) {
      const m = measures[0];
      order = [{ field: `${m.aggregation}_${m.alias}`, direction: "desc" }];
    } else if (dims.length > 0) {
      order = [{ field: dims[0].alias, direction: "asc" }];
    }

    let clause = order.length
      ? ` ORDER BY ${order.map((o) => `${quoteIdent(o.field)} ${o.direction === "desc" ? "DESC" : "ASC"}`).join(", ")}`
      : "";

    const rowLimit = getChartConfig(query)?.row_limit;
    if (rowLimit) clause += ` LIMIT ${rowLimit}`;
    return clause;
  }
}

const baseAliasForTable = (table: string): string => {
  switch (table) {
    case "traces":
      return "t";
    case "observations":
      return "o";
    case "scores":
      return "sc";
    case "dataset_run_items":
      return "dri";
    default:
      return table;
  }
};
