import {
  GreptimeStatusCode,
  SchemaError,
  ServerError,
  TimeoutError,
  TransportError,
  ValueError,
} from "@greptime/ingester";
import { describe, expect, it, vi } from "vitest";

import {
  bisectGroups,
  classifyGreptimeWriteError,
  truncateOversizedRow,
  type WriteGroup,
} from "./writeErrors";

describe("classifyGreptimeWriteError", () => {
  it("classifies local value/schema errors as poison", () => {
    expect(classifyGreptimeWriteError(new ValueError("bad value"))).toEqual({
      class: "poison",
      errorClass: "value",
    });
    expect(classifyGreptimeWriteError(new SchemaError("bad schema"))).toEqual({
      class: "poison",
      errorClass: "schema",
    });
  });

  it("classifies non-retriable server errors as poison and retriable ones as transient", () => {
    expect(
      classifyGreptimeWriteError(
        new ServerError("invalid", GreptimeStatusCode.InvalidArguments),
      ),
    ).toEqual({ class: "poison", errorClass: "server_1004" });
    expect(
      classifyGreptimeWriteError(
        new ServerError("busy", GreptimeStatusCode.RegionBusy),
      ),
    ).toEqual({ class: "transient", errorClass: "server_4009" });
  });

  it("classifies gRPC RESOURCE_EXHAUSTED as oversize, other transport codes as transient", () => {
    expect(
      classifyGreptimeWriteError(new TransportError("too big", 8)),
    ).toEqual({ class: "oversize", errorClass: "transport_8" });
    expect(
      classifyGreptimeWriteError(new TransportError("unavailable", 14)),
    ).toEqual({ class: "transient", errorClass: "transport_14" });
  });

  it("treats a client timeout as transient, not a poison row", () => {
    expect(classifyGreptimeWriteError(new TimeoutError("deadline"))).toEqual({
      class: "transient",
      errorClass: "timeout",
    });
  });

  it("treats unknown foreign throws as transient", () => {
    expect(classifyGreptimeWriteError(new Error("boom"))).toEqual({
      class: "transient",
      errorClass: "unknown",
    });
  });
});

const group = (id: number): WriteGroup<number> => ({
  groupId: id,
  items: [{ table: "traces", item: id }],
});

describe("bisectGroups", () => {
  it("isolates a single poison group while every good group lands", async () => {
    const groups = [0, 1, 2, 3, 4, 5, 6, 7].map(group);
    const poison = 3;
    const landed = new Set<number>();
    const poisoned: number[] = [];

    const writeSubset = vi.fn(async (gs: WriteGroup<number>[]) => {
      if (gs.some((g) => g.groupId === poison)) {
        throw new ValueError(`poison row ${poison}`);
      }
    });

    await bisectGroups(groups, writeSubset, {
      onLanded: (gs) => gs.forEach((g) => landed.add(g.groupId)),
      onTransient: () => {
        throw new Error("should not be transient");
      },
      onPoisonLeaf: (g) => {
        poisoned.push(g.groupId);
      },
    });

    expect([...landed].sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(poisoned).toEqual([poison]);
  });

  it("hands the whole subset to onTransient on a transient failure (no recursion)", async () => {
    const groups = [0, 1, 2, 3].map(group);
    const onTransient = vi.fn();
    const writeSubset = vi.fn(async () => {
      throw new TransportError("unavailable", 14);
    });

    await bisectGroups(groups, writeSubset, {
      onTransient,
      onPoisonLeaf: () => {
        throw new Error("should not reach poison leaf");
      },
    });

    expect(writeSubset).toHaveBeenCalledTimes(1);
    expect(onTransient).toHaveBeenCalledTimes(1);
    expect(onTransient.mock.calls[0][0]).toHaveLength(4);
  });

  it("forwards the classification to the poison leaf", async () => {
    const seen: string[] = [];
    await bisectGroups(
      [group(0)],
      async () => {
        throw new ServerError("nope", GreptimeStatusCode.InvalidArguments);
      },
      {
        onTransient: () => {},
        onPoisonLeaf: (_g, c) => {
          seen.push(`${c.class}:${c.errorClass}`);
        },
      },
    );
    expect(seen).toEqual(["poison:server_1004"]);
  });
});

describe("truncateOversizedRow", () => {
  // Cap must exceed the marker length so there is room left for truncated content.
  const cap = 64;

  it("truncates an oversized string field with a visible marker, copy-on-write", () => {
    const row = { id: "t1", input: "x".repeat(200), output: "small" };
    const result = truncateOversizedRow("traces", row, cap);

    expect(result.truncated).toBe(true);
    expect(result.fields).toEqual(["input"]);
    expect(result.row).not.toBe(row); // original untouched
    expect(row.input).toHaveLength(200);
    expect(result.row.input).toMatch(/…\[truncated; original 200 bytes\]$/);
    // The whole field — content plus marker — stays within the cap.
    expect(
      Buffer.byteLength(result.row.input as string, "utf8"),
    ).toBeLessThanOrEqual(cap);
    expect(result.row.output).toBe("small");
  });

  it("replaces an oversized JSON field with a valid-JSON sentinel", () => {
    const big = JSON.stringify({ blob: "y".repeat(100) });
    const row = { id: "o1", metadata: big };
    const result = truncateOversizedRow("observations", row, cap);

    expect(result.truncated).toBe(true);
    expect(result.fields).toEqual(["metadata"]);
    const parsed = JSON.parse(result.row.metadata as string);
    expect(parsed.__truncated__).toBe(true);
    expect(parsed.original_bytes).toBe(Buffer.byteLength(big, "utf8"));
  });

  it("never splits a multibyte sequence", () => {
    const row = { id: "t1", input: "界".repeat(50) }; // 3 bytes each
    const result = truncateOversizedRow("traces", row, cap);
    const head = (result.row.input as string).split("…")[0];
    // Round-trips cleanly — no U+FFFD replacement char from a split code point.
    expect(head).toBe(Buffer.from(head, "utf8").toString("utf8"));
    expect(head.includes("�")).toBe(false);
  });

  it("is a no-op for under-cap fields and unknown tables", () => {
    const small = { id: "t1", input: "tiny" };
    expect(truncateOversizedRow("traces", small, cap)).toEqual({
      row: small,
      truncated: false,
      fields: [],
    });
    const unknown = { value: "z".repeat(100) };
    const res = truncateOversizedRow("not_a_table", unknown, cap);
    expect(res.truncated).toBe(false);
    expect(res.row).toBe(unknown);
  });
});
