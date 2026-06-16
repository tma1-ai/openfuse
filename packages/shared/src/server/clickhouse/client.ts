// ClickHouse is retired on the GreptimeDB backend; the client/connection manager
// is gone. Two ClickHouse-flavoured leftovers survive because the analytics
// repositories still pass them around: a date formatter (CH "YYYY-MM-DD HH:MM:SS"
// shape, still emitted by the read-to-insert converters and a few seed helpers)
// and the read-pool preference union (a now-inert passthrough on repository
// signatures). Both are TIER2 renames (issue #7).

export type PreferredClickhouseService =
  | "ReadWrite"
  | "ReadOnly"
  | "EventsReadOnly";

/**
 * Accepts a JavaScript date and returns the DateTime in format YYYY-MM-DD HH:MM:SS
 */
export const convertDateToClickhouseDateTime = (date: Date): string => {
  // 2024-11-06T20:37:00.123Z -> 2024-11-06 21:37:00.123
  return date.toISOString().replace("T", " ").replace("Z", "");
};
