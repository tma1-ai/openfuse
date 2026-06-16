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
