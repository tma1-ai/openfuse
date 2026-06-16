// The ClickHouse client/connection manager is gone on the GreptimeDB backend.
// One date formatter survives here because the read-to-insert converters and a
// few seed helpers still emit the "YYYY-MM-DD HH:MM:SS" wire shape.

/**
 * Accepts a JavaScript date and returns the DateTime in format YYYY-MM-DD HH:MM:SS
 */
export const convertDateToDbDateTime = (date: Date): string => {
  // 2024-11-06T20:37:00.123Z -> 2024-11-06 20:37:00.123
  return date.toISOString().replace("T", " ").replace("Z", "");
};
