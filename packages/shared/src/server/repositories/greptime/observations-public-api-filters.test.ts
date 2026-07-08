import { describe, expect, it } from "vitest";
import {
  createPublicApiObservationsColumnMapping,
  deriveFilters,
} from "../../queries/public-api-filter-builder";
import { observationsTableUiColumnDefinitions } from "../../tableMappings/mapObservationsTable";
import { translateChFilterList } from "./translateChFilter";

// Regression guard for the observations public-API advanced-filter path. The
// observations UI column definitions used to bake the table alias into
// `clickhouseSelect` as a double-quoted identifier (`o."user_id"`) and omit
// `queryPrefix`. Over GreptimeDB's MySQL protocol that broke two ways:
//   1. EAV (metadata) EXISTS fell back to correlating on the bare table name
//      (`observations.project_id`) instead of the outer alias `o` — a tenant-
//      isolation-relevant miscorrelation that also 500s ("No field named
//      observations.project_id").
//   2. `o."col"` parses as alias `o` + a string literal (GreptimeDB does not run
//      in ANSI_QUOTES mode), yielding "No field named o".
// The fix aligns the observations mapping with the traces mapping: bare
// `clickhouseSelect` + `queryPrefix`, so the translation emits backtick-quoted,
// alias-qualified SQL.
describe("observations public-API advanced filters -> GreptimeDB SQL", () => {
  const translate = (advanced: unknown) => {
    const mapping = createPublicApiObservationsColumnMapping(
      "observations",
      "o",
      "parent_observation_id",
    );
    const chFilter = deriveFilters(
      { projectId: "p1" } as never,
      mapping,
      advanced as never,
      observationsTableUiColumnDefinitions.filter(
        (c) => c.clickhouseTableName !== "scores",
      ),
    );
    const out: string[] = [];
    translateChFilterList(chFilter).forEach((g) => out.push(g.apply().query));
    return out;
  };

  it("correlates the metadata EAV EXISTS on the outer alias, not the table name", () => {
    const [sql] = translate([
      {
        column: "Metadata",
        type: "stringObject",
        operator: "contains",
        key: "foo",
        value: "bar",
      },
    ]);
    expect(sql).toContain("`observations_metadata` m");
    expect(sql).toContain("m.`project_id` = o.`project_id`");
    expect(sql).toContain("m.`entity_id` = o.`id`");
    // must NOT correlate on the bare table name (cross-project leak / 500)
    expect(sql).not.toContain("observations.`project_id`");
  });

  it("emits backtick-quoted, alias-qualified scalar predicates", () => {
    const [nullSql] = translate([
      {
        column: "Parent Observation ID",
        type: "null",
        operator: "is null",
        value: "",
      },
    ]);
    expect(nullSql).toContain("o.`parent_observation_id` is null");
    // no double-quoted identifier (parses as a string literal on the MySQL wire)
    expect(nullSql).not.toContain('"');

    const [userSql] = translate([
      { column: "User ID", type: "string", operator: "=", value: "u1" },
    ]);
    expect(userSql).toContain("t.`user_id` =");
    expect(userSql).not.toContain('"');
  });
});
