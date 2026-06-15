import { v4 } from "uuid";
import { beforeAll, describe, expect, it } from "vitest";

import { executeQuery } from "@langfuse/shared/query/server";
import {
  getViewDeclaration,
  viewsV2,
  type QueryType,
} from "@langfuse/shared/query";
import { getValidMonitorAggregationsForMeasure } from "@langfuse/shared/monitors";

/**
 * eventsCoreAvailable reported whether the dev-only ClickHouse `events_core`
 * table existed. ClickHouse is gone, so it never does.
 *
 * TODO(P7): this snapshot test of monitor scalar queries was gated on the
 * ClickHouse `events_core` dev table and is now a permanent skip. Rewrite it to
 * run the monitor combos against the GreptimeDB executor (executeQuery on an
 * empty project) with a fresh snapshot, skipping measures the executor does not
 * yet support (histogram, tokensPerSecond — see the queryBuilder skips).
 * Tracked for the GreptimeDB dashboard-query executor follow-up (issue #7).
 */
async function eventsCoreAvailable(): Promise<boolean> {
  return false;
}

/** parseNumericValue coerces a ClickHouse cell to number | null, mirroring the monitor processor. */
function parseNumericValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** combos enumerates every (view, measure, aggregation) a monitor can run. */
const combos = viewsV2.options.flatMap((view) => {
  const declaration = getViewDeclaration(view, "v2");
  return Object.entries(declaration.measures).flatMap(([measure, def]) =>
    getValidMonitorAggregationsForMeasure(def).map((aggregation) => ({
      view,
      measure,
      aggregation,
    })),
  );
});

/** scalarValue runs one monitor scalar query against an empty project and returns its number | null. */
async function scalarValue(query: QueryType): Promise<number | null> {
  const rows = await executeQuery(v4(), query, "v2", true);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return parseNumericValue(Object.values(row)[0]);
}

describe("monitor scalar query — empty project", () => {
  let hasEventsCore = false;
  beforeAll(async () => {
    hasEventsCore = await eventsCoreAvailable();
  });

  it("verifies which parameters return zero and which return null", async (ctx) => {
    if (!hasEventsCore) ctx.skip();
    const results: Record<string, number | null> = {};
    for (const { view, measure, aggregation } of combos) {
      results[`${view}/${measure}/${aggregation}`] = await scalarValue({
        view,
        dimensions: [],
        metrics: [{ measure, aggregation }],
        filters: [],
        timeDimension: null,
        fromTimestamp: "2025-01-01T00:00:00.000Z",
        toTimestamp: "2025-03-01T00:00:00.000Z",
        orderBy: null,
      });
    }
    expect(results).toMatchSnapshot();
  });
});
