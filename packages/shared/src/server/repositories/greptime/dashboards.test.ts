import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ greptimeQuery: vi.fn() }));

vi.mock("../../greptime/client", () => ({
  greptimeQuery: mocks.greptimeQuery,
}));

import {
  getObservationCostByTypeByTimeGreptime,
  getObservationUsageByTypeByTimeGreptime,
} from "./dashboards";

describe("getObservation*ByTypeByTime (long-tail usage/cost)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates dynamic keys via GROUP BY key on the EAV table and gap-fills", async () => {
    const bucketSizeSeconds = 3600;
    const fromTime = 0;
    const toTime = 5_400_000; // 1.5h -> aligned buckets at 0 and 3_600_000

    // First bucket carries a standard key plus a project custom key; the second bucket only the
    // standard key, so the custom key must be gap-filled to 0 there.
    mocks.greptimeQuery.mockResolvedValueOnce([
      { bucket: new Date(0), detail_key: "input", sum: 10 },
      { bucket: new Date(0), detail_key: "cache_read", sum: 5 },
      { bucket: new Date(3_600_000), detail_key: "input", sum: 7 },
    ]);

    const result = await getObservationUsageByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime,
      toTime,
      bucketSizeSeconds,
    });

    // De-narrowed query: groups by the dynamic key on the EAV table, filtered by kind.
    const call = mocks.greptimeQuery.mock.calls[0]![0];
    expect(call.query).toContain("FROM observations_usage_cost uc");
    expect(call.query).toContain("uc.`kind` = :kind");
    expect(call.query).toMatch(/GROUP BY bucket, uc\.`key`/);
    expect((call.params as Record<string, unknown>).kind).toBe("usage");

    const at = (bucketMs: number, key: string) =>
      result.find(
        (r) => r.intervalStart.getTime() === bucketMs && r.key === key,
      )?.sum;
    // Both keys present (custom key not dropped), gap-filled across both buckets.
    expect(at(0, "input")).toBe(10);
    expect(at(0, "cache_read")).toBe(5);
    expect(at(3_600_000, "input")).toBe(7);
    expect(at(3_600_000, "cache_read")).toBe(0);
  });

  it("passes kind='cost' for the cost wrapper", async () => {
    mocks.greptimeQuery.mockResolvedValueOnce([]);
    await getObservationCostByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime: 0,
      toTime: 3_600_000,
      bucketSizeSeconds: 3600,
    });
    const call = mocks.greptimeQuery.mock.calls[0]![0];
    expect((call.params as Record<string, unknown>).kind).toBe("cost");
  });

  it("drops keys whose sum is zero everywhere (mirror CH 'types present in data')", async () => {
    mocks.greptimeQuery.mockResolvedValueOnce([
      { bucket: new Date(0), detail_key: "input", sum: 10 },
      { bucket: new Date(0), detail_key: "audio", sum: 0 },
    ]);
    const result = await getObservationUsageByTypeByTimeGreptime({
      projectId: "p1",
      filter: [],
      fromTime: 0,
      toTime: 3_600_000,
      bucketSizeSeconds: 3600,
    });
    expect(result.some((r) => r.key === "audio")).toBe(false);
    expect(result.some((r) => r.key === "input")).toBe(true);
  });
});
