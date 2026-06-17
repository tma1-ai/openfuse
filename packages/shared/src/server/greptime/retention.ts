import type { Connection } from "mysql2/promise";

import { env } from "../../env";
import { logger } from "../logger";
import {
  type GreptimeEntityType,
  metadataTableForEntity,
  projectionTableForEntity,
  quoteIdent,
  tagsTableForEntity,
} from "./schemaUtils";

/**
 * GreptimeDB optional bounded-retention helper (02-write-path.md, invariant 6).
 *
 * Default posture is keep-forever (no TTL). A self-hosted operator who wants to cap disk usage can
 * set the TTL envs; this helper then applies the matching `ALTER TABLE ... SET 'ttl'` to raw_events
 * + the projection + EAV tables. Apply it out of band (or from a bootstrap step) — it is not run
 * automatically on boot.
 *
 * INVARIANT 6 (hard): raw_events TTL >= projection TTL. The worker rebuilds each projection
 * snapshot by replaying the entity's FULL raw_events history; if a `create` event expired from
 * raw_events while its projection survives, a rebuild would silently corrupt the projection. An
 * unset TTL means "forever" (= infinity): raw=forever always satisfies the invariant, but a finite
 * raw_events TTL with projections left at forever would let the projection outlive its source of
 * truth, so that combination is rejected.
 */

const ENTITY_TYPES: readonly GreptimeEntityType[] = [
  "trace",
  "observation",
  "score",
] as const;

/** Every projection + EAV table the projection-snapshot TTL applies to. */
export const projectionRetentionTables = (): string[] =>
  ENTITY_TYPES.flatMap((entity) => [
    projectionTableForEntity[entity],
    metadataTableForEntity[entity],
    tagsTableForEntity[entity],
  ]);

// humantime-style duration units -> seconds. Approximate (y=365d) — only used to order two TTLs for
// the invariant-6 guard, never to compute an exact expiry.
const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
  y: 31536000, year: 31536000, years: 31536000,
}; // prettier-ignore

const DURATION_TOKEN = /(\d+)\s*([a-z]+)/g;

/**
 * Parse a humantime-style duration ("400d", "52w", "1y", "1h30m") to seconds. Doubles as input
 * validation: anything that does not parse cleanly throws, so a bad/injection-y TTL string fails
 * loud rather than skipping the invariant-6 guard or reaching SQL.
 */
/**
 * Normalize a TTL string to the exact form `parseDurationSeconds` validates: trimmed + lowercased.
 * Emitting this (rather than the raw input) into SQL keeps the stored TTL canonical, e.g. "400D" ->
 * "400d", so GreptimeDB sees the same unit casing the validator accepted.
 */
export const normalizeDuration = (raw: string): string =>
  raw.trim().toLowerCase();

export const parseDurationSeconds = (raw: string): number => {
  const normalized = normalizeDuration(raw);
  if (!normalized) throw new Error("empty GreptimeDB TTL duration");

  let total = 0;
  let consumed = "";
  for (const match of normalized.matchAll(DURATION_TOKEN)) {
    const multiplier = UNIT_SECONDS[match[2]];
    if (multiplier === undefined) {
      throw new Error(
        `unsupported GreptimeDB TTL unit '${match[2]}' in '${raw}'`,
      );
    }
    total += Number(match[1]) * multiplier;
    consumed += match[0];
  }
  // Reject leftover characters (e.g. "30x", "1 fortnight") and zero-length matches.
  if (
    total <= 0 ||
    consumed.replace(/\s+/g, "") !== normalized.replace(/\s+/g, "")
  ) {
    throw new Error(
      `could not parse GreptimeDB TTL duration '${raw}' (use e.g. '400d', '52w', '1y')`,
    );
  }
  return total;
};

export type RetentionConfig = {
  /** raw_events TTL; undefined leaves it as-is (forever). */
  rawEventsTtl?: string;
  /** projection + EAV TTL; undefined leaves them as-is (forever). */
  projectionTtl?: string;
  /** raw_events table name (env.GREPTIME_RAW_EVENTS_TABLE). */
  rawEventsTable: string;
};

const ttlAlter = (table: string, ttl: string): string =>
  `ALTER TABLE ${quoteIdent(table)} SET 'ttl'='${ttl}'`;

/**
 * Build the retention `ALTER TABLE ... SET 'ttl'` statements and enforce invariant 6. Pure (no IO)
 * so validation + emission are unit-testable. Returns `[]` when nothing is configured.
 */
export const buildRetentionStatements = (cfg: RetentionConfig): string[] => {
  const rawEventsTtl = cfg.rawEventsTtl?.trim() || undefined;
  const projectionTtl = cfg.projectionTtl?.trim() || undefined;
  if (!rawEventsTtl && !projectionTtl) return [];

  if (projectionTtl) {
    const projectionSecs = parseDurationSeconds(projectionTtl);
    if (rawEventsTtl && parseDurationSeconds(rawEventsTtl) < projectionSecs) {
      throw new Error(
        `Invariant 6 violated: raw_events TTL (${rawEventsTtl}) must be >= projection TTL (${projectionTtl}).`,
      );
    }
    // projectionTtl set with rawEventsTtl unset (forever) is fine: forever >= anything.
  } else if (rawEventsTtl) {
    throw new Error(
      `Invariant 6 violated: a finite raw_events TTL (${rawEventsTtl}) requires a projection TTL ` +
        `(<= it). Leaving projections at 'forever' would let them outlive their raw_events source of truth.`,
    );
  }

  const statements: string[] = [];
  // Emit the normalized duration (the exact form parseDurationSeconds validated), not the raw input.
  if (rawEventsTtl)
    statements.push(
      ttlAlter(cfg.rawEventsTable, normalizeDuration(rawEventsTtl)),
    );
  if (projectionTtl) {
    const normalizedProjectionTtl = normalizeDuration(projectionTtl);
    for (const table of projectionRetentionTables()) {
      statements.push(ttlAlter(table, normalizedProjectionTtl));
    }
  }
  return statements;
};

/**
 * Apply the configured retention TTLs to a GreptimeDB connection. No-op when no TTL is configured
 * (default posture: keep data forever).
 */
export const applyGreptimeRetention = async (
  connection: Pick<Connection, "query">,
  config: RetentionConfig = {
    rawEventsTtl: env.LANGFUSE_GREPTIME_RAW_EVENTS_TTL,
    projectionTtl: env.LANGFUSE_GREPTIME_PROJECTION_TTL,
    rawEventsTable: env.GREPTIME_RAW_EVENTS_TABLE,
  },
): Promise<void> => {
  const statements = buildRetentionStatements(config);
  if (statements.length === 0) {
    logger.info(
      "GreptimeDB retention: no TTL configured; tables keep data indefinitely.",
    );
    return;
  }
  for (const statement of statements) {
    await connection.query(statement);
  }
  logger.info(
    `GreptimeDB retention: applied ${statements.length} TTL statement(s) ` +
      `(raw_events=${config.rawEventsTtl ?? "forever"}, projection=${config.projectionTtl ?? "forever"}).`,
  );
};
