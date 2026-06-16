import { describe, expect, it } from "vitest";

import {
  ArrayOptionsFilter as ChArrayOptionsFilter,
  BooleanFilter as ChBooleanFilter,
  CategoryOptionsFilter as ChCategoryOptionsFilter,
  DateTimeFilter as ChDateTimeFilter,
  FilterList as ChFilterList,
  NumberFilter as ChNumberFilter,
  NumberObjectFilter as ChNumberObjectFilter,
  StringFilter as ChStringFilter,
  StringObjectFilter as ChStringObjectFilter,
  StringOptionsFilter as ChStringOptionsFilter,
} from "../../queries";
import {
  ArrayOptionsFilter,
  BooleanFilter,
  CategoryOptionsFilter,
  DateTimeFilter,
  NumberFilter,
  NumberObjectFilter,
  ScoreNumberObjectFilter,
  StringFilter,
  StringObjectFilter,
  StringOptionsFilter,
} from "../../greptime/sql/greptime-filter";
import {
  chFilterToGreptime,
  remapObsAggregateFilter,
  translateChFilterList,
} from "./translateChFilter";
import { tracesTableUiColumnDefinitions } from "../../tableMappings/mapTracesTable";

describe("chFilterToGreptime", () => {
  it("maps scalar/option/EAV classes 1:1", () => {
    expect(
      chFilterToGreptime(
        new ChStringFilter({
          clickhouseTable: "traces",
          field: "user_id",
          operator: "=",
          value: "u1",
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(StringFilter);

    expect(
      chFilterToGreptime(
        new ChStringOptionsFilter({
          clickhouseTable: "traces",
          field: "environment",
          operator: "any of",
          values: ["default"],
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(StringOptionsFilter);

    expect(
      chFilterToGreptime(
        new ChArrayOptionsFilter({
          clickhouseTable: "traces",
          field: "tags",
          operator: "all of",
          values: ["a"],
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(ArrayOptionsFilter);

    expect(
      chFilterToGreptime(
        new ChDateTimeFilter({
          clickhouseTable: "traces",
          field: "timestamp",
          operator: ">=",
          value: new Date("2026-01-01T00:00:00.000Z"),
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(DateTimeFilter);

    expect(
      chFilterToGreptime(
        new ChNumberFilter({
          clickhouseTable: "scores",
          field: "value",
          operator: ">=",
          value: 0.5,
        }),
      ),
    ).toBeInstanceOf(NumberFilter);

    expect(
      chFilterToGreptime(
        new ChBooleanFilter({
          clickhouseTable: "traces",
          field: "bookmarked",
          operator: "=",
          value: true,
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(BooleanFilter);

    expect(
      chFilterToGreptime(
        new ChStringObjectFilter({
          clickhouseTable: "traces",
          field: "metadata",
          operator: "=",
          key: "env",
          value: "prod",
          tablePrefix: "t",
        }),
      ),
    ).toBeInstanceOf(StringObjectFilter);
  });

  it("maps a metadata numberObject to the EAV NumberObjectFilter", () => {
    const out = chFilterToGreptime(
      new ChNumberObjectFilter({
        clickhouseTable: "traces",
        field: "metadata",
        operator: ">=",
        key: "score",
        value: 1,
        tablePrefix: "t",
      }),
    );
    expect(out).toBeInstanceOf(NumberObjectFilter);
    // The EAV metadata EXISTS is project-scoped (tenant isolation).
    expect(out.apply().query).toContain("project_id");
  });

  it("routes a scores_avg numberObject to the grain-aware ScoreNumberObjectFilter", () => {
    const grain = {
      scoresColumn: "trace_id" as const,
      outerPrefix: "t",
      outerColumn: "id",
    };
    const out = chFilterToGreptime(
      new ChNumberObjectFilter({
        clickhouseTable: "traces",
        field: "scores_avg",
        operator: ">=",
        key: "quality",
        value: 0.8,
        tablePrefix: "t",
      }),
      { scoreGrain: grain },
    );
    expect(out).toBeInstanceOf(ScoreNumberObjectFilter);
    const q = out.apply().query;
    expect(q).toContain("FROM `scores`");
    expect(q).toContain("HAVING avg");
  });

  it("routes a score_categories filter to the grain-aware CategoryOptionsFilter", () => {
    const out = chFilterToGreptime(
      new ChCategoryOptionsFilter({
        clickhouseTable: "traces",
        field: "score_categories",
        operator: "any of",
        key: "sentiment",
        values: ["positive"],
        tablePrefix: "t",
      }),
      {
        scoreGrain: {
          scoresColumn: "trace_id",
          outerPrefix: "t",
          outerColumn: "id",
        },
      },
    );
    expect(out).toBeInstanceOf(CategoryOptionsFilter);
    expect(out.apply().query).toContain("CATEGORICAL");
  });

  it("throws loud on a rollup-score filter with no grain in context", () => {
    expect(() =>
      chFilterToGreptime(
        new ChCategoryOptionsFilter({
          clickhouseTable: "traces",
          field: "score_categories",
          operator: "any of",
          key: "sentiment",
          values: ["positive"],
          tablePrefix: "t",
        }),
      ),
    ).toThrow(/scoreGrain/);

    expect(() =>
      chFilterToGreptime(
        new ChNumberObjectFilter({
          clickhouseTable: "traces",
          field: "scores_avg",
          operator: ">=",
          key: "quality",
          value: 0.8,
          tablePrefix: "t",
        }),
      ),
    ).toThrow(/scoreGrain/);
  });

  it("translateChFilterList ANDs every translated filter and merges params", () => {
    const list = new ChFilterList([
      new ChStringFilter({
        clickhouseTable: "traces",
        field: "project_id",
        operator: "=",
        value: "p1",
        tablePrefix: "t",
      }),
      new ChStringFilter({
        clickhouseTable: "traces",
        field: "user_id",
        operator: "=",
        value: "u1",
        tablePrefix: "t",
      }),
    ]);
    const applied = translateChFilterList(list).apply();
    expect(applied.query.split(" AND ")).toHaveLength(2);
    expect(Object.keys(applied.params)).toHaveLength(2);
  });
});

describe("remapObsAggregateFilter", () => {
  // Resolve the CH `clickhouseSelect` the public-API filter compiler bakes into `field`, so the test
  // exercises the same identity a real compiled obs filter carries (not a hand-typed expression).
  const chSelectFor = (uiTableId: string): string => {
    const m = tracesTableUiColumnDefinitions.find(
      (c) => c.uiTableId === uiTableId,
    );
    if (!m) throw new Error(`no CH mapping for ${uiTableId}`);
    return m.clickhouseSelect;
  };

  it("COALESCEs a numeric obs aggregate so zero-observation traces participate in = 0 / !=", () => {
    const out = remapObsAggregateFilter(
      new ChNumberFilter({
        clickhouseTable: "observations",
        field: chSelectFor("errorCount"),
        operator: "=",
        value: 0,
      }),
    );
    const q = out.apply().query;
    expect(q).toContain("COALESCE(o.error_count, 0)");
    expect(q).toMatch(/COALESCE\(o\.error_count, 0\) = :/);
  });

  it("remaps token / cost / latency aggregates onto their CTE aliases", () => {
    const cases: Array<[string, string]> = [
      ["inputTokens", "COALESCE(o.usage_input, 0)"],
      ["outputTokens", "COALESCE(o.usage_output, 0)"],
      ["totalTokens", "COALESCE(o.usage_total, 0)"],
      ["inputCost", "COALESCE(o.cost_input, 0)"],
      ["totalCost", "COALESCE(o.cost_total, 0)"],
      ["latency", "COALESCE(o.latency_milliseconds / 1000, 0)"],
    ];
    for (const [uiTableId, expected] of cases) {
      const out = remapObsAggregateFilter(
        new ChNumberFilter({
          clickhouseTable: "observations",
          field: chSelectFor(uiTableId),
          operator: ">=",
          value: 1,
        }),
      );
      expect(out.apply().query).toContain(expected);
    }
  });

  it("leaves the level column un-COALESCEd (no observations -> no level match)", () => {
    const out = remapObsAggregateFilter(
      new ChStringOptionsFilter({
        clickhouseTable: "observations",
        field: chSelectFor("level"),
        operator: "any of",
        values: ["ERROR"],
      }),
    );
    const q = out.apply().query;
    expect(q).toContain("o.aggregated_level IN (");
    expect(q).not.toContain("COALESCE");
  });

  it("throws InvalidRequestError on an unknown observation column", () => {
    expect(() =>
      remapObsAggregateFilter(
        new ChNumberFilter({
          clickhouseTable: "observations",
          field: "nonsense_col",
          operator: "=",
          value: 1,
        }),
      ),
    ).toThrow(/Unsupported observation filter column/);
  });
});
