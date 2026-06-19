/**
 * Pure validators for GreptimeDB database-retention configuration: the TTL duration string and the
 * target database identifier.
 *
 * Kept env-free and IO-free so two layers can share one grammar without a circular import:
 *   - boot-time fail-fast validation in the env schema (`packages/shared/src/env.ts`), and
 *   - the retention SQL builder (`src/server/greptime/retention.ts`).
 *
 * env.ts must not import the retention module (it pulls in mysql2/logger and itself imports env),
 * so the shared parsing rules live here, alongside the existing `./utils` helpers env already
 * depends on.
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
 * GreptimeDB unquoted database identifier. ALTER DATABASE forwards a quoted ObjectName as the
 * literal schema name (for example, `openfuse`), so the configured database must be a bare
 * identifier that needs no quoting.
 */
export const GREPTIME_UNQUOTED_DATABASE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const isValidGreptimeDatabaseName = (database: string): boolean =>
  GREPTIME_UNQUOTED_DATABASE_IDENTIFIER.test(database);

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

/** Boolean form of `parseDurationSeconds`, for zod `.refine` at env-parse time. */
export const isValidGreptimeDuration = (raw: string): boolean => {
  try {
    parseDurationSeconds(raw);
    return true;
  } catch {
    return false;
  }
};
