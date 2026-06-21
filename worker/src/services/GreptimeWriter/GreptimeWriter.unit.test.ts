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
    // Cleanup fires its per-EAV-table deletes in parallel (Promise.all), so the first (failed) flush
    // still issued both traces_metadata + traces_tags deletes before rejecting; the retry issues both
    // again -> 4 total. Re-running the sibling that landed is harmless (idempotent DELETE).
    expect(deleteEav).toHaveBeenCalledTimes(4);
  });

  it("does not lose an entity enqueued while a cleanup delete is in flight", async () => {
    const { writer, deletes, deleteEav } = setup();
    // A concurrent addToQueue interleaving during the cleanup await must not be lost: it only touches
    // the queues, so the next flush splices and cleans it. Cleanup targets are derived from the
    // spliced rows of each flush, so there is no shared cleanup state for the enqueue to corrupt.
    let injected = false;
    deleteEav.mockImplementation(async (table, byProject) => {
      deletes.push({
        table,
        entities: Object.fromEntries(
          [...byProject].map(([p, ids]) => [p, [...ids]]),
        ),
      });
      if (!injected) {
        injected = true;
        writer.addToQueue(
          GreptimeTable.Traces,
          createTrace({
            project_id: "p",
            id: "concurrent",
            metadata: { a: "1" },
            tags: [],
          }),
        );
      }
    });

    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "first",
        metadata: { a: "1" },
        tags: ["x"],
      }),
    );
    await writer.flushAll(true);
    // The concurrently-enqueued entity is cleaned on the next flush (it went to the queue).
    await writer.flushAll(true);

    const cleanedEntities = deletes.flatMap((d) => d.entities.p ?? []);
    expect(cleanedEntities).toContain("concurrent");
  });

  it("a partial flush cleans only the entities it writes (no cross-flush gap)", async () => {
    const { write, landed } = fakeWriter(() => null);
    const cleaned: string[] = [];
    const deleteEav = vi.fn(
      async (
        _table: string,
        byProject: ReadonlyMap<string, ReadonlySet<string>>,
      ) => {
        for (const ids of byProject.values())
          for (const id of ids) cleaned.push(id);
      },
    );
    // batchSize 1: each metadata-free trace is a 1-row group, so a partial flush takes exactly one.
    const writer = GreptimeWriter.createForTest({
      write,
      deleteEav,
      batchSize: 1,
    });
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({ project_id: "p", id: "first", metadata: {}, tags: [] }),
    );
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({ project_id: "p", id: "second", metadata: {}, tags: [] }),
    );

    await writer.flushAll(false);
    expect(landedProjectionIds(landed, "traces")).toEqual(["first"]);
    // Cleanup targeted only the written entity — "second"'s EAV is untouched until it is written.
    expect(new Set(cleaned)).toEqual(new Set(["first"]));
    expect(writer.pendingRows()).toBeGreaterThan(0);

    cleaned.length = 0;
    await writer.flushAll(false);
    expect(new Set(cleaned)).toEqual(new Set(["second"]));
  });

  it("never splits an entity's fan-out across a partial flush", async () => {
    const { write, landed } = fakeWriter(() => null);
    // batchSize 1 is smaller than one observation's multi-row fan-out; the whole group must still go.
    const writer = GreptimeWriter.createForTest({ write, batchSize: 1 });
    writer.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "o1",
        metadata: { k: "v" },
        usage_details: {},
        cost_details: {},
        tool_definitions: { search: "x" },
        tool_call_names: ["search"],
      }),
    );
    writer.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "o2",
        metadata: {},
        usage_details: {},
        cost_details: {},
      }),
    );

    await writer.flushAll(false);
    // o1's projection AND its EAV rows landed together in this flush (group not split)...
    expect(landedProjectionIds(landed, "observations")).toContain("o1");
    expect(landedProjectionIds(landed, "observations_metadata")).toContain(
      "o1",
    );
    expect(
      landedProjectionIds(landed, "observations_tool_definitions"),
    ).toContain("o1");
    // ...and the next whole group (o2) was left for a later flush.
    expect(landedProjectionIds(landed, "observations")).not.toContain("o2");
  });
});

