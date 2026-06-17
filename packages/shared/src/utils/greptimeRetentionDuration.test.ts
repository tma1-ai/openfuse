import { describe, expect, it } from "vitest";

import {
  isValidGreptimeDatabaseName,
  isValidGreptimeDuration,
} from "./greptimeRetentionDuration";

describe("isValidGreptimeDatabaseName", () => {
  it("accepts unquoted lowercase identifiers", () => {
    expect(isValidGreptimeDatabaseName("openfuse")).toBe(true);
    expect(isValidGreptimeDatabaseName("_internal")).toBe(true);
    expect(isValidGreptimeDatabaseName("db_2")).toBe(true);
  });

  it("rejects names that would need quoting in ALTER DATABASE", () => {
    expect(isValidGreptimeDatabaseName("Openfuse")).toBe(false); // uppercase
    expect(isValidGreptimeDatabaseName("prod-db")).toBe(false); // hyphen
    expect(isValidGreptimeDatabaseName("2db")).toBe(false); // leading digit
    expect(isValidGreptimeDatabaseName("weird`db")).toBe(false); // backtick
    expect(isValidGreptimeDatabaseName("")).toBe(false);
  });
});

describe("isValidGreptimeDuration", () => {
  it("accepts humantime durations", () => {
    expect(isValidGreptimeDuration("730d")).toBe(true);
    expect(isValidGreptimeDuration("104w")).toBe(true);
    expect(isValidGreptimeDuration("2y")).toBe(true);
    expect(isValidGreptimeDuration("1h30m")).toBe(true);
    expect(isValidGreptimeDuration(" 365days ")).toBe(true);
  });

  it("rejects malformed or injection-y durations", () => {
    expect(isValidGreptimeDuration("30x")).toBe(false);
    expect(isValidGreptimeDuration("forever")).toBe(false);
    expect(isValidGreptimeDuration("")).toBe(false);
    expect(isValidGreptimeDuration("1y'; DROP")).toBe(false);
  });
});
