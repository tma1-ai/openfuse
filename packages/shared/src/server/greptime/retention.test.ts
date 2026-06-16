import { describe, expect, it } from "vitest";

import {
  buildRetentionStatements,
  parseDurationSeconds,
  projectionRetentionTables,
} from "./retention";

const RAW_TABLE = "raw_events";

describe("parseDurationSeconds", () => {
  it("parses single- and multi-unit humantime durations", () => {
    expect(parseDurationSeconds("400d")).toBe(400 * 86400);
    expect(parseDurationSeconds("52w")).toBe(52 * 604800);
    expect(parseDurationSeconds("1y")).toBe(365 * 86400);
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

describe("buildRetentionStatements", () => {
  it("returns no statements when nothing is configured", () => {
    expect(buildRetentionStatements({ rawEventsTable: RAW_TABLE })).toEqual([]);
    expect(
      buildRetentionStatements({
        rawEventsTable: RAW_TABLE,
        rawEventsTtl: "  ",
        projectionTtl: "",
      }),
    ).toEqual([]);
  });

  it("emits SET 'ttl' for raw_events + every projection/EAV table when raw >= projection", () => {
    const stmts = buildRetentionStatements({
      rawEventsTable: RAW_TABLE,
      rawEventsTtl: "400d",
      projectionTtl: "365d",
    });
    // raw_events + 3 projections + 3 metadata + 3 tags = 10 tables.
    expect(stmts).toHaveLength(1 + projectionRetentionTables().length);
    expect(stmts).toHaveLength(10);
    expect(stmts[0]).toBe("ALTER TABLE `raw_events` SET 'ttl'='400d'");
    expect(stmts).toContain("ALTER TABLE `traces` SET 'ttl'='365d'");
    expect(stmts).toContain("ALTER TABLE `scores_tags` SET 'ttl'='365d'");
    expect(stmts.every((s) => s.includes("SET 'ttl'="))).toBe(true);
  });

  it("allows projection TTL with raw_events left forever (forever >= anything)", () => {
    const stmts = buildRetentionStatements({
      rawEventsTable: RAW_TABLE,
      projectionTtl: "365d",
    });
    expect(stmts).toHaveLength(projectionRetentionTables().length);
    expect(stmts.some((s) => s.includes("raw_events"))).toBe(false);
  });

  it("rejects raw_events TTL shorter than projection TTL (invariant 6)", () => {
    expect(() =>
      buildRetentionStatements({
        rawEventsTable: RAW_TABLE,
        rawEventsTtl: "30d",
        projectionTtl: "365d",
      }),
    ).toThrow(/Invariant 6/);
  });

  it("rejects a finite raw_events TTL with projections left forever (invariant 6)", () => {
    expect(() =>
      buildRetentionStatements({
        rawEventsTable: RAW_TABLE,
        rawEventsTtl: "400d",
      }),
    ).toThrow(/Invariant 6/);
  });

  it("accepts equal raw and projection TTLs", () => {
    expect(() =>
      buildRetentionStatements({
        rawEventsTable: RAW_TABLE,
        rawEventsTtl: "365d",
        projectionTtl: "1y",
      }),
    ).not.toThrow();
  });
});