/** Yield to the microtask + timer queues so background flushes reach their (blocked) write. */
const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * A `write` that blocks until released, recording peak concurrency and landed snapshots. Lets a test
 * hold several flushes in their write call at once to observe how many run in parallel.
 */
const blockingWriter = () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: Array<() => void> = [];
  const landed: CallSnapshot[] = [];
  const write = vi.fn(async (tables: Table[]): Promise<AffectedRows> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((res) => releases.push(res));
    inFlight--;
    landed.push(snapshot(tables));
    return { value: tables.reduce((n, t) => n + t.rowCount(), 0) };
  });
  return {
    write,
    landed,
    releaseAll: () => releases.splice(0).forEach((r) => r()),
    get maxInFlight() {
      return maxInFlight;
    },
  };
};

describe("GreptimeWriter concurrent flushing", () => {
  it("runs multiple flushes in parallel — no single-flight gate", async () => {
    const w = blockingWriter();
    // batchSize 1 so each metadata-free trace is its own one-group batch.
    const writer = GreptimeWriter.createForTest({
      write: w.write,
      batchSize: 1,
    });
    for (const id of ["a", "b", "c"]) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }

    // Three partial flushes, each splicing a distinct entity, all reach their (blocked) write.
    const flushes = [
      writer.flushAll(false),
      writer.flushAll(false),
      writer.flushAll(false),
    ];
    await tick();
    expect(w.maxInFlight).toBe(3); // the old serial gate would have capped this at 1

    w.releaseAll();
    await Promise.all(flushes);
    expect(landedProjectionIds(w.landed, "traces").sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("never writes the same entity from two concurrent flushes (in-flight guard)", async () => {
    const w = blockingWriter();
    const writer = GreptimeWriter.createForTest({
      write: w.write,
      batchSize: 1,
    });
    // Two events for the SAME entity -> two groups that must not flush concurrently.
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({ project_id: "p", id: "x", metadata: { a: "1" }, tags: [] }),
    );
    writer.addToQueue(
      GreptimeTable.Traces,
      createTrace({ project_id: "p", id: "x", metadata: { a: "2" }, tags: [] }),
    );

    const f1 = writer.flushAll(false); // claims entity x's first group, blocks on write
    const f2 = writer.flushAll(false); // x is in-flight -> splices nothing, returns immediately
    await f2;
    await tick();
    expect(w.maxInFlight).toBe(1); // x is never written by two flushes at once
    expect(writer.pendingRows()).toBeGreaterThan(0); // x's second group still queued

    w.releaseAll();
    await f1;
    // Only after x is released can its second group flush.
    const f3 = writer.flushAll(false);
    await tick();
    w.releaseAll();
    await f3;

    // Both snapshots of x landed, in groupId order, and never overlapped.
    expect(landedProjectionIds(w.landed, "traces")).toEqual(["x", "x"]);
    expect(w.maxInFlight).toBe(1);
  });

  it("honors the concurrency cap when auto-flushing", async () => {
    const w = blockingWriter();
    const writer = GreptimeWriter.createForTest({
      write: w.write,
      batchSize: 1,
      autoFlush: true,
      maxConcurrentFlushes: 2,
    });
    for (const id of ["a", "b", "c", "d", "e"]) {
      writer.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }

    await tick();
    // Five distinct entities queued, cap 2 -> at most two writes in flight at once.
    expect(w.maxInFlight).toBe(2);

    // Drain in waves: releasing the in-flight writes lets each completion re-pump the next.
    for (let i = 0; i < 20 && w.landed.length < 5; i++) {
      w.releaseAll();
      await tick();
    }
    expect(w.maxInFlight).toBe(2); // peak never exceeded the cap
    expect(landedProjectionIds(w.landed, "traces").sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});
