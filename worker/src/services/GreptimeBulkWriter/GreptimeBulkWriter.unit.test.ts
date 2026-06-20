import type { AffectedRows, Client, Table } from "@greptime/ingester";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// Spy on metric emitters; keep every other shared export real (row fan-out, schemas, the unary writer).
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

import { GreptimeWriter, GreptimeTable } from "../GreptimeWriter";
import { GreptimeBulkWriter } from ".";

const incrementMock = recordIncrement as unknown as Mock;
const incrementsFor = (stat: string) =>
  incrementMock.mock.calls.filter((c) => c[0] === stat);

/**
 * A fake bulk client: records `writeRows` batch sizes per table and can fail a chosen table. With
 * `failAfterChunks` the first N chunks ack and later ones throw, modelling a mid-stream failure after
 * earlier chunks were already accepted; without it the table fails from its first chunk.
 */
const fakeBulkClient = (opts?: {
  failTable?: string;
  failAfterChunks?: number;
}) => {
  const created: string[] = [];
  const batches: { table: string; rowCount: number }[] = [];
  const chunkCounts = new Map<string, number>();
  const client = {
    createBulkStreamWriter: vi.fn(async (schema: { tableName: string }) => {
      const table = schema.tableName;
      created.push(table);
      return {
        writeRows: vi.fn(async (b: { rows: unknown[][] }) => {
          const n = (chunkCounts.get(table) ?? 0) + 1;
          chunkCounts.set(table, n);
          if (
            opts?.failTable === table &&
            (opts.failAfterChunks === undefined || n > opts.failAfterChunks)
          ) {
            throw new Error(`bulk fail ${table}`);
          }
          batches.push({ table, rowCount: b.rows.length });
          return {};
        }),
        finish: vi.fn(async () => ({
          totalRequests: 1,
          totalAffectedRows: batches
            .filter((w) => w.table === table)
            .reduce((n, w) => n + w.rowCount, 0),
        })),
        cancel: vi.fn(),
      };
    }),
  } as unknown as Client;
  return { client, created, batches };
};

/** A real manual unary writer over a fake `write` that fails per predicate and records landed ids. */
const fakeUnary = (
  shouldFail: (tables: Table[]) => Error | null = () => null,
) => {
  const landedIds: string[] = [];
  const write = vi.fn(async (tables: Table[]): Promise<AffectedRows> => {
    const err = shouldFail(tables);
    if (err) throw err;
    for (const t of tables) {
      const cols = t.columns();
      const idIdx = cols.findIndex(
        (c) => c.name === "id" || c.name === "entity_id",
      );
      if (idIdx >= 0) {
        for (const row of t.rows()) landedIds.push(row[idIdx] as string);
      }
    }
    return { value: tables.reduce((n, t) => n + t.rowCount(), 0) };
  });
  const writer = GreptimeWriter.createManual({ write });
  return { writer, write, landedIds };
};

const makeBulkWriter = (
  client: Client,
  unary: GreptimeWriter,
  batchSize = 10_000,
) => new GreptimeBulkWriter({ client, unary, batchSize });

afterEach(() => vi.clearAllMocks());

