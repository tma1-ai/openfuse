/**
 * HTTP Range parsing for the local media download endpoint.
 *
 * Kept free of any environment or framework imports so the parsing logic can
 * be unit-tested in isolation. Only a single byte range is supported; requests
 * for multiple ranges fall back to serving the full representation.
 */

export type ByteRange = { start: number; end: number };

export type RangeResolution =
  | { kind: "full" }
  | { kind: "range"; range: ByteRange }
  | { kind: "unsatisfiable" };

const parseNonNegativeInt = (value: string): number | null =>
  /^\d+$/.test(value) ? Number(value) : null;

/**
 * Resolve a `Range` request header against a representation of `size` bytes.
 *
 * - Missing, malformed, or multi-range headers resolve to `full` (HTTP 200).
 * - A valid satisfiable single range resolves to `range` (HTTP 206).
 * - A syntactically valid but unsatisfiable range resolves to `unsatisfiable`
 *   (HTTP 416), e.g. a start at or beyond the end of the representation.
 */
export function resolveByteRange(
  rangeHeader: string | string[] | undefined,
  size: number,
): RangeResolution {
  if (typeof rangeHeader !== "string") {
    return { kind: "full" };
  }

  const match = /^bytes=(.*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { kind: "full" };
  }

  const spec = match[1].trim();
  // Only a single range is supported; defer to the full body otherwise.
  if (spec === "" || spec.includes(",")) {
    return { kind: "full" };
  }

  const dash = spec.indexOf("-");
  if (dash === -1) {
    return { kind: "full" };
  }

  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  // Suffix range: `bytes=-N` requests the final N bytes.
  if (startStr === "") {
    const suffix = parseNonNegativeInt(endStr);
    if (suffix === null) {
      return { kind: "full" };
    }
    if (size === 0 || suffix === 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "range",
      range: { start: Math.max(0, size - suffix), end: size - 1 },
    };
  }

  const start = parseNonNegativeInt(startStr);
  if (start === null) {
    return { kind: "full" };
  }
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }

  let end: number;
  if (endStr === "") {
    end = size - 1;
  } else {
    const parsedEnd = parseNonNegativeInt(endStr);
    if (parsedEnd === null) {
      return { kind: "full" };
    }
    end = Math.min(parsedEnd, size - 1);
  }

  if (end < start) {
    return { kind: "unsatisfiable" };
  }

  return { kind: "range", range: { start, end } };
}
