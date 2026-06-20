import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Spy on the GreptimeDB read channel and the metric emitter; keep every other shared export real
// (RedisLock, logger, instrumentAsync, ...).
const mocks = vi.hoisted(() => ({
  greptimeQuery: vi.fn(),
  recordGauge: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    greptimeQuery: mocks.greptimeQuery,
    recordGauge: mocks.recordGauge,
  };
});

import type { LockAcquireResult } from "../../utils/RedisLock";
import { GreptimeStatsRunner } from "./index";

type GaugeCall = [string, number, Record<string, string>];

const buildRunner = (acquire: LockAcquireResult) => {
  const runner = new GreptimeStatsRunner();
  // The cooldown lock is the only Redis touchpoint; drive its outcome directly so the test never
  // needs a live Redis.
  vi.spyOn(
    (runner as unknown as { lock: { acquire: Mock } }).lock,
    "acquire",
  ).mockResolvedValue(acquire);
  return runner;
};

const gaugeCall = (stat: string, table: string): GaugeCall | undefined =>
  (mocks.recordGauge.mock.calls as GaugeCall[]).find(
    (c) => c[0] === stat && c[2]?.table === table,
  );

beforeEach(() => {
  mocks.greptimeQuery.mockReset();
  mocks.recordGauge.mockReset();
});

describe("GreptimeStatsRunner", () => {
  it("emits five per-table gauges and coerces string-typed counters", async () => {
    // Counters arrive as strings over the MySQL wire (BIGINT precision); sst_num_max is the
    // per-region maximum that the 384-file wall is measured against.
    mocks.greptimeQuery.mockResolvedValue([
      {
        table_name: "observations_usage_cost",
        sst_num_max: "9",
        sst_num_sum: "12",
        region_rows: "4000000",
        disk_size: "1024",
        memtable_size: "0",
      },
      {
        table_name: "observations",
        sst_num_max: 2,
        sst_num_sum: 2,
        region_rows: 3500000,
        disk_size: 2048,
        memtable_size: 16,
      },
    ]);

    await buildRunner("acquired").processBatch();

    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(1);
    expect(mocks.greptimeQuery.mock.calls[0][0]).toMatchObject({
      readOnly: true,
    });
    // 2 tables * 5 gauges.
    expect(mocks.recordGauge).toHaveBeenCalledTimes(10);

    expect(
      gaugeCall("langfuse.greptime.sst_files_max", "observations_usage_cost"),
    ).toEqual([
      "langfuse.greptime.sst_files_max",
      9,
      { table: "observations_usage_cost", unit: "files" },
    ]);
    expect(
      gaugeCall("langfuse.greptime.sst_files", "observations_usage_cost")?.[1],
    ).toBe(12);
    expect(
      gaugeCall(
        "langfuse.greptime.region_rows",
        "observations_usage_cost",
      )?.[1],
    ).toBe(4000000);
    expect(
      gaugeCall("langfuse.greptime.disk_size", "observations_usage_cost"),
    ).toEqual([
      "langfuse.greptime.disk_size",
      1024,
      { table: "observations_usage_cost", unit: "bytes" },
    ]);
    expect(
      gaugeCall("langfuse.greptime.memtable_size", "observations")?.[1],
    ).toBe(16);
    expect(
      gaugeCall("langfuse.greptime.sst_files_max", "observations")?.[1],
    ).toBe(2);
  });

  it("skips sampling entirely when another replica holds the cooldown lock", async () => {
    await buildRunner("held_by_other").processBatch();

    expect(mocks.greptimeQuery).not.toHaveBeenCalled();
    expect(mocks.recordGauge).not.toHaveBeenCalled();
  });

  it("still samples when Redis is unavailable (lock skipped)", async () => {
    mocks.greptimeQuery.mockResolvedValue([
      {
        table_name: "traces",
        sst_num_max: 1,
        sst_num_sum: 1,
        region_rows: 10,
        disk_size: 0,
        memtable_size: 0,
      },
    ]);

    await buildRunner("skipped").processBatch();

    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(1);
    expect(mocks.recordGauge).toHaveBeenCalledTimes(5);
  });
});
