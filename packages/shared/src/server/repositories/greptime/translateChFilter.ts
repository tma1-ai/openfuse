import {
  ArrayOptionsFilter as ChArrayOptionsFilter,
  BooleanFilter as ChBooleanFilter,
  CategoryOptionsFilter as ChCategoryOptionsFilter,
  DateTimeFilter as ChDateTimeFilter,
  type Filter as ChFilter,
  type FilterList as ChFilterList,
  NullFilter as ChNullFilter,
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
  type CompiledFilter,
  DateTimeFilter,
  FilterList,
  type GreptimeFilter,
  NullFilter,
  NumberFilter,
  NumberObjectFilter,
  type ScoreGrain,
  ScoreNumberObjectFilter,
  StringFilter,
  StringObjectFilter,
  StringOptionsFilter,
  ToolNameOptionsFilter,
} from "../../greptime/sql/greptime-filter";
import { filterOperators } from "../../../interfaces/filters";
import { sqlSafeRandomCharacters } from "../dbUtils";
import { InvalidRequestError } from "../../../errors";
import { tracesTableUiColumnDefinitions } from "../../tableMappings/mapTracesTable";
import {
  OBSERVATIONS_TOOL_CALLS_TABLE,
  OBSERVATIONS_TOOL_DEFINITIONS_TABLE,
  tracesTableGreptimeColumnDefinitions,
} from "../../greptime/sql/columnMappings";

/**
 * Translate a *compiled* ClickHouse `FilterList` (the kind the public-API web wrappers build via
 * `deriveFilters` and hand to the repository generators) onto the equivalent GreptimeDB `FilterList`
 * (04-read-path.md, P5). Promoted + generalised from the P4 daily-metrics `chToGreptimeFilter`.
 *
 * It is **field-routed, not blindly by-class** so it can never silently mis-translate a rollup-score
 * filter (Codex P5 review #3):
 *   - self-contained scalar/EAV classes (String/Number/DateTime/Boolean/Null/StringOptions/
 *     ArrayOptions/StringObject + metadata NumberObject) map 1:1 using the CH filter's own
 *     field/table/prefix/operator/value(s)/key.
 *   - rollup-score classes — CH `CategoryOptionsFilter` (`score_categories`) and a CH
 *     `NumberObjectFilter` on `scores_avg` — have no per-row column on the merged projection; they
 *     route to a correlated score-grain `EXISTS`. The grain is supplied by the **caller's entity**
 *     (a traces generator filters by `trace_id`, observations by `observation_id`), passed as
 *     `opts.scoreGrain`. With no grain in context they throw loud rather than mis-filter.
 *
 * The public-API simple-param surface only ever produces the self-contained classes; rollup-score
 * filters are reachable only via an advanced `?filter=` JSON on traces/observations and require the
 * caller to pass the entity grain.
 */

export type TranslateChFilterOptions = {
  /** Entity grain for rollup-score filters (`scores_avg` / `score_categories`). */
  scoreGrain?: ScoreGrain;
};

// Columns carrying a FULLTEXT index (migration 0004): the FTS match operator can use matches_term.
const FULLTEXT_COLUMNS: Record<string, ReadonlySet<string>> = {
  traces: new Set(["input", "output"]),
  observations: new Set(["input", "output"]),
};
const isFullTextColumn = (table: string, field: string): boolean =>
  FULLTEXT_COLUMNS[table]?.has(field) ?? false;

// Rollup-score column refs that only exist as a materialised array in the CH UI CTE.
const ROLLUP_SCORE_FIELDS = new Set(["scores_avg", "score_categories"]);

/**
 * Tool-name array columns: the compiled CH `ArrayOptionsFilter` carries the `clickhouseSelect`
 * expression as `field` (`mapKeys(tool_definitions)` / `tool_call_names`, optionally `o.`-prefixed),
 * meaningless to GreptimeDB. Detect them by the underlying column and route to the EAV EXISTS table.
 */
const toolNameEavTableForField = (field: string): string | null => {
  if (field.includes("tool_definitions")) {
    return OBSERVATIONS_TOOL_DEFINITIONS_TABLE;
  }
  if (field.includes("tool_call_names")) return OBSERVATIONS_TOOL_CALLS_TABLE;
  return null;
};

const requireGrain = (
  opts: TranslateChFilterOptions,
  filterName: string,
): ScoreGrain => {
  if (!opts.scoreGrain) {
    throw new Error(
      `Cannot translate rollup-score filter (${filterName}) to GreptimeDB without an entity scoreGrain; ` +
        `the caller must pass opts.scoreGrain (e.g. { scoresColumn: 'trace_id', outerPrefix: 't', outerColumn: 'id' }).`,
    );
  }
  return opts.scoreGrain;
};

