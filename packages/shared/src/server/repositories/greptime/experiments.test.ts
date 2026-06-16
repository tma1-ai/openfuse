import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  greptimeQuery: vi.fn(),
}));

vi.mock("../../greptime/client", () => ({
  greptimeQuery: mocks.greptimeQuery,
}));

import { getExperimentsListGreptime } from "./experiments";

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("Greptime experiments repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps numeric and categorical score filter params separate in experiment LIST", async () => {
    mocks.greptimeQuery
      .mockResolvedValueOnce([
        {
          lo: new Date("2026-06-10T00:00:00.000Z"),
          hi: new Date("2026-06-11T00:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([]);

    await getExperimentsListGreptime({
      projectId: "project-1",
      filter: [
        {
          column: "trace_scores_avg",
          key: "quality",
          operator: ">=",
          value: 0.85,
          type: "numberObject",
        },
        {
          column: "trace_score_categories",
          key: "sentiment",
          operator: "any of",
          value: ["positive"],
          type: "categoryOptions",
        },
      ],
    });

    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(2);
    const listQuery = mocks.greptimeQuery.mock.calls[1]?.[0];
    // numeric -> run_score_agg CTE (ln* params); categorical -> run_score_cat CTE (lc* params). Both
    // are flat single-level EXISTS over a preaggregated CTE (GreptimeDB rejects nested correlated
    // subqueries against item_dedup), and the ln*/lc* prefixes keep the two filters' params distinct.
    expect(normalizeSql(listQuery.query)).toContain(
      "rsa.`name` = :lnsk0 AND rsa.grain = :lnsg0 AND rsa.avg_value >= :lnsv0",
    );
    expect(normalizeSql(listQuery.query)).toContain(
      "rsc.`name` = :lcsk0 AND rsc.grain = :lcsg0 AND rsc.string_value IN (:lcsv0_0)",
    );
    expect(listQuery.params).toMatchObject({
      lnsk0: "quality",
      lnsg0: "trace",
      lnsv0: 0.85,
      lcsk0: "sentiment",
      lcsg0: "trace",
      lcsv0_0: "positive",
    });
  });
});
