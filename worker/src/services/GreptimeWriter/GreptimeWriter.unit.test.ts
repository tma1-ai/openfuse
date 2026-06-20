import type { AffectedRows, Table } from "@greptime/ingester";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// Spy on the metric emitters while keeping every other shared export real (the writer relies on
// buildGreptimeRowsForRecord / bisectGroups / classifyGreptimeWriteError / truncateOversizedRow / ...).
vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    recordIncrement: vi.fn(),
    recordGauge: vi.fn(),
    recordHistogram: vi.fn(),
  };
});

import {
  createObservation,
  createTrace,
  recordIncrement,
  TransportError,
  ValueError,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import { GreptimeWriter, GreptimeTable } from ".";

const incrementMock = recordIncrement as unknown as Mock;

/** Per-table entity ids seen in one `write` call: projection rows by `id`, EAV rows by `entity_id`. */
type CallSnapshot = { table: string; ids: string[] }[];

const snapshot = (tables: Table[]): CallSnapshot =>
  tables.map((t) => {
    const cols = t.columns();
    const idIdx = cols.findIndex((c) => c.name === "id");
    const entIdx = cols.findIndex((c) => c.name === "entity_id");
    const idx = idIdx >= 0 ? idIdx : entIdx;
    return {
      table: t.tableName(),
      ids: idx >= 0 ? t.rows().map((r) => r[idx] as string) : [],
    };
  });

const fieldBytes = (
  tables: Table[],
  table: string,
  field: string,
): number[] => {
  const out: number[] = [];
  for (const t of tables) {
    if (t.tableName() !== table) continue;
    const idx = t.columns().findIndex((c) => c.name === field);
    if (idx < 0) continue;
    for (const row of t.rows()) {
      const v = row[idx];
      if (typeof v === "string") out.push(Buffer.byteLength(v, "utf8"));
    }
  }
  return out;
};

/** Build a fake `write` that fails per a predicate and records the successful calls' snapshots. */
const fakeWriter = (shouldFail: (tables: Table[]) => Error | null) => {
  const calls: Table[][] = [];
  const landed: CallSnapshot[] = [];
  const write = vi.fn(async (tables: Table[]): Promise<AffectedRows> => {
    calls.push(tables);
    const err = shouldFail(tables);
    if (err) throw err;
    landed.push(snapshot(tables));
    return { value: tables.reduce((n, t) => n + t.rowCount(), 0) };
  });
  return { write, calls, landed };
};

const incrementsFor = (stat: string) =>
  incrementMock.mock.calls.filter((c) => c[0] === stat);

const landedProjectionIds = (landed: CallSnapshot[], table: string): string[] =>
  landed.flatMap((snap) => snap.find((s) => s.table === table)?.ids ?? []);

beforeEach(() => incrementMock.mockClear());
afterEach(() => vi.clearAllMocks());

describe("GreptimeWriter batch-failure isolation", () => {
  it("writes a clean batch in one combined call with no drops", async () => {
    const { write, calls, landed } = fakeWriter(() => null);
    const writer = GreptimeWriter.createForTest({ write });

    const ids = ["t1", "t2", "t3"];
    for (const id of ids) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await writer.flushAll(true);

    expect(calls).toHaveLength(1);
    expect(landedProjectionIds(landed, "traces").sort()).toEqual(ids);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.rows_dropped"),
    ).toHaveLength(0);
  });

  it("registers and lands the observation usage/cost EAV fan-out", async () => {
    // Regression guard: an observation fans out to observations_usage_cost, which must be a
    // registered PHYSICAL_TABLE. If it is missing, the writer's per-table queue / Table builder is
    // undefined and addToQueue/flushAll throw before anything lands.
    const { write, landed } = fakeWriter(() => null);
    const writer = GreptimeWriter.createForTest({ write });

    writer.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "obs-uc",
        metadata: {},
        usage_details: { input: 10, output: 20, total: 30, cache_read: 5 },
        cost_details: { input: 1, total: 1 },
      }),
    );
    await writer.flushAll(true);

    expect(landedProjectionIds(landed, "observations")).toContain("obs-uc");
    // Only custom keys are exploded into the EAV table; standard input/output/total are served from
    // the JSON columns. usage has one custom key (cache_read); cost has none.
    const usageCostIds = landedProjectionIds(landed, "observations_usage_cost");
    expect(usageCostIds).toHaveLength(1);
    expect(new Set(usageCostIds)).toEqual(new Set(["obs-uc"]));
  });

  it("isolates a poison group via bisection while good groups land", async () => {
    const { write, landed } = fakeWriter((tables) =>
      snapshot(tables).some((s) => s.ids.includes("t2"))
        ? new ValueError("poison row t2")
        : null,
    );
    const writer = GreptimeWriter.createForTest({ write });

    for (const id of ["t1", "t2", "t3"]) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await writer.flushAll(true);

    const traces = landedProjectionIds(landed, "traces");
    expect(traces.sort()).toEqual(["t1", "t3"]);
    expect(traces).not.toContain("t2");

    expect(
      incrementsFor("langfuse.queue.greptime_writer.bisect_runs"),
    ).toHaveLength(1);
    const drops = incrementsFor("langfuse.queue.greptime_writer.rows_dropped");
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0][2]).toMatchObject({
      table: "traces",
      error_class: "value",
    });
    expect(
      incrementsFor("langfuse.queue.greptime_writer.poison_groups_isolated"),
    ).toHaveLength(1);
  });

  it("never splits a projection row from its EAV rows during bisection", async () => {
    const { write, landed } = fakeWriter((tables) =>
      snapshot(tables).some((s) => s.ids.includes("bad"))
        ? new ValueError("poison row bad")
        : null,
    );
    const writer = GreptimeWriter.createForTest({ write });

    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "good",
        metadata: { region: "us" },
        tags: ["x"],
      }),
    );
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "bad",
        metadata: { region: "eu" },
        tags: ["y"],
      }),
    );
    await writer.flushAll(true);

    // The call that landed "good" must carry its projection AND both EAV rows together.
    const goodCall = landed.find((snap) =>
      snap.find((s) => s.table === "traces")?.ids.includes("good"),
    );
    expect(goodCall).toBeDefined();
    expect(goodCall!.find((s) => s.table === "traces_metadata")?.ids).toContain(
      "good",
    );
    expect(goodCall!.find((s) => s.table === "traces_tags")?.ids).toContain(
      "good",
    );
    // "bad" was isolated and dropped — it never landed.
    expect(landedProjectionIds(landed, "traces")).not.toContain("bad");
  });

  it("retries the whole batch on a transient failure without bisecting", async () => {
    const { write, calls } = fakeWriter(
      () => new TransportError("unavailable", 14),
    );
    const writer = GreptimeWriter.createForTest({ write });

    for (const id of ["t1", "t2", "t3"]) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await writer.flushAll(true);

    // backOff retried the full batch; every attempt carried all three projection rows (no split).
    expect(calls.length).toBeGreaterThan(1);
    for (const tables of calls) {
      expect(landedProjectionIds([snapshot(tables)], "traces").sort()).toEqual([
        "t1",
        "t2",
        "t3",
      ]);
    }
    // Transient → requeued for the next flush, not bisected, and nothing dropped yet.
    expect(
      incrementsFor("langfuse.queue.greptime_writer.bisect_runs"),
    ).toHaveLength(0);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.rows_dropped"),
    ).toHaveLength(0);
  });

  it("treats unknown writer errors as transient instead of poison-isolating rows", async () => {
    const { write } = fakeWriter(() => new Error("foreign client error"));
    const writer = GreptimeWriter.createForTest({ write });

    for (const id of ["t1", "t2"]) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await writer.flushAll(true);

    expect(write.mock.calls.length).toBeGreaterThan(1);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.bisect_runs"),
    ).toHaveLength(0);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.rows_dropped"),
    ).toHaveLength(0);
  });

  it("truncates an oversized isolated row and retries instead of dropping it", async () => {
    const cap = env.LANGFUSE_GREPTIME_WRITE_MAX_FIELD_BYTES;
    const failThreshold = Math.floor(cap * 1.5);
    const { write, landed } = fakeWriter((tables) =>
      fieldBytes(tables, "observations", "input").some((b) => b > failThreshold)
        ? new TransportError("message too large", 8)
        : null,
    );
    const writer = GreptimeWriter.createForTest({ write });

    writer.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "obs",
        metadata: {},
        input: "x".repeat(cap * 2), // ~2x cap -> over the fake server limit until truncated
      }),
    );
    await writer.flushAll(true);

    expect(landedProjectionIds(landed, "observations")).toContain("obs");
    const truncations = incrementsFor(
      "langfuse.queue.greptime_writer.rows_truncated",
    );
    expect(truncations.length).toBeGreaterThan(0);
    expect(truncations[0][2]).toMatchObject({ table: "observations" });
    expect(
      incrementsFor("langfuse.queue.greptime_writer.rows_dropped"),
    ).toHaveLength(0);
  });
});