/** Map one compiled ClickHouse filter onto its GreptimeDB equivalent. */
export const chFilterToGreptime = (
  f: ChFilter,
  opts: TranslateChFilterOptions = {},
): GreptimeFilter => {
  const table = f.clickhouseTable;
  const tablePrefix = f.tablePrefix;

  if (f instanceof ChStringFilter) {
    return new StringFilter({
      table,
      field: f.field,
      operator: f.operator,
      value: f.value,
      tablePrefix,
      emptyEqualsNull: f.emptyEqualsNull,
      fullTextIndexed: isFullTextColumn(table, f.field),
    });
  }
  if (f instanceof ChStringOptionsFilter) {
    return new StringOptionsFilter({
      table,
      field: f.field,
      operator: f.operator,
      values: f.values,
      tablePrefix,
      emptyEqualsNull: f.emptyEqualsNull,
    });
  }
  if (f instanceof ChArrayOptionsFilter) {
    // toolNames / calledToolNames -> project-scoped EAV EXISTS over the observation tool tables;
    // CH's `mapKeys(tool_definitions)` / `tool_call_names` array predicate is not a GreptimeDB column.
    const toolEavTable = toolNameEavTableForField(f.field);
    if (toolEavTable) {
      return new ToolNameOptionsFilter({
        table,
        field: f.field,
        eavTable: toolEavTable,
        operator: f.operator,
        values: f.values,
        tablePrefix,
      });
    }
    return new ArrayOptionsFilter({
      table,
      field: f.field,
      operator: f.operator,
      values: f.values,
      tablePrefix,
    });
  }
  if (f instanceof ChDateTimeFilter) {
    return new DateTimeFilter({
      table,
      field: f.field,
      operator: f.operator,
      value: f.value,
      tablePrefix,
    });
  }
  if (f instanceof ChNumberFilter) {
    return new NumberFilter({
      table,
      field: f.field,
      operator: f.operator,
      value: f.value,
      tablePrefix,
    });
  }
  if (f instanceof ChBooleanFilter) {
    return new BooleanFilter({
      table,
      field: f.field,
      operator: f.operator,
      value: f.value,
      tablePrefix,
    });
  }
  if (f instanceof ChNullFilter) {
    return new NullFilter({
      table,
      field: f.field,
      operator: f.operator,
      tablePrefix,
      emptyEqualsNull: f.emptyEqualsNull,
    });
  }
  if (f instanceof ChStringObjectFilter) {
    // metadata key/value -> project-scoped EAV EXISTS over `<table>_metadata`.
    return new StringObjectFilter({
      table,
      field: f.field,
      operator: f.operator,
      key: f.key,
      value: f.value,
      tablePrefix,
    });
  }
  if (f instanceof ChNumberObjectFilter) {
    // `scores_avg` -> rollup score-grain EXISTS; any other field -> numeric metadata EAV EXISTS.
    if (ROLLUP_SCORE_FIELDS.has(f.field)) {
      return new ScoreNumberObjectFilter({
        key: f.key,
        value: f.value,
        operator: f.operator,
        grain: requireGrain(opts, "NumberObjectFilter[scores_avg]"),
      });
    }
    return new NumberObjectFilter({
      table,
      field: f.field,
      operator: f.operator,
      key: f.key,
      value: f.value,
      tablePrefix,
    });
  }
  if (f instanceof ChCategoryOptionsFilter) {
    // `score_categories` -> rollup score-grain EXISTS.
    return new CategoryOptionsFilter({
      key: f.key,
      values: f.values,
      operator: f.operator,
      grain: requireGrain(opts, "CategoryOptionsFilter"),
    });
  }

  throw new Error(
    `Unsupported ClickHouse filter for GreptimeDB translation: ${f.constructor.name}`,
  );
};

/** Translate an entire compiled ClickHouse `FilterList` to a GreptimeDB `FilterList`. */
export const translateChFilterList = (
  list: ChFilterList,
  opts: TranslateChFilterOptions = {},
): FilterList => {
  const out = new FilterList();
  list.forEach((f) => out.push(chFilterToGreptime(f, opts)));
  return out;
};

/**
 * CH `clickhouseSelect` (the `field` a compiled observation-aggregate trace filter carries) ->
 * the `observations_stats` CTE alias, joined by the shared `uiTableId` between the CH
 * `tracesTableUiColumnDefinitions` and the GreptimeDB `tracesTableGreptimeColumnDefinitions`. Keeps
 * both source-of-truth column tables authoritative: a new obs rollup column is picked up here once it
 * exists in both.
 */
