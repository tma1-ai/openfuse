import { describe, expect, it } from "vitest";
import {
  createPublicApiTracesColumnMapping,
  deriveFilters,
} from "../../queries/public-api-filter-builder";
import { tracesTableUiColumnDefinitions } from "../../tableMappings/mapTracesTable";
import { translateChFilterList } from "./translateChFilter";

const TRACE_SCORE_GRAIN = {
  scoresColumn: "trace_id",
  outerPrefix: "t",
  outerColumn: "id",
} as const;

// Regression guard: the public-API sends `score_categories` as a StringOptions filter carrying
// combined `name:string_value` options. GreptimeDB has no materialised `score_categories` column, so
// the translation must route it to a categorical score-grain EXISTS instead of emitting a dangling
// `s.score_categories IN (...)` reference (which 500s: "No field named s.score_categories").
describe("traces public-API score_categories StringOptions -> GreptimeDB SQL", () => {
  const translate = (advanced: unknown) => {
    const mapping = createPublicApiTracesColumnMapping("traces", "t");
    const chFilter = deriveFilters(
      { projectId: "p1" } as never,
      mapping,
      advanced as never,
      tracesTableUiColumnDefinitions,
    );
    const out: string[] = [];
    translateChFilterList(chFilter, { scoreGrain: TRACE_SCORE_GRAIN }).forEach(
      (g) => out.push(g.apply().query),
    );
    return out;
  };

  it("routes score_categories StringOptions to a categorical score-grain EXISTS", () => {
    const [sql] = translate([
      {
        type: "stringOptions",
        column: "score_categories",
        operator: "any of",
        value: ["quality:good"],
      },
    ]);
    expect(sql).toContain("EXISTS (SELECT 1 FROM `scores` cs");
    // grain-correlated + tenant-scoped
    expect(sql).toContain("cs.`project_id` = t.`project_id`");
    expect(sql).toContain("cs.`trace_id` = t.`id`");
    expect(sql).toContain("cs.`data_type` = 'CATEGORICAL'");
    expect(sql).toContain("cs.`name` =");
    expect(sql).toContain("cs.`string_value` =");
    // no dangling column reference to the non-existent materialised column
    expect(sql).not.toContain("score_categories");
  });

  it("negates for `none of`", () => {
    const [sql] = translate([
      {
        type: "stringOptions",
        column: "score_categories",
        operator: "none of",
        value: ["quality:good"],
      },
    ]);
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM `scores` cs");
  });
});
