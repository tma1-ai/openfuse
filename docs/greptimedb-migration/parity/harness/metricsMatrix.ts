/**
 * Legal metrics query generator (Codex review #1).
 *
 * Measures are per-view; valid aggregations are constrained by each measure's declared
 * `aggs` (if any) else by its `type` via getValidAggregationsForMeasureType. We import the
 * repo's OWN view declarations so the matrix tracks code drift instead of hardcoding a
 * stale enum. `requiresDimension` measures (costByType/usageByType) auto-include their dim.
 *
 * Imports reach the pure query modules directly (no @langfuse/shared barrel → no DB boot).
 */
import {
  getViewDeclaration,
} from "../../../../packages/shared/src/features/query/dataModel";
import {
  getValidAggregationsForMeasureType,
} from "../../../../packages/shared/src/features/query/types";

export type MetricsView =
  | "traces"
  | "observations"
  | "scores-numeric"
  | "scores-categorical";

const VIEWS: MetricsView[] = [
  "traces",
  "observations",
  "scores-numeric",
  "scores-categorical",
];

// Preferred breakdown dimensions per view (intersected with the declared dimensions).
const PREFERRED_DIMS: Record<MetricsView, string[]> = {
  traces: ["name", "userId", "environment", "release", "version", "tags"],
  observations: ["name", "providedModelName", "model", "type", "level", "environment"],
  "scores-numeric": ["name", "source", "environment", "dataType"],
  "scores-categorical": ["name", "source", "environment", "stringValue", "dataType"],
};

// Measures that get the extra breakdown + time-series treatment (intersected with declared).
const HEADLINE = [
  "count",
  "latency",
  "totalCost",
  "totalTokens",
  "totalCostByType",
  "totalUsageByType",
  "timeToFirstToken",
  "value",
  "countScores",
  "countObservations",
];

const TIME_GRANULARITIES = ["hour", "day"];

export interface MetricsCase {
  label: string;
  query: Record<string, unknown>;
}

interface MeasureDecl {
  type?: string;
  aggs?: Record<string, string>;
  requiresDimension?: string;
}

function legalAggregations(m: MeasureDecl): string[] {
  if (m.aggs && Object.keys(m.aggs).length > 0) return Object.keys(m.aggs);
  return getValidAggregationsForMeasureType(m.type);
}

export function buildMetricsMatrix(
  fromTimestamp: string,
  toTimestamp: string,
  /** Run-unique environments → every query scoped to this run (no cross-run contamination). */
  envScope: string[],
): MetricsCase[] {
  const cases: MetricsCase[] = [];
  const runFilter = envScope.length
    ? [{ column: "environment", operator: "any of", value: envScope, type: "stringOptions" }]
    : [];

  for (const view of VIEWS) {
    let decl;
    try {
      decl = getViewDeclaration(view as never);
    } catch {
      continue; // view not available in this build
    }
    const measures = decl.measures as Record<string, MeasureDecl>;
    const declaredDims = new Set(Object.keys(decl.dimensions));
    const dims = PREFERRED_DIMS[view].filter((d) => declaredDims.has(d));

    for (const [measureName, m] of Object.entries(measures)) {
      const reqDim = m.requiresDimension;
      const baseDims = reqDim ? [{ field: reqDim }] : [];

      for (const agg of legalAggregations(m)) {
        // histogram has narrow scope (single numeric, no dim, no time): emit base-case only.
        if (agg === "histogram") {
          if (reqDim) continue;
          cases.push({
            label: `${view}/${measureName}/histogram`,
            query: mkQuery(view, [{ measure: measureName, aggregation: agg }], [], null, fromTimestamp, toTimestamp, runFilter, { bins: 10 }),
          });
          continue;
        }
        // base: no dimension, no time
        cases.push({
          label: `${view}/${measureName}/${agg}`,
          query: mkQuery(view, [{ measure: measureName, aggregation: agg }], baseDims, null, fromTimestamp, toTimestamp, runFilter),
        });
      }

      // breakdown + time-series only for headline measures (bounds matrix size)
      if (HEADLINE.includes(measureName)) {
        const agg = legalAggregations(m)[0] ?? "count";
        for (const d of dims) {
          const dimList = reqDim && d !== reqDim ? [{ field: reqDim }, { field: d }] : [{ field: d }];
          cases.push({
            label: `${view}/${measureName}/${agg}/by:${d}`,
            query: mkQuery(view, [{ measure: measureName, aggregation: agg }], dimList, null, fromTimestamp, toTimestamp, runFilter),
          });
        }
        for (const g of TIME_GRANULARITIES) {
          cases.push({
            label: `${view}/${measureName}/${agg}/ts:${g}`,
            query: mkQuery(view, [{ measure: measureName, aggregation: agg }], baseDims, g, fromTimestamp, toTimestamp, runFilter),
          });
        }
      }
    }
  }
  return cases;
}

function mkQuery(
  view: string,
  metrics: { measure: string; aggregation: string }[],
  dimensions: { field: string }[],
  granularity: string | null,
  fromTimestamp: string,
  toTimestamp: string,
  filters: unknown[],
  config?: { bins?: number; row_limit?: number },
): Record<string, unknown> {
  return {
    view,
    dimensions,
    metrics,
    filters,
    timeDimension: granularity ? { granularity } : null,
    fromTimestamp,
    toTimestamp,
    orderBy: null,
    ...(config ? { config } : {}),
  };
}
