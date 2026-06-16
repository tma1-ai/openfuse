// ClickHouse is retired on the GreptimeDB backend; the client/connection manager
// is gone. One ClickHouse-flavoured leftover survives because the analytics
// repositories still emit it: a date formatter (CH "YYYY-MM-DD HH:MM:SS" shape,
// still produced by the read-to-insert converters and a few seed helpers). It is
// a TIER2 rename (issue #7).

/**
 * Accepts a JavaScript date and returns the DateTime in format YYYY-MM-DD HH:MM:SS
 */
export const convertDateToClickhouseDateTime = (date: Date): string => {
  // 2024-11-06T20:37:00.123Z -> 2024-11-06 21:37:00.123
  return date.toISOString().replace("T", " ").replace("Z", "");
};
