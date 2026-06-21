import type { GreptimeRow } from "@langfuse/shared/src/server";
import {
  buildGreptimeTables,
  classifyGreptimeWriteError,
  getGreptimeIngestClient,
  type WriteErrorClassification,
} from "@langfuse/shared/src/server/greptime/flushWorkerExports";

/**
 * The heavy half of a flush, run in a `worker_threads` worker so the synchronous protobuf encode
 * inside `client.write` (~70-100ms per fan-out) never blocks the main event loop — the contention that
 * starved per-job reads and collapsed drain. The worker does ONLY rows -> Table -> `client.write`; all
 * ordering/retry/bisection/requeue stays on the main thread.
 *
 * Failures are classified HERE, in the realm holding the live SDK error, because the `instanceof`
 * checks `classifyGreptimeWriteError` relies on cannot survive structured clone. The plain
 * `WriteErrorClassification` crosses back and the main thread rethrows it as `GreptimeWorkerWriteError`,
 * keeping isolation identical to the in-process path. `getGreptimeIngestClient` is a per-realm
 * singleton, so each worker keeps its own gRPC client.
 */

export type FlushEntries = { table: string; rows: GreptimeRow[] }[];

export type FlushResult =
  | { ok: true; affectedRows: number }
  | { ok: false; classification: WriteErrorClassification; message: string };

export async function runFlush(entries: FlushEntries): Promise<FlushResult> {
  try {
    const tables = buildGreptimeTables(entries);
    const affected = await getGreptimeIngestClient().write(tables);
    return { ok: true, affectedRows: affected.value };
  } catch (err) {
    return {
      ok: false,
      classification: classifyGreptimeWriteError(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
