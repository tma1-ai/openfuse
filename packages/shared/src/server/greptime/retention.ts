import type { Connection } from "mysql2/promise";

import { env } from "../../env";
import { logger } from "../logger";
import { quoteIdent } from "./schemaUtils";

/**
 * GreptimeDB database-level retention (TTL).
 *
 * A single database TTL applies to every table in the GreptimeDB database — raw_events, the
 * projection snapshots, and the EAV tables — so the whole store shares one expiry horizon. Default
 * is 730d (2 years); an operator changes retention for everything at once with a single
 * `ALTER DATABASE ... SET 'ttl'`. It is applied idempotently at schema bootstrap
 * (`applyGreptimeMigrations`).
 *
 * One shared horizon keeps the projection-rebuild contract simple: a projection is rebuilt by
 * replaying the entity's raw_events history, and with raw_events and projections expiring at the
 * same age a projection does not outlive raw_events written at the same time. (GreptimeDB measures
 * TTL per row from the row timestamp, so a raw `create` event written earlier than the entity's
 * latest projection update can expire slightly sooner. Operators who need a strict
 * raw_events >= projection margin can give raw_events a longer table-level TTL, which takes
 * precedence over the database TTL.)
 */

// humantime-style duration units -> seconds. Approximate (y=365d) — used only to validate that the
// TTL string parses, never to compute an exact expiry.
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
 * Normalize a TTL string to the exact form `parseDurationSeconds` validates: trimmed + lowercased.
 * Emitting this (rather than the raw input) into SQL keeps the stored TTL canonical, e.g. "730D" ->
 * "730d".
 */
export const normalizeDuration = (raw: string): string =>
  raw.trim().toLowerCase();

/**
 * Parse a humantime-style duration ("730d", "104w", "2y", "1h30m") to seconds. Doubles as input
 * validation: anything that does not parse cleanly throws, so a bad/injection-y TTL string fails
 * loud rather than reaching SQL.
 */
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
      `could not parse GreptimeDB TTL duration '${raw}' (use e.g. '730d', '104w', '2y')`,
    );
  }
  return total;
};

/**
 * Build the database-level retention statement. Pure (no IO) and validates the TTL string before
 * it reaches SQL, so it is unit-testable and injection-safe.
 */
export const buildDatabaseRetentionStatement = (
  database: string,
  ttl: string,
): string => {
  const normalized = normalizeDuration(ttl);
  parseDurationSeconds(normalized); // validate; throws on a bad/injection-y duration
  return `ALTER DATABASE ${quoteIdent(database)} SET 'ttl'='${normalized}'`;
};

/**
 * Apply the configured database-level retention TTL to a GreptimeDB connection. The connection must
 * already target (or be able to target) the database; the statement names it explicitly.
 */
export const applyGreptimeRetention = async (
  connection: Pick<Connection, "query">,
  database: string = env.GREPTIME_DB,
  ttl: string = env.LANGFUSE_GREPTIME_TTL,
): Promise<void> => {
  const statement = buildDatabaseRetentionStatement(database, ttl);
  await connection.query(statement);
  logger.info(
    `GreptimeDB retention: database '${database}' ttl=${normalizeDuration(ttl)}.`,
  );
};
