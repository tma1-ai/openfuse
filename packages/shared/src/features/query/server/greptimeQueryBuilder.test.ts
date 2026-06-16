import { describe, expect, it } from "vitest";
import { GreptimeQueryBuilder } from "./greptimeQueryBuilder";
import { type QueryType } from "../types";

const PROJECT = "p-test";
const base = {
  filters: [],
  fromTimestamp: "2026-06-01T00:00:00.000Z",
  toTimestamp: "2026-06-02T00:00:00.000Z",
  orderBy: null,
} as const;

const build = (q: Partial<QueryType> & Pick<QueryType, "view">) =>
  new GreptimeQueryBuilder().build(
    {
      ...base,
      dimensions: [],
      metrics: [],
      timeDimension: null,
      ...q,
    } as QueryType,
    PROJECT,
  );

describe("GreptimeQueryBuilder", () => {
  it("single-level count over time uses date bucketing + is_deleted + named project_id", () => {
    const { query, parameters, postProcess } = build({
      view: "observations",
      metrics: [{ measure: "count", aggregation: "count" }],
      timeDimension: { granularity: "day" },
    });
    expect(query).toMatch(/AS time_dimension/);
    expect(query).toMatch(/date_trunc/);
    expect(query).toMatch(/is_deleted`? = false/);
    expect(query).toMatch(/count\(\*\)/);
    expect(Object.values(parameters)).toContain(PROJECT);
    expect(postProcess.timeFill?.granularity).toBe("day");
  });

  it("leaf percentile uses uddsketch", () => {
    const { query } = build({
      view: "observations",
      metrics: [{ measure: "latency", aggregation: "p95" }],
    });
    expect(query).toMatch(/uddsketch_calc/);
    expect(query).toMatch(/AS .?p95_latency/);
  });

  it("relation-backed measure emits a two-level query", () => {
    const { query } = build({
      view: "traces",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" }],
    });
    // inner aggregates observations per trace, outer sums across traces
    expect(query).toMatch(/sum\(o\.total_cost\)/);
    expect(query).toMatch(/GROUP BY t\.project_id, t\.id/);
    expect(query).toMatch(/FROM \(/); // nested
    expect(query).toMatch(/INNER JOIN .*observations/);
  });

  it("dedupes a relation measure shared by several aggregations in the inner projection", () => {
    // Home LatencyTables asks for traces latency at p50/p90/p95/p99 — one relation measure, four
    // aggregations. The inner per-trace `latency` value is identical for all four, so it must be
    // projected once; emitting it per metric produces duplicate projection names that GreptimeDB
    // rejects ("Projections require unique expression names ... AS latency").
    const { query } = build({
      view: "traces",
      dimensions: [{ field: "name" }],
      metrics: [
        { measure: "latency", aggregation: "p50" },
        { measure: "latency", aggregation: "p90" },
        { measure: "latency", aggregation: "p95" },
        { measure: "latency", aggregation: "p99" },
      ],
    });
    const innerLatencyProjections = query.match(/ AS `latency`/g) ?? [];
    expect(innerLatencyProjections).toHaveLength(1);
    // outer still applies all four quantiles over the single inner column
    expect(query).toMatch(/p50_latency/);
    expect(query).toMatch(/p99_latency/);
  });

  it("by-type query is a per-entity raw fetch with a byType post-process", () => {
    const { query, postProcess } = build({
      view: "observations",
      dimensions: [{ field: "costType" }],
      metrics: [{ measure: "costByType", aggregation: "sum" }],
      timeDimension: { granularity: "hour" },
    });
    expect(query).toMatch(/json_to_string/);
    expect(query).not.toMatch(/GROUP BY/); // raw fetch, no aggregation
    expect(postProcess.byType?.jsonColumn).toBe("cost_details");
    expect(postProcess.byType?.keyDimensionAlias).toBe("costType");
    expect(postProcess.byType?.valueMetricAlias).toBe("sum_costByType");
  });

  it("joins relation tables required only by filters", () => {
    const { query } = build({
      view: "observations",
      filters: [
        {
          column: "userId",
          type: "string",
          operator: "=",
          value: "user-1",
        },
      ],
      metrics: [{ measure: "count", aggregation: "count" }],
    });

    expect(query).toMatch(/INNER JOIN .*traces.* AS t/);
    expect(query).toMatch(/t\.`user_id`/);
  });

  it("joins the dataset_run_items relation for experiment dimensions (P4)", () => {
    const { query } = build({
      view: "scores-numeric",
      dimensions: [{ field: "experimentName" }],
      metrics: [{ measure: "count", aggregation: "count" }],
    });
    // experiment relation joins a DISTINCT dataset_run_items subquery (alias dri); no time bound.
    expect(query).toMatch(
      /INNER JOIN \(SELECT DISTINCT[\s\S]*dataset_run_items[\s\S]*\) AS dri/i,
    );
    expect(query).toMatch(/dri\.experiment_name/);
    expect(query).not.toMatch(/dataset_run_created_at/);
  });

  it("reads datasetRunId as a direct scores column (no relation join)", () => {
    const { query } = build({
      view: "scores-numeric",
      dimensions: [{ field: "datasetRunId" }],
      metrics: [{ measure: "count", aggregation: "count" }],
    });
    expect(query).toMatch(/s\.dataset_run_id/);
    expect(query).not.toMatch(/dataset_run_items/);
  });

  it("projects entityDimension as entity_dimension", () => {
    const { query } = build({
      view: "observations",
      entityDimension: { field: "name" },
      filters: [
        {
          column: "name",
          type: "string",
          operator: "=",
          value: "generation-a",
        },
      ],
      metrics: [{ measure: "count", aggregation: "count" }],
    });

    expect(query).toMatch(/o\.name AS `entity_dimension`/);
    expect(query).toMatch(/GROUP BY o\.name/);
  });

  it("score segment + scores view builds with data_type filter", () => {
    const { query } = build({
      view: "scores-numeric",
      metrics: [{ measure: "value", aggregation: "avg" }],
    });
    expect(query).toMatch(/data_type/);
    expect(query).toMatch(/avg\(s\.value\)/);
  });

  it("honors public metrics config.row_limit", () => {
    const { query } = build({
      view: "observations",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "count", aggregation: "count" }],
      config: { row_limit: 7 },
    } as unknown as Partial<QueryType> & Pick<QueryType, "view">);

    expect(query).toMatch(/LIMIT 7\b/);
  });

  it("auto-includes the by-type dimension when costByType is requested alone", () => {
    const { query, postProcess } = build({
      view: "observations",
      metrics: [{ measure: "costByType", aggregation: "sum" }],
    });
    expect(query).toMatch(/json_to_string/);
    expect(postProcess.byType?.keyDimensionAlias).toBe("costType");
  });

  it("rejects non-sum aggregation for a by-type measure", () => {
    expect(() =>
      build({
        view: "observations",
        dimensions: [{ field: "costType" }],
        metrics: [{ measure: "costByType", aggregation: "avg" }],
      }),
    ).toThrow(/only 'sum'/i);
  });

  it("counts unique users via count(distinct) without nesting, rejects sum", () => {
    const { query } = build({
      view: "traces",
      metrics: [{ measure: "uniqueUserIds", aggregation: "uniq" }],
    });
    expect(query).toMatch(/count\(distinct t\.user_id\)/);
    expect(query).not.toMatch(/count\(distinct count\(distinct/);

    expect(() =>
      build({
        view: "traces",
        metrics: [{ measure: "uniqueUserIds", aggregation: "sum" }],
      }),
    ).toThrow(/not valid for measure/i);
  });

  it("normalizes a bare measure name in orderBy to its aggregated alias", () => {
    const { query } = build({
      view: "traces",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" }],
      orderBy: [{ field: "totalCost", direction: "desc" }],
    });
    expect(query).toMatch(/ORDER BY `sum_totalCost` DESC/);
  });

  it("tokensPerSecond / outputTokensPerSecond are per-row rate measures", () => {
    const tps = build({
      view: "observations",
      metrics: [{ measure: "tokensPerSecond", aggregation: "avg" }],
    });
    expect(tps.query).toMatch(/avg\(/);
    expect(tps.query).toMatch(/usage_details/);
    expect(tps.query).toMatch(
      /to_unixtime\(o\.end_time\) - to_unixtime\(o\.start_time\)/,
    );
    const otps = build({
      view: "observations",
      metrics: [{ measure: "outputTokensPerSecond", aggregation: "avg" }],
    });
    expect(otps.query).toMatch(
      /to_unixtime\(o\.end_time\) - to_unixtime\(o\.completion_start_time\)/,
    );
  });

  it("uniq on the traceId measure counts distinct traces", () => {
    const { query } = build({
      view: "observations",
      metrics: [{ measure: "traceId", aggregation: "uniq" }],
    });
    expect(query).toMatch(/count\(distinct o\.trace_id\)/);
    // string measure: only count/uniq are valid
    expect(() =>
      build({
        view: "observations",
        metrics: [{ measure: "traceId", aggregation: "sum" }],
      }),
    ).toThrow(/not valid for measure/i);
  });

  it("scoreName filter resolves to the score name column (LFE-4838 fallback)", () => {
    const { query, parameters } = build({
      view: "scores-numeric",
      metrics: [{ measure: "count", aggregation: "count" }],
      filters: [
        {
          column: "scoreName",
          operator: "any of",
          value: ["accuracy"],
          type: "stringOptions",
        },
      ],
    });
    expect(query).toMatch(/s\.`?name`?/);
    expect(Object.values(parameters)).toContain("accuracy");
  });

  it("histogram builds a min/max probe + bucket SQL and a histogram descriptor", () => {
    const { query, postProcess } = build({
      view: "scores-numeric",
      metrics: [{ measure: "value", aggregation: "histogram" }],
      chartConfig: { type: "HISTOGRAM", bins: 10 },
    } as Partial<QueryType> & Pick<QueryType, "view">);
    expect(query).toMatch(/min\(s\.value\).*max\(s\.value\)/);
    expect(query).toMatch(/s\.value\) IS NOT NULL/);
    expect(postProcess.histogram?.bins).toBe(10);
    expect(postProcess.histogram?.bucketSql).toMatch(/floor\(/);
    expect(postProcess.histogram?.bucketSql).toMatch(/s\.value\) IS NOT NULL/);
    expect(postProcess.histogram?.bucketSql).toMatch(/GROUP BY bucket/);
    expect(postProcess.metricColumns).toEqual([]);
  });

  it("histogram rejects dimensions / time / multiple metrics (scope guard)", () => {
    expect(() =>
      build({
        view: "scores-numeric",
        dimensions: [{ field: "name" }],
        metrics: [{ measure: "value", aggregation: "histogram" }],
      }),
    ).toThrow(/histogram does not support dimensions/i);
    expect(() =>
      build({
        view: "scores-numeric",
        metrics: [{ measure: "value", aggregation: "histogram" }],
        timeDimension: { granularity: "day" },
      }),
    ).toThrow(/histogram does not support dimensions or a time dimension/i);
    expect(() =>
      build({
        view: "scores-numeric",
        metrics: [{ measure: "count", aggregation: "histogram" }],
      }),
    ).toThrow(/histogram is only supported for a base .* numeric measure/i);
  });
});