const OBS_AGG_FIELD_TO_GREPTIME: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const ch of tracesTableUiColumnDefinitions) {
    if (ch.clickhouseTableName !== "observations") continue;
    const greptime = tracesTableGreptimeColumnDefinitions.find(
      (g) =>
        g.uiTableId === ch.uiTableId && g.greptimeTableName === "observations",
    );
    if (greptime) map.set(ch.clickhouseSelect, greptime.greptimeSelect);
  }
  return map;
})();

const AGGREGATED_LEVEL_ALIAS = "o.aggregated_level";

/**
 * CH-parity `aggregated_level` StringOptions predicate. The CTE alias is NULL for a zero-observation
 * trace (LEFT JOIN to `observations_stats`); ClickHouse, by contrast, sees an empty aggregated level
 * for such a trace, so `none of [...]` includes it. To match that:
 *   - `none of`: `(<col> NOT IN (..) OR <col> IS NULL)` — includes traces with no matching level AND
 *     zero-observation traces (NULL).
 *   - `any of`:  plain `<col> IN (..)` — NULL stays excluded; a zero-obs trace has no level so it must
 *     not match any-of.
 * Built as a tiny inline filter rather than reusing `StringOptionsFilter`, whose only NULL-inclusion
 * path is keyed on `emptyEqualsNull`/empty-string membership and would not cover the LEFT-JOIN NULL.
 */
class AggregatedLevelOptionsFilter implements GreptimeFilter {
  public readonly table = "observations";
  public readonly tablePrefix = undefined;
  constructor(
    public readonly field: string,
    public readonly operator: (typeof filterOperators.stringOptions)[number],
    private readonly values: string[],
  ) {}

  apply(): CompiledFilter {
    const params: Record<string, unknown> = {};
    if (this.values.length === 0) {
      return {
        query: this.operator === "any of" ? "1 = 0" : "1 = 1",
        params,
      };
    }
    const list = this.values
      .map((val) => {
        const name = `v${sqlSafeRandomCharacters()}`;
        params[name] = val;
        return `:${name}`;
      })
      .join(", ");
    const query =
      this.operator === "any of"
        ? `${this.field} IN (${list})`
        : `(${this.field} NOT IN (${list}) OR ${this.field} IS NULL)`;
    return { query, params };
  }
}

/**
 * Remap one compiled observation-aggregate ClickHouse filter (`clickhouseTable === "observations"`
 * on the traces surface) onto a GreptimeDB predicate over the `observations_stats` CTE (alias `o`).
 *
 * Why this is separate from `chFilterToGreptime`: the CH filter's `field` is the CH `clickhouseSelect`
 * expression (e.g. `arraySum(mapValues(...))`), meaningless to GreptimeDB. `chFilterToGreptime`
 * passes `field` through verbatim, which would leak CH SQL (Codex #3) — so we resolve the CTE alias
 * and emit against that instead. Numeric aggregates are wrapped in `COALESCE(..., 0)` so a
 * zero-observation trace (NULL after the LEFT JOIN to `observations_stats`) still participates in
 * `= 0` / `!=` / `none of` (Codex #4). The non-numeric `aggregated_level` column is left un-COALESCEd,
 * but its `none of` predicate folds in `IS NULL` so a zero-observation trace is still included (CH
 * parity); `any of` keeps NULL excluded (a trace with no observations has no level to match).
 */
export const remapObsAggregateFilter = (f: ChFilter): GreptimeFilter => {
  const alias = OBS_AGG_FIELD_TO_GREPTIME.get(f.field);
  if (!alias) {
    throw new InvalidRequestError(
      `Unsupported observation filter column on the traces API: ${f.field}`,
    );
  }
  // `field` is a baked SQL expression, so tablePrefix stays undefined: the greptime emitter renders
  // a non-bare field verbatim (see `col()` in greptime-filter.ts).
  const isAggregatedLevel = alias === AGGREGATED_LEVEL_ALIAS;
  const field = isAggregatedLevel ? alias : `COALESCE(${alias}, 0)`;
  if (isAggregatedLevel && f instanceof ChStringOptionsFilter) {
    return new AggregatedLevelOptionsFilter(field, f.operator, f.values);
  }
  if (f instanceof ChNumberFilter) {
    return new NumberFilter({
      table: "observations",
      field,
      operator: f.operator,
      value: f.value,
    });
  }
  if (f instanceof ChStringFilter) {
    return new StringFilter({
      table: "observations",
      field,
      operator: f.operator,
      value: f.value,
    });
  }
  if (f instanceof ChStringOptionsFilter) {
    return new StringOptionsFilter({
      table: "observations",
      field,
      operator: f.operator,
      values: f.values,
    });
  }
  throw new InvalidRequestError(
    `Unsupported observation filter type on the traces API: ${f.constructor.name}`,
  );
};