describe("GreptimeBulkWriter routing", () => {
  it("routes a decimal-free entity (trace + EAV) entirely to bulk, never unary", async () => {
    const { client, created } = fakeBulkClient();
    const { writer: unary, write: unaryWrite } = fakeUnary();
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "t1",
        metadata: { region: "us" },
        tags: ["x"],
      }),
    );
    await bulk.flushAll();

    expect(new Set(created)).toEqual(
      new Set(["traces", "traces_metadata", "traces_tags"]),
    );
    expect(unaryWrite).not.toHaveBeenCalled();
  });

  it("keeps the observation projection unary and bulk-writes its EAV", async () => {
    const { client, created } = fakeBulkClient();
    const { writer: unary, landedIds } = fakeUnary();
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "obs1",
        metadata: { k: "v" },
        usage_details: { input: 10, cache_read: 5 },
        cost_details: {},
      }),
    );
    await bulk.flushAll();

    // Projection landed on the unary lane; the decimal table never hit the bulk path.
    expect(landedIds).toContain("obs1");
    expect(created).not.toContain("observations");
    // EAV released to bulk because the projection landed.
    expect(new Set(created)).toEqual(
      new Set(["observations_metadata", "observations_usage_cost"]),
    );
  });

  it("withholds EAV from bulk when the gated projection does not land", async () => {
    const { client, created } = fakeBulkClient();
    // Unary write rejects the observation projection as poison -> projection dropped, not landed.
    const { writer: unary } = fakeUnary(() => new ValueError("poison obs"));
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "obs-bad",
        metadata: { k: "v" },
        usage_details: { input: 10, cache_read: 5 },
        cost_details: {},
      }),
    );
    await bulk.flushAll();

    // No bulk stream opened at all: the only entity's projection dropped, so its EAV is never written.
    expect(created).toHaveLength(0);
    expect(
      incrementsFor("langfuse.greptime_bulk.gated_projection_not_landed"),
    ).toHaveLength(1);
  });

  it("fails the flush when the gated projection remains pending", async () => {
    const { client, created } = fakeBulkClient();
    const { writer: unary } = fakeUnary(
      () => new TransportError("unavailable", 14),
    );
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Observations,
      createObservation({
        project_id: "p",
        id: "obs-transient",
        metadata: { k: "v" },
        usage_details: { input: 10, cache_read: 5 },
        cost_details: {},
      }),
    );

    await expect(bulk.flushAll()).rejects.toThrow(/gated projection row/);

    expect(created).toHaveLength(0);
    expect(
      incrementsFor("langfuse.greptime_bulk.gated_projection_pending_rows"),
    ).toHaveLength(1);
  });

  it("falls a failed bulk table back to the unary writer", async () => {
    const { client } = fakeBulkClient({ failTable: "traces" });
    const { writer: unary, landedIds } = fakeUnary();
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Traces,
      createTrace({ project_id: "p", id: "t-fb", metadata: {}, tags: [] }),
    );
    await bulk.flushAll();

    expect(landedIds).toContain("t-fb");
    expect(incrementsFor("langfuse.greptime_bulk.fallback_rows")).toHaveLength(
      1,
    );
  });

  it("fails the flush when unary fallback remains pending", async () => {
    const { client } = fakeBulkClient({ failTable: "traces" });
    const { writer: unary } = fakeUnary(
      () => new TransportError("unavailable", 14),
    );
    const bulk = makeBulkWriter(client, unary);

    bulk.addToQueue(
      GreptimeTable.Traces,
      createTrace({
        project_id: "p",
        id: "t-fb-transient",
        metadata: {},
        tags: [],
      }),
    );

    await expect(bulk.flushAll()).rejects.toThrow(/unary fallback row/);

    expect(
      incrementsFor("langfuse.greptime_bulk.unary_pending_rows"),
    ).toHaveLength(1);
  });

  it("falls the whole table back to unary when a later chunk fails after earlier ones acked", async () => {
    // batchSize 2 over 3 rows -> chunk[a,b] acks, chunk[c] throws.
    const { client, batches } = fakeBulkClient({
      failTable: "traces",
      failAfterChunks: 1,
    });
    const { writer: unary, landedIds } = fakeUnary();
    const bulk = makeBulkWriter(client, unary, 2);

    for (const id of ["a", "b", "c"]) {
      bulk.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await bulk.flushAll();

    // Only the first chunk acked on the bulk path before the failure.
    expect(
      batches.filter((b) => b.table === "traces").map((b) => b.rowCount),
    ).toEqual([2]);
    // The whole table (incl. the already-acked chunk) is rewritten via unary — safe because writes are
    // idempotent on the primary key — so all three rows land.
    expect(landedIds.filter((x) => ["a", "b", "c"].includes(x)).sort()).toEqual(
      ["a", "b", "c"],
    );
    expect(incrementsFor("langfuse.greptime_bulk.fallback_rows")).toHaveLength(
      1,
    );
  });

  it("chunks bulk writeRows at batchSize", async () => {
    const { client, batches } = fakeBulkClient();
    const { writer: unary } = fakeUnary();
    const bulk = makeBulkWriter(client, unary, 2);

    for (const id of ["a", "b", "c"]) {
      bulk.addToQueue(
        GreptimeTable.Traces,
        createTrace({ project_id: "p", id, metadata: {}, tags: [] }),
      );
    }
    await bulk.flushAll();

    const traceBatches = batches
      .filter((b) => b.table === "traces")
      .map((b) => b.rowCount);
    expect(traceBatches).toEqual([2, 1]);
  });
});
