import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ greptimeQuery: vi.fn() }));

vi.mock("../../greptime/client", () => ({
  greptimeQuery: mocks.greptimeQuery,
}));

import { type FilterState } from "../../../types";
import {
  getObservationCostByTypeByTimeGreptime,
  getObservationUsageByTypeByTimeGreptime,
} from "./dashboards";

// The by-type read issues two queries in order: Q1 = standard input/output/total from the
// observations JSON columns (wide rows), Q2 = custom keys from the observations_usage_cost EAV
// table (long rows). This helper mocks that pair.
const mockDualRead = (
  known: Array<Record<string, unknown>>,
  custom: Array<Record<string, unknown>>,
) => {
  mocks.greptimeQuery
    .mockResolvedValueOnce(known) // Q1 (JSON known keys)
    .mockResolvedValueOnce(custom); // Q2 (EAV custom keys)
};

describe("getObservation*ByTypeByTime (dual-read: JSON known + EAV custom)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges standard keys from JSON with custom keys from the EAV table and gap-fills", async () => {
    const bucketSizeSeconds = 3600;
    const fromTime = 0;
    const toTime = 5_400_000; // 1.5h -> aligned buckets at 0 and 3_600_000

    mockDualRead(
      [
        {
          bucket: new Date(0),
          usage_input: 10,
          usage_output: 0,
          usage_total: 30,
        },
        {
          bucket: new Date(3_600_000),
          usage_input: 7,
          usage_output: 0,
          usage_total: 7,
        },
      ],
      // custom key only present in the first bucket -> must gap-fill to 0 in the second.
      [{ bucket: new Date(0), detail_key: "cache_read", sum: 5 }],
    );

    const result = await getObservationUsageByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime,
      toTime,
      bucketSizeSeconds,
    });

    // Q1 reads the JSON columns (no EAV); Q2 reads the EAV table excluding the standard keys.
    const q1 = mocks.greptimeQuery.mock.calls[0]![0];
    const q2 = mocks.greptimeQuery.mock.calls[1]![0];
    expect(q1.query).toContain("json_get_float(o.usage_details");
    expect(q1.query).not.toContain("observations_usage_cost");
    expect(q2.query).toContain("FROM observations_usage_cost uc");
    expect(q2.query).toContain("uc.`kind` = :kind");
    expect(q2.query).toContain("uc.`key` NOT IN ('input', 'output', 'total')");
    expect((q2.params as Record<string, unknown>).kind).toBe("usage");

    const at = (bucketMs: number, key: string) =>
      result.find(
        (r) => r.intervalStart.getTime() === bucketMs && r.key === key,
      )?.sum;
    // standard keys from Q1 (present for all data); custom key from Q2
    expect(at(0, "input")).toBe(10);
    expect(at(0, "total")).toBe(30);
    expect(at(0, "cache_read")).toBe(5);
    expect(at(3_600_000, "input")).toBe(7);
    expect(at(3_600_000, "cache_read")).toBe(0); // gap-filled
    // 'output' summed to 0 in every bucket -> dropped
    expect(result.some((r) => r.key === "output")).toBe(false);
  });

  it("passes kind='cost' / cost_details to both queries for the cost wrapper", async () => {
    mockDualRead([], []);
    await getObservationCostByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime: 0,
      toTime: 3_600_000,
      bucketSizeSeconds: 3600,
    });
    const q1 = mocks.greptimeQuery.mock.calls[0]![0];
    const q2 = mocks.greptimeQuery.mock.calls[1]![0];
    expect(q1.query).toContain("json_get_float(o.cost_details");
    expect((q2.params as Record<string, unknown>).kind).toBe("cost");
  });

  it("drops keys whose sum is zero everywhere (mirror CH 'types present in data')", async () => {
    mockDualRead(
      [
        {
          bucket: new Date(0),
          usage_input: 10,
          usage_output: 0,
          usage_total: 0,
        },
      ],
      [{ bucket: new Date(0), detail_key: "audio", sum: 0 }],
    );
    const result = await getObservationUsageByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime: 0,
      toTime: 3_600_000,
      bucketSizeSeconds: 3600,
    });
    expect(result.some((r) => r.key === "audio")).toBe(false);
    expect(result.some((r) => r.key === "output")).toBe(false);
    expect(result.some((r) => r.key === "input")).toBe(true);
  });
});

describe("getObservation*ByTypeByTime: Q2 observations join is conditional", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Returns the Q2 (EAV) SQL produced for a given filter state.
  const q2For = async (filter: FilterState): Promise<string> => {
    mockDualRead([], []);
    await getObservationUsageByTypeByTimeGreptime({
      projectId: "p1",
      filter,
      fromTime: 0,
      toTime: 3_600_000,
      bucketSizeSeconds: 3600,
    });
    return mocks.greptimeQuery.mock.calls[1]![0].query as string;
  };

  it("skips the observations join when no observation/trace/environment filter is present", async () => {
    const q2 = await q2For([]);
    expect(q2).toContain("FROM observations_usage_cost uc");
    expect(q2).not.toContain("JOIN observations o");
    expect(q2).not.toContain("JOIN traces");
    // No dangling observations/traces alias may leak into SELECT/WHERE/GROUP BY once the joins drop.
    expect(q2).not.toMatch(/\bo\./);
    expect(q2).not.toMatch(/\bt\./);
    // Deletion is still guarded -- by the EAV flag alone, which the writer keeps in sync.
    expect(q2).toContain("uc.`is_deleted` = false");
  });

  it("keeps the observations join for an environment filter (EAV table has no environment column)", async () => {
    const q2 = await q2For([
      {
        type: "stringOptions",
        column: "environment",
        operator: "any of",
        value: ["production"],
      },
    ]);
    expect(q2).toContain("JOIN observations o");
  });

  it("keeps the observations join for an observation-level filter", async () => {
    const q2 = await q2For([
      { type: "string", column: "type", operator: "=", value: "GENERATION" },
    ]);
    expect(q2).toContain("JOIN observations o");
  });

  it("keeps both joins for a trace-level filter", async () => {
    const q2 = await q2For([
      { type: "string", column: "userId", operator: "=", value: "u1" },
    ]);
    expect(q2).toContain("JOIN observations o");
    expect(q2).toContain("LEFT JOIN traces t");
  });
});
