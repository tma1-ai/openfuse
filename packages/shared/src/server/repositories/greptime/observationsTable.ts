import { type FilterState } from "../../../types";
import { type OrderByState } from "../../../interfaces/orderBy";
import { findUiColumnMapping } from "../../../tableDefinitions";
import { observationsTableCols } from "../../../observationsTable";
import { type Observation } from "../../../domain";
import { greptimeQuery } from "../../greptime/client";
import { createGreptimeFilterFromFilterState } from "../../greptime/sql/factory";
import { FilterList, StringFilter } from "../../greptime/sql/greptime-filter";
import {
  observationsTableGreptimeColumnDefinitions,
  type GreptimeColumnMappings,
  type GreptimeColumnMapping,
} from "../../greptime/sql/columnMappings";
import { greptimeOrderBySql } from "../../greptime/sql/orderby";
import { greptimeSearchCondition } from "../../greptime/sql/search";
import {
  type RenderingProps,
  DEFAULT_RENDERING_PROPS,
} from "../../utils/rendering";
import {
  convertGreptimeObservationRowToDomain,
  greptimeObservationSelect,
} from "./converters";
import { greptimeTsParam, notDeleted } from "./queryHelpers";

/**
 * GreptimeDB observations UI table reads (04-read-path.md, P2). Unlike traces/sessions this is a leaf
 * list, not an aggregate rollup: per-row latency / tool counts / cost / tokens come straight off the
 * merged `observations` projection (or are derived from the parsed row), so there is no CTE. Score
 * filters are grain-aware EXISTS over `scores` by `observation_id`; trace-column filters add a LEFT
 * JOIN on `traces`.
 */

const OBSERVATIONS_TO_TRACE_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

// Per-row metric + score-grain columns layered on the P1 base mapping (alias `o`). The metric
// expressions are emitted verbatim by the filter/orderby layer (non-bare identifiers). Units mirror
// `mapObservationsTable.ts`: latency / time-to-first-token in SECONDS, costs/tokens from the JSON maps.
const OBS_SECONDS = "(to_unixtime(o.end_time) - to_unixtime(o.start_time))";
const observationsTableExtendedColumns: GreptimeColumnMapping[] = [
  { uiTableName: "Latency (s)", uiTableId: "latency", greptimeTableName: "observations", greptimeSelect: OBS_SECONDS }, // prettier-ignore
  { uiTableName: "Time to First Token (s)", uiTableId: "timeToFirstToken", greptimeTableName: "observations", greptimeSelect: "(to_unixtime(o.completion_start_time) - to_unixtime(o.start_time))" }, // prettier-ignore
  { uiTableName: "Tokens per second", uiTableId: "tokensPerSecond", greptimeTableName: "observations", greptimeSelect: `(json_get_float(o.usage_details, 'output') / NULLIF(${OBS_SECONDS}, 0))` }, // prettier-ignore
  { uiTableName: "Input Cost ($)", uiTableId: "inputCost", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.cost_details, 'input')" }, // prettier-ignore
  { uiTableName: "Output Cost ($)", uiTableId: "outputCost", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.cost_details, 'output')" }, // prettier-ignore
  { uiTableName: "Total Cost ($)", uiTableId: "totalCost", greptimeTableName: "observations", greptimeSelect: "o.total_cost" }, // prettier-ignore
  { uiTableName: "Input Tokens", uiTableId: "inputTokens", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.usage_details, 'input')" }, // prettier-ignore
  { uiTableName: "Output Tokens", uiTableId: "outputTokens", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.usage_details, 'output')" }, // prettier-ignore
  { uiTableName: "Total Tokens", uiTableId: "totalTokens", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.usage_details, 'total')" }, // prettier-ignore
  { uiTableName: "Tokens", uiTableId: "tokens", greptimeTableName: "observations", greptimeSelect: "json_get_float(o.usage_details, 'total')" }, // prettier-ignore
  // Trace-scoped tag filter (correlates to the joined trace via the traces_tags EAV).
  { uiTableName: "Tags", uiTableId: "tags", greptimeTableName: "traces", greptimeSelect: "tags", queryPrefix: "t" }, // prettier-ignore
  // Score-grain filters (EXISTS over scores by observation_id).
  { uiTableName: "Scores (numeric)", uiTableId: "scores_avg", greptimeTableName: "scores", greptimeSelect: "observation_id", scoreGrain: { scoresColumn: "observation_id", outerPrefix: "o", outerColumn: "id" } }, // prettier-ignore
  { uiTableName: "Scores (categorical)", uiTableId: "score_categories", greptimeTableName: "scores", greptimeSelect: "observation_id", scoreGrain: { scoresColumn: "observation_id", outerPrefix: "o", outerColumn: "id" } }, // prettier-ignore
];

export const observationsTableMapping: GreptimeColumnMappings = [
  ...observationsTableGreptimeColumnDefinitions,
  ...observationsTableExtendedColumns,
];

export type GreptimeObservationsTableProps = {
  projectId: string;
  filter: FilterState;
  selectIOAndMetadata?: boolean;
  orderBy?: OrderByState;
  limit?: number;
  offset?: number;
  searchQuery?: string;
  searchType?: Parameters<typeof greptimeSearchCondition>[0]["searchType"];
};

export type CompiledObs = {
  // observations-scoped predicates (o.* + score-grain EXISTS, which correlate to o.id).
  obsWhereSql: string;
  // trace-scoped predicates (t.*), applied inside the traces subquery.
  traceWhereSql: string;
  params: Record<string, unknown>;
  traceJoin: boolean;
  // A trace FILTER (or the trace lookback) means an observation must match a passing/recent trace, so
  // the join must be INNER. A join that exists only to order by a trace column stays LEFT.
  innerTraceJoin: boolean;
  lookback?: string;
};

