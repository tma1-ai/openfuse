import type { Connection } from "mysql2/promise";

import { env } from "../../env";
import {
  isValidGreptimeDatabaseName,
  normalizeDuration,
  parseDurationSeconds,
} from "../../utils/greptimeRetentionDuration";
import { logger } from "../logger";

// Re-exported so retention consumers (and the colocated test) keep importing the duration grammar
// from this module; the implementation lives in a pure, env-free util shared with env.ts.
export { normalizeDuration, parseDurationSeconds };

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

const formatDatabaseNameForAlter = (database: string): string => {
  if (!isValidGreptimeDatabaseName(database)) {
    throw new Error(
      `invalid GreptimeDB database name '${database}' for ALTER DATABASE; must start with a lowercase letter or underscore, then lowercase letters, digits, or underscores`,
    );
  }
  return database;
};

/**
 * Build the database-level retention statement. Pure (no IO) and validates the TTL string before
 * it reaches SQL, so it is unit-testable and injection-safe.
 *
 * GreptimeDB v1.1.0 accepts backtick-quoted names for CREATE/USE DATABASE, but ALTER DATABASE
 * forwards a quoted ObjectName as the literal schema name (for example, `openfuse`). Emit a
 * validated unquoted identifier here so schema lookup sees "openfuse".
 */
export const buildDatabaseRetentionStatement = (
  database: string,
  ttl: string,
): string => {
  const normalized = normalizeDuration(ttl);
  parseDurationSeconds(normalized); // validate; throws on a bad/injection-y duration
  return `ALTER DATABASE ${formatDatabaseNameForAlter(database)} SET 'ttl'='${normalized}'`;
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