describe("GreptimeWriter.resolveGroups (backfill projection gating)", () => {
  // One projection-only group as the bulk writer feeds it: a single physical row keyed by `id`.
  const traceGroup = (id: string, groupId: number) => ({
    groupId,
    rows: [
      {
        table: "traces",
        rows: [{ project_id: "p", id, timestamp: 1, is_deleted: false }],
      },
    ],
  });

  it("returns every groupId on a clean write", async () => {
    const { write, landed } = fakeWriter(() => null);
    const writer = GreptimeWriter.createForTest({ write });

    const result = await writer.resolveGroups([
      traceGroup("a", 1),
      traceGroup("b", 2),
    ]);

    expect([...result].sort()).toEqual([1, 2]);
    expect(landedProjectionIds(landed, "traces").sort()).toEqual(["a", "b"]);
  });

  it("excludes a poison group from the landed set while good groups land", async () => {
    const { write, landed } = fakeWriter((tables) =>
      snapshot(tables).some((s) => s.ids.includes("bad"))
        ? new ValueError("poison row bad")
        : null,
    );
    const writer = GreptimeWriter.createForTest({ write });

    const result = await writer.resolveGroups([
      traceGroup("ok", 1),
      traceGroup("bad", 2),
    ]);

    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(false);
    expect(landedProjectionIds(landed, "traces")).toEqual(["ok"]);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.poison_groups_isolated"),
    ).toHaveLength(1);
  });

  it("counts a truncation-salvaged oversize group as landed", async () => {
    const cap = env.LANGFUSE_GREPTIME_WRITE_MAX_FIELD_BYTES;
    const failThreshold = Math.floor(cap * 1.5);
    const { write } = fakeWriter((tables) =>
      fieldBytes(tables, "observations", "input").some((b) => b > failThreshold)
        ? new TransportError("message too large", 8)
        : null,
    );
    const writer = GreptimeWriter.createForTest({ write });

    const result = await writer.resolveGroups([
      {
        groupId: 7,
        rows: [
          {
            table: "observations",
            rows: [
              {
                project_id: "p",
                id: "o",
                start_time: 1,
                input: "x".repeat(cap * 2),
                is_deleted: false,
              },
            ],
          },
        ],
      },
    ]);

    expect(result.has(7)).toBe(true);
    expect(
      incrementsFor("langfuse.queue.greptime_writer.rows_truncated").length,
    ).toBeGreaterThan(0);
  });

  it("omits a transient-failing group from the landed set", async () => {
    const { write } = fakeWriter(() => new TransportError("unavailable", 14));
    const writer = GreptimeWriter.createForTest({ write });

    const result = await writer.resolveGroups([traceGroup("a", 1)]);

    expect(result.size).toBe(0);
  });
});