export const buildObservationsTableQuery = (
  props: GreptimeObservationsTableProps,
): CompiledObs => {
  const { projectId, filter, orderBy } = props;
  const filters = new FilterList([
    new StringFilter({
      table: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
    ...createGreptimeFilterFromFilterState(
      filter,
      observationsTableMapping,
      observationsTableCols,
    ),
  ]);

  // Split by physical table so each side can be pre-filtered inside its own subquery (a flat
  // `observations o LEFT JOIN traces t ... WHERE` defeats GreptimeDB index pushdown on the driving
  // observations scan). Score-grain filters carry table "scores" but render as EXISTS correlated to
  // `o.id`, so they stay on the observations side.
  const obsFilters = filters.filter((f) => f.table !== "traces");
  const traceFilters = filters.filter((f) => f.table === "traces");

  const traceJoin =
    traceFilters.length() > 0 ||
    findUiColumnMapping(observationsTableMapping, orderBy?.column)
      ?.greptimeTableName === "traces";

  // Trace lookback (CH joined traces only with a recent-window guard) when a Start Time lower bound
  // is present and the trace join is active.
  const startLowerBound = filter.find(
    (f) =>
      f.column === "Start Time" && (f.operator === ">=" || f.operator === ">"),
  );
  const lookback =
    traceJoin && startLowerBound && startLowerBound.type === "datetime"
      ? greptimeTsParam(
          new Date(
            startLowerBound.value.getTime() - OBSERVATIONS_TO_TRACE_INTERVAL_MS,
          ),
        )
      : undefined;

  const obsRes = obsFilters.apply();
  const traceRes = traceFilters.apply();
  return {
    obsWhereSql: obsRes.query,
    traceWhereSql: traceRes.query,
    // `projectId` binds the `t.project_id = :projectId` scope in the traces subquery (the o-side
    // project filter above carries its own auto-generated placeholder, not :projectId).
    params: { projectId, ...obsRes.params, ...traceRes.params },
    traceJoin,
    innerTraceJoin: traceFilters.length() > 0 || lookback !== undefined,
    lookback,
  };
};

// Build the pre-filtered FROM clause (observations subquery [join traces subquery]) so each base table
// scan prunes before the join. `SELECT *` is an intentional intermediate relation (projection pushdown
// drops unreferenced columns; the outer query wraps JSON columns via its explicit select list).
export const observationsScopedFrom = (
  compiled: CompiledObs,
  search: { query: string },
): string => {
  const obsSub = `(SELECT * FROM observations o
      WHERE ${compiled.obsWhereSql} AND ${notDeleted("o")} ${search.query}) o`;
  if (!compiled.traceJoin) return obsSub;
  const traceSub = `(SELECT * FROM traces t
      WHERE t.project_id = :projectId AND ${notDeleted("t")}
        ${compiled.traceWhereSql ? `AND ${compiled.traceWhereSql}` : ""}
        ${compiled.lookback ? "AND t.timestamp >= :obsTraceLookback" : ""}) t`;
  const joinKind = compiled.innerTraceJoin ? "JOIN" : "LEFT JOIN";
  return `${obsSub}
    ${joinKind} ${traceSub} ON t.id = o.trace_id AND t.project_id = o.project_id`;
};

const observationsOrderBy = (orderBy?: OrderByState): string => {
  const primary: OrderByState = orderBy ?? {
    column: "startTime",
    order: "DESC",
  };
  return greptimeOrderBySql(
    [primary, { column: "id", order: primary?.order ?? "DESC" }],
    observationsTableMapping,
  );
};

export const getObservationsTableCountGreptime = async (
  props: GreptimeObservationsTableProps,
): Promise<number> => {
  const compiled = buildObservationsTableQuery(props);
  const search = greptimeSearchCondition({
    query: props.searchQuery,
    searchType: props.searchType,
    tablePrefix: "o",
  });
  const rows = await greptimeQuery<{ count: string | number }>({
    query: `
      SELECT count(*) AS count
      FROM ${observationsScopedFrom(compiled, search)}`,
    params: {
      ...compiled.params,
      ...search.params,
      ...(compiled.lookback ? { obsTraceLookback: compiled.lookback } : {}),
    },
    readOnly: true,
  });
  return rows.length > 0 ? Number(rows[0].count) : 0;
};

export const getObservationsTableRowsGreptime = async (
  props: GreptimeObservationsTableProps,
  renderingProps: RenderingProps = DEFAULT_RENDERING_PROPS,
): Promise<Observation[]> => {
  const compiled = buildObservationsTableQuery(props);
  const search = greptimeSearchCondition({
    query: props.searchQuery,
    searchType: props.searchType,
    tablePrefix: "o",
  });
  const exclude = !props.selectIOAndMetadata;
  const rows = await greptimeQuery<Record<string, unknown>>({
    query: `
      SELECT ${greptimeObservationSelect({ prefix: "o", excludeIo: exclude, excludeMetadata: exclude })}
      FROM ${observationsScopedFrom(compiled, search)}
      ${observationsOrderBy(props.orderBy)}
      ${props.limit !== undefined && props.offset !== undefined ? "LIMIT :limit OFFSET :offset" : ""}`,
    params: {
      ...compiled.params,
      ...search.params,
      ...(compiled.lookback ? { obsTraceLookback: compiled.lookback } : {}),
      ...(props.limit !== undefined && props.offset !== undefined
        ? { limit: props.limit, offset: props.offset }
        : {}),
    },
    readOnly: true,
  });
  return rows.map((r) =>
    convertGreptimeObservationRowToDomain(r, renderingProps),
  );
};
