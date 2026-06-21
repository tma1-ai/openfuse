import {
  AbortedError,
  IngesterError,
  isRetriable,
  SchemaError,
  ServerError,
  TimeoutError,
  TransportError,
  ValueError,
} from "@greptime/ingester";

// Surface the SDK error types the classifier recognises alongside it, so callers (and tests) match
// against the same class objects this module's `instanceof` checks use — avoiding the dual-package
// hazard where a separately-imported copy of the SDK fails `instanceof` across CJS/ESM realms.
export {
  SchemaError,
  ServerError,
  TimeoutError,
  TransportError,
  ValueError,
} from "@greptime/ingester";

/**
 * GreptimeDB write-failure classification + group-based bisection (02-write-path.md, step 5
 * follow-up: batch-failure isolation).
 *
 * The unary gRPC write is all-or-nothing per request — there are no per-row diagnostics — so the
 * only way to keep good rows when one row is bad/oversized is to bisect the failed batch and retry
 * subsets until the poison is isolated. These helpers are pure (no client, no queue, no env) so they
 * unit-test without a live DB; the worker `GreptimeWriter` injects the actual write call and the
 * terminal requeue/drop/truncate actions.
 */

// gRPC RESOURCE_EXHAUSTED. A request whose encoded size exceeds the server's max recv size fails
// here deterministically: the remedy is to SPLIT the batch (or truncate a lone oversized row), never
// to retry it unchanged. `isRetriable(..., "conservative")` would otherwise mark code 8 retriable.
const GRPC_RESOURCE_EXHAUSTED = 8;

/**
 * Action class for a write failure:
 * - `transient` — retry the whole batch (network/region blips); fate-sharing preserved.
 * - `oversize`  — too large; split, and at a single-group leaf truncate-or-drop.
 * - `poison`    — deterministically bad row (value/schema/business error); split to isolate, drop.
 */
export type WriteFailureClass = "transient" | "oversize" | "poison";

export interface WriteErrorClassification {
  class: WriteFailureClass;
  /** Bounded metric label derived from error kind + status/grpc code. Never a raw error message. */
  errorClass: string;
}

/**
 * Carries a write failure's `WriteErrorClassification` across a `worker_threads` boundary. When the
 * gRPC write is offloaded to a flush worker, the SDK error object stays in the worker's realm — its
 * prototype (and thus the `instanceof` checks `classifyGreptimeWriteError` relies on) cannot survive
 * structured clone. So the worker classifies in-realm and the main thread rethrows this wrapper with
 * the already-computed classification; `classifyGreptimeWriteError` recognises it and passes it
 * through, keeping transient/oversize/poison isolation identical to the in-process path.
 */
export class GreptimeWorkerWriteError extends Error {
  constructor(
    public readonly classification: WriteErrorClassification,
    message: string,
  ) {
    super(message);
    this.name = "GreptimeWorkerWriteError";
  }
}

/** Bounded, low-cardinality label for metrics — kind plus the (enumerated) status/grpc code. */
const errorClassLabel = (err: unknown): string => {
  if (err instanceof ValueError) return "value";
  if (err instanceof SchemaError) return "schema";
  if (err instanceof TimeoutError) return "timeout";
  if (err instanceof AbortedError) return "aborted";
  if (err instanceof ServerError) return `server_${err.statusCode}`;
  if (err instanceof TransportError) return `transport_${err.grpcCode}`;
  if (err instanceof IngesterError) return `ingester_${err.kind}`;
  return "unknown";
};

/**
 * Classify a write failure into an action class. `oversize` is split out from `transient` because a
 * code-8 request will fail forever on retry but succeeds once split/truncated. A `TimeoutError`
 * reflects latency, not a bad row, so it retries the whole batch rather than being isolated and
 * dropped. Everything else defers to the SDK's conservative retriability (transient transport/region
 * conditions retry, deterministic value/schema/business errors do not). Unknown foreign errors are
 * treated as transient: dropping data requires a known deterministic row-level failure signal.
 */
export const classifyGreptimeWriteError = (
  err: unknown,
): WriteErrorClassification => {
  // A flush worker already classified the failure in the realm that holds the live SDK error; trust
  // that verdict rather than re-deriving it from a clone whose prototype (and instanceof) is gone.
  if (err instanceof GreptimeWorkerWriteError) return err.classification;
  const errorClass = errorClassLabel(err);
  if (
    err instanceof TransportError &&
    err.grpcCode === GRPC_RESOURCE_EXHAUSTED
  ) {
    return { class: "oversize", errorClass };
  }
  // The SDK marks a client-side timeout non-retriable (it's the caller's deadline), but our retries
  // are queue-driven, not in-call — a timeout is a latency blip to retry, never a poison row to drop.
  if (err instanceof TimeoutError || isRetriable(err, "conservative")) {
    return { class: "transient", errorClass };
  }
  if (!(err instanceof IngesterError)) {
    return { class: "transient", errorClass };
  }
  return { class: "poison", errorClass };
};

/**
 * Truncatable large fields per physical table, with the column's wire type. Only these are touched —
 * never identity / structural columns (project_id, id, entity_id, key, tag, timestamps, environment).
 * `string` fields are cut on a UTF-8 boundary with a visible marker; `json` fields can't be cut
 * mid-document without producing invalid JSON, so an oversized one is replaced by a compact sentinel.
 * Column types mirror `tableSchemas.ts` (input/output/comment/long_string_value/EAV value = String;
 * metadata/model_parameters/tool_* = Json).
 */
export const LARGE_FIELDS_BY_TABLE: Record<
  string,
  { field: string; kind: "string" | "json" }[]
