import {
  greptimeAggregatedLevelString,
  greptimeKnownKeySum,
  greptimeLatencyMs,
  greptimeLevelCounts,
} from "../../greptime/sql/fragments";
import { notDeleted } from "./queryHelpers";

/**
 * The trace-rollup observations CTE shared by the UI traces table (`tracesUiTable.ts`) and the
 * public-API trace generators (`traces.ts`). A single `GROUP BY (project_id, trace_id)` over
 * `observations` yields every aggregate the trace surfaces filter / order / display on: observation
 * count, span latency, per-level counts, max-severity level, total cost, and the known-key
 * usage/cost sums. Dynamic-key usage/cost maps are summed app-side (`rollup.ts`), not here.
 *
 * Aggregates are non-NULL *within* a group (a group always has >= 1 observation); the LEFT JOIN to
 * `traces` is what produces NULL for zero-observation traces, so COALESCE belongs at the reference
 * site in the outer query (e.g. `COALESCE(o.error_count, 0)`), never in this SELECT.
 */
export type ObservationsStatsCteParams = {
  /** CTE name the outer query joins; default `observations_stats`. */
  cteName?: string;
  /** Named param holding the project id; default `projectId`. */
  projectIdParam?: string;
  /**
   * Named param for an observation `start_time` lower bound (`>=`). Set when the caller bounds the
   * scan by a trace from-time filter (perf only; the LEFT JOIN keeps correctness).
   */
  lookbackParam?: string;
  /** Already-compiled obs-scoped predicate (e.g. a `trace_id` push-down), ANDed into the WHERE. */
  extraFilterSql?: string;
  /**
   * Emit `array_to_string(array_agg(id), :<idSepParam>) AS observation_ids` for the public-API
   * `observations` field group. Requires `idSepParam`. The UI table does not need it.
   */
  includeIds?: boolean;
  /** Named param holding the id separator; required iff `includeIds`. */
  idSepParam?: string;
};

export const buildObservationsStatsCte = (
  params: ObservationsStatsCteParams = {},
): string => {
  const cteName = params.cteName ?? "observations_stats";
  const projectIdParam = params.projectIdParam ?? "projectId";

  if (params.includeIds && !params.idSepParam) {
    throw new Error(
      "buildObservationsStatsCte: includeIds requires idSepParam",
    );
  }
  const idsLine = params.includeIds
    ? `array_to_string(array_agg(id), :${params.idSepParam}) AS observation_ids,`
    : "";
  const lookbackLine = params.lookbackParam
    ? `AND start_time >= :${params.lookbackParam}`
    : "";
  const extraLine = params.extraFilterSql ? `AND ${params.extraFilterSql}` : "";

  return `${cteName} AS (
      SELECT
        trace_id,
        project_id,
        ${idsLine}
        count(*) AS observation_count,
        ${greptimeLatencyMs()} AS latency_milliseconds,
        ${greptimeLevelCounts()},
        ${greptimeAggregatedLevelString()},
        sum(total_cost) AS cost_total,
        ${greptimeKnownKeySum("cost_details", "input", undefined, "cost_input")},
        ${greptimeKnownKeySum("cost_details", "output", undefined, "cost_output")},
        ${greptimeKnownKeySum("usage_details", "input", undefined, "usage_input")},
        ${greptimeKnownKeySum("usage_details", "output", undefined, "usage_output")},
        ${greptimeKnownKeySum("usage_details", "total", undefined, "usage_total")}
      FROM observations
      WHERE project_id = :${projectIdParam} AND ${notDeleted()}
        ${lookbackLine}
        ${extraLine}
      GROUP BY trace_id, project_id
    )`;
};
