import { describe, expect, it } from "vitest";

import {
  buildDatabaseRetentionStatement,
  parseDurationSeconds,
} from "./retention";

describe("parseDurationSeconds", () => {
  it("parses single- and multi-unit humantime durations", () => {
    expect(parseDurationSeconds("730d")).toBe(730 * 86400);
    expect(parseDurationSeconds("104w")).toBe(104 * 604800);
    expect(parseDurationSeconds("2y")).toBe(2 * 365 * 86400);
    expect(parseDurationSeconds("1h30m")).toBe(3600 + 30 * 60);
    expect(parseDurationSeconds(" 365days ")).toBe(365 * 86400);
  });

  it("throws on unparseable or unsupported durations", () => {
    expect(() => parseDurationSeconds("30x")).toThrow();
    expect(() => parseDurationSeconds("forever")).toThrow();
    expect(() => parseDurationSeconds("")).toThrow();
    expect(() => parseDurationSeconds("1 fortnight")).toThrow();
  });
});

describe("buildDatabaseRetentionStatement", () => {
  it("emits a database-level ALTER for the given db and ttl", () => {
    expect(buildDatabaseRetentionStatement("openfuse", "730d")).toBe(
      "ALTER DATABASE openfuse SET 'ttl'='730d'",
    );
  });

  it("normalizes (trims + lowercases) the duration into SQL", () => {
    expect(buildDatabaseRetentionStatement("openfuse", " 730D ")).toBe(
      "ALTER DATABASE openfuse SET 'ttl'='730d'",
    );
  });

  it("rejects database names that would require quoting in ALTER DATABASE", () => {
    expect(() => buildDatabaseRetentionStatement("weird`db", "1y")).toThrow(
      /invalid GreptimeDB database name/,
    );
    expect(() => buildDatabaseRetentionStatement("prod-db", "1y")).toThrow(
      /invalid GreptimeDB database name/,
    );
  });

  it("rejects an invalid / injection-y duration before it reaches SQL", () => {
    expect(() =>
      buildDatabaseRetentionStatement("openfuse", "1y'; DROP"),
    ).toThrow();
    expect(() =>
      buildDatabaseRetentionStatement("openfuse", "forever"),
    ).toThrow();
    expect(() => buildDatabaseRetentionStatement("openfuse", "")).toThrow();
  });
});