> = {
  traces: [
    { field: "input", kind: "string" },
    { field: "output", kind: "string" },
    { field: "metadata", kind: "json" },
  ],
  observations: [
    { field: "input", kind: "string" },
    { field: "output", kind: "string" },
    { field: "metadata", kind: "json" },
    { field: "model_parameters", kind: "json" },
    { field: "tool_definitions", kind: "json" },
    { field: "tool_calls", kind: "json" },
  ],
  scores: [
    { field: "long_string_value", kind: "string" },
    { field: "comment", kind: "string" },
    { field: "metadata", kind: "json" },
  ],
  dataset_run_items: [
    { field: "dataset_item_input", kind: "string" },
    { field: "dataset_item_expected_output", kind: "string" },
    { field: "error", kind: "string" },
    { field: "dataset_item_metadata", kind: "json" },
    { field: "dataset_run_metadata", kind: "json" },
  ],
  traces_metadata: [{ field: "value", kind: "string" }],
  observations_metadata: [{ field: "value", kind: "string" }],
  scores_metadata: [{ field: "value", kind: "string" }],
};

/** Cut a UTF-8 string to at most `maxBytes`, backing off any split multibyte sequence. */
const truncateUtf8 = (value: string, maxBytes: number): string => {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // Continuation bytes are 10xxxxxx; back up so we never decode a partial code point.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
};

/**
 * Shrink a row's whitelisted oversized fields. String fields are truncated so the result *including*
 * its marker stays within `maxBytes`; JSON fields, which can't be cut mid-document, are replaced by a
 * compact valid-JSON sentinel. Called reactively only on a single row the server already refused as
 * oversized, so it never silently truncates a writable row. Copy-on-write: returns the original row
 * untouched (and `truncated: false`) when nothing exceeded the cap. `fields` lists the columns
 * actually truncated so the caller can emit per-table metrics.
 */
export const truncateOversizedRow = <T extends Record<string, unknown>>(
  table: string,
  row: T,
  maxBytes: number,
): { row: T; truncated: boolean; fields: string[] } => {
  const whitelist = LARGE_FIELDS_BY_TABLE[table];
  if (!whitelist) return { row, truncated: false, fields: [] };

  let out: T | null = null;
  const fields: string[] = [];
  for (const { field, kind } of whitelist) {
    const value = row[field];
    if (typeof value !== "string") continue;
    if (Buffer.byteLength(value, "utf8") <= maxBytes) continue;

    const originalBytes = Buffer.byteLength(value, "utf8");
    let next: string;
    if (kind === "json") {
      // Can't cut JSON mid-document; replace the whole value with a compact valid-JSON sentinel.
      next = JSON.stringify({
        __truncated__: true,
        original_bytes: originalBytes,
      });
    } else {
      // Reserve room for the marker so content + marker is guaranteed <= maxBytes (not maxBytes plus
      // the marker). The marker states the original size, not the number of bytes removed.
      const marker = `…[truncated; original ${originalBytes} bytes]`;
      const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
      next = `${truncateUtf8(value, budget)}${marker}`;
    }
    out ??= { ...row };
    (out as Record<string, unknown>)[field] = next;
    fields.push(field);
  }
  return out
    ? { row: out, truncated: true, fields }
    : { row, truncated: false, fields: [] };
};

/**
 * One logical entity's physical rows (projection + EAV) destined for a single combined write. A
 * group is the atom of bisection: its rows are never split across subsets, so a projection row and
 * its EAV rows keep sharing fate even on the failure path. `T` is the caller's queue-item payload
 * (the worker threads its `QueueItem` through so it can requeue with the attempt counter).
 */
export interface WriteGroup<T> {
  groupId: number;
  items: { table: string; item: T }[];
}

export interface BisectHandlers<T> {
  /** Groups landed by a (sub-)write. Optional hook for success metrics. */
  onLanded?: (groups: WriteGroup<T>[]) => void;
  /** A subset hit a transient failure mid-bisection — the caller requeues it for the next flush. */
  onTransient: (groups: WriteGroup<T>[]) => void;
  /**
   * A single group failed deterministically after isolation. The caller decides the terminal action
   * from the classification: drop (poison) or truncate-and-retry-then-drop (oversize).
   */
  onPoisonLeaf: (
    group: WriteGroup<T>,
    classification: WriteErrorClassification,
  ) => Promise<void> | void;
}

/**
 * Recursively bisect a set of groups that failed a combined write, isolating the bad group(s) while
 * letting good groups land. Only entered once the top-level failure is known non-transient.
 *
 * On each subset write: success → done; transient → hand back for requeue; deterministic with >1
 * group → split in half and recurse; deterministic with exactly 1 group → `onPoisonLeaf`. Worst case
 * is O(k·log n) writes for k poison groups among n, and only on the failure path.
 */
export const bisectGroups = async <T>(
  groups: WriteGroup<T>[],
  writeSubset: (groups: WriteGroup<T>[]) => Promise<void>,
  handlers: BisectHandlers<T>,
): Promise<void> => {
  if (groups.length === 0) return;
  try {
    await writeSubset(groups);
    handlers.onLanded?.(groups);
  } catch (err) {
    const classification = classifyGreptimeWriteError(err);
    if (classification.class === "transient") {
      handlers.onTransient(groups);
      return;
    }
    if (groups.length === 1) {
      await handlers.onPoisonLeaf(groups[0], classification);
      return;
    }
    const mid = Math.floor(groups.length / 2);
    await bisectGroups(groups.slice(0, mid), writeSubset, handlers);
    await bisectGroups(groups.slice(mid), writeSubset, handlers);
  }
};
