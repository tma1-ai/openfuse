import { quoteIdent } from "../../greptime/schemaUtils";
import { greptimeTimestampLiteral } from "../../greptime/sql/greptime-filter";
import { greptimeQuery } from "../../greptime/client";

/**
 * Shared SQL fragments for the GreptimeDB read repositories (04-read-path.md, P1).
 *
 * Two invariants every projection read carries:
 *   - `AND is_deleted = false` — GreptimeDB soft-deletes via a tombstone row (merge_mode keeps the
 *     last write); ClickHouse physically deleted, so this guard is new and mandatory.
 *   - explicit SELECT lists (the `greptime*Select` builders), never `SELECT *` — a bare JSON column
 *     comes back as raw jsonb bytes over the MySQL wire (see rowContract).
 */

/** `is_deleted = false` guard, optionally aliased (`t.is_deleted = false`). */
export const notDeleted = (prefix?: string): string =>
  `${prefix ? `${prefix}.` : ""}${quoteIdent("is_deleted")} = false`;

/**
 * Expand an array into a named IN-list (mysql2 does not splice arrays into named placeholders).
 * Empty list -> `1 = 0` (matches nothing), so callers that must short-circuit should guard before.
 */
export const greptimeInClause = (
  ref: string,
  values: readonly (string | number)[],
  prefix: string,
): { sql: string; params: Record<string, string | number> } => {
  if (values.length === 0) return { sql: "1 = 0", params: {} };
  const params: Record<string, string | number> = {};
  const placeholders = values.map((v, i) => {
    const name = `${prefix}_${i}`;
    params[name] = v;
    return `:${name}`;
  });
  return {
    sql: `${quoteColumnRef(ref)} IN (${placeholders.join(", ")})`,
    params,
  };
};

const quoteColumnRef = (ref: string): string => {
  const segments = ref.split(".");
  if (segments.length === 1) return quoteIdent(ref);
  const column = segments.at(-1);
  if (!column) return ref;
  return `${segments.slice(0, -1).join(".")}.${quoteIdent(column)}`;
};

/** Bind a Date as a ms-precision GreptimeDB timestamp literal (string -> TIMESTAMP coercion). */
export const greptimeTsParam = (d: Date): string => greptimeTimestampLiteral(d);

/**
 * Earliest trace `timestamp` for a finite set of session/user ids, scoped by `project_id` and pruned
 * by the bloom skipping index on `scopeColumn` (04-read-path.md, migration 0006). Returns null when the
 * set has no live traces.
 *
 * Why: the all-time metrics reads (`getSessionsWithMetricsGreptime` with an id-only filter,
 * `getUserMetrics` with an empty filter) pass no UI timestamp bound. After the join-pushdown fix the
 * `traces` side prunes via the `session_id`/`user_id` bloom index, but the `observations` side then has
 * no index-eligible predicate. Feeding `min(timestamp) - INTERVAL` as an `observations.start_time` lower
 * bound restores TIME-INDEX pruning there.
 *
 * IMPORTANT — this is a DELIBERATE lookback-bounded narrowing, NOT strict all-time equivalence: it drops
 * observations whose `start_time` precedes the group's earliest trace by more than the caller's INTERVAL
 * (pathological clock skew > INTERVAL or a back-dated import; for sane data the dropped set is empty).
 * It mirrors the exact heuristic the windowed metrics path already applies (`obsLookback = tsFilter -
 * INTERVAL`). Callers subtract their own INTERVAL and must document the trade-off.
 */
export const deriveTraceMinTimestamp = async (
  projectId: string,
  scopeColumn: "session_id" | "user_id",
  ids: readonly string[],
): Promise<Date | null> => {
  if (ids.length === 0) return null;
  const inClause = greptimeInClause(scopeColumn, ids, "scope");
  const rows = await greptimeQuery<{ min_ts: Date | string | null }>({
    query: `SELECT min(${quoteIdent("timestamp")}) AS min_ts FROM traces
      WHERE ${quoteIdent("project_id")} = :projectId AND ${inClause.sql} AND ${notDeleted()}`,
    params: { projectId, ...inClause.params },
    readOnly: true,
  });
  const v = rows[0]?.min_ts;
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
};

/** UTC calendar-day bounds [start, end) for a same-day match, as ms-precision literals. */
export const greptimeDayBounds = (d: Date): { start: string; end: string } => {
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: greptimeTimestampLiteral(start),
    end: greptimeTimestampLiteral(end),
  };
};