describe("GreptimeWriter EAV shrink consistency", () => {
  // Record cleanup deletes and writes in one ordered log to assert delete-before-write.
  const setup = () => {
    const order: string[] = [];
    const deletes: { table: string; entities: Record<string, string[]> }[] = [];
    const { write } = fakeWriter(() => null);
    const wrappedWrite = vi.fn(async (tables: Parameters<typeof write>[0]) => {
      order.push("write");
      return write(tables);
    });
    const deleteEav = vi.fn(
      async (
        table: string,
        byProject: ReadonlyMap<string, ReadonlySet<string>>,
      ) => {
        order.push(`delete:${table}`);
        deletes.push({
          table,
          entities: Object.fromEntries(
            [...byProject].map(([p, ids]) => [p, [...ids]]),
          ),
        });
      },
    );
    const writer = GreptimeWriter.createForTest({
      write: wrappedWrite,
      deleteEav,
    });
    return { writer, order, deletes, write: wrappedWrite, deleteEav };
  };

  it("deletes a trace's metadata + tags EAV before writing, keyed by the projection entity", async () => {
    const { writer, order, deletes } = setup();
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "t1",
        metadata: { a: "1" },
        tags: ["x"],
      }),
    );
    await writer.flushAll(true);

    const tables = deletes.map((d) => d.table).sort();
    expect(tables).toEqual(["traces_metadata", "traces_tags"]);
    for (const d of deletes) expect(d.entities).toEqual({ p: ["t1"] });
    // every delete precedes the single write
    expect(order.indexOf("write")).toBe(order.length - 1);
    expect(order.filter((o) => o.startsWith("delete:"))).toHaveLength(2);
  });

  it("still cleans an observation whose EAV set shrank to empty (no fanned EAV rows)", async () => {
    const { writer, deletes } = setup();
    // No tools, no custom usage/cost, no metadata -> the fan-out emits only the projection row, but
    // the entity must still be cleaned so any prior tool/metadata rows are removed.
    writer.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "o1",
        metadata: {},
        usage_details: {},
        cost_details: {},
        tool_definitions: {},
        tool_call_names: [],
      }),
    );
    await writer.flushAll(true);

    const cleaned = deletes.map((d) => d.table).sort();
    expect(cleaned).toEqual([
      "observations_metadata",
      "observations_tool_calls",
      "observations_tool_definitions",
      "observations_usage_cost",
    ]);
    for (const d of deletes) expect(d.entities).toEqual({ p: ["o1"] });
  });

  it("does not write and keeps the batch queued when EAV cleanup fails", async () => {
    const { writer, write, deleteEav } = setup();
    deleteEav.mockRejectedValueOnce(new Error("delete failed"));

    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "t-retry",
        metadata: { stale: "gone" },
        tags: ["x"],
      }),
    );

    await expect(writer.flushAll(true)).rejects.toThrow("delete failed");
    expect(write).not.toHaveBeenCalled();
    expect(writer.pendingRows()).toBeGreaterThan(0);

    await writer.flushAll(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(deleteEav).toHaveBeenCalledTimes(3);
  });
});
