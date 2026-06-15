import { describe, expect, test } from "vitest";

import { resolveByteRange } from "@/src/features/media/server/byteRange";

const SIZE = 1000;

describe("resolveByteRange", () => {
  test("no range header serves the full body", () => {
    expect(resolveByteRange(undefined, SIZE)).toEqual({ kind: "full" });
  });

  test("array header (duplicate Range) serves the full body", () => {
    expect(resolveByteRange(["bytes=0-1", "bytes=2-3"], SIZE)).toEqual({
      kind: "full",
    });
  });

  test("non-bytes units serve the full body", () => {
    expect(resolveByteRange("items=0-10", SIZE)).toEqual({ kind: "full" });
  });

  test("multiple ranges fall back to the full body", () => {
    expect(resolveByteRange("bytes=0-9,20-29", SIZE)).toEqual({ kind: "full" });
  });

  test("closed range is honored inclusively", () => {
    expect(resolveByteRange("bytes=0-499", SIZE)).toEqual({
      kind: "range",
      range: { start: 0, end: 499 },
    });
    expect(resolveByteRange("bytes=500-999", SIZE)).toEqual({
      kind: "range",
      range: { start: 500, end: 999 },
    });
  });

  test("open-ended range runs to the last byte", () => {
    expect(resolveByteRange("bytes=200-", SIZE)).toEqual({
      kind: "range",
      range: { start: 200, end: 999 },
    });
  });

  test("end past EOF is clamped to the last byte", () => {
    expect(resolveByteRange("bytes=900-5000", SIZE)).toEqual({
      kind: "range",
      range: { start: 900, end: 999 },
    });
  });

  test("suffix range returns the final N bytes", () => {
    expect(resolveByteRange("bytes=-300", SIZE)).toEqual({
      kind: "range",
      range: { start: 700, end: 999 },
    });
  });

  test("suffix larger than the body returns the whole body", () => {
    expect(resolveByteRange("bytes=-5000", SIZE)).toEqual({
      kind: "range",
      range: { start: 0, end: 999 },
    });
  });

  test("whitespace around the spec is tolerated", () => {
    expect(resolveByteRange("bytes= 0 - 9 ", SIZE)).toEqual({
      kind: "range",
      range: { start: 0, end: 9 },
    });
  });

  test("start at or beyond EOF is unsatisfiable", () => {
    expect(resolveByteRange("bytes=1000-1100", SIZE)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveByteRange("bytes=1000-", SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  test("inverted range is unsatisfiable", () => {
    expect(resolveByteRange("bytes=500-200", SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  test("zero-length suffix is unsatisfiable", () => {
    expect(resolveByteRange("bytes=-0", SIZE)).toEqual({
      kind: "unsatisfiable",
    });
  });

  test("any range against an empty body is unsatisfiable", () => {
    expect(resolveByteRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(resolveByteRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });

  test("non-numeric bounds fall back to the full body", () => {
    expect(resolveByteRange("bytes=abc-def", SIZE)).toEqual({ kind: "full" });
    expect(resolveByteRange("bytes=0-1e3", SIZE)).toEqual({ kind: "full" });
    expect(resolveByteRange("bytes=-", SIZE)).toEqual({ kind: "full" });
  });
});
