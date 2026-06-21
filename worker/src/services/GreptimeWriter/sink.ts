import type {
  DatasetRunItemRecordInsertType,
  GreptimeTable,
  ObservationRecordInsertType,
  ScoreRecordInsertType,
  TraceRecordInsertType,
} from "@langfuse/shared/src/server";

/**
 * The projection-write surface `IngestionService` and the reconciliation handler depend on. Decouples
 * them from the concrete unary `GreptimeWriter` so the backfill can swap in a bulk implementation
 * (`GreptimeBulkWriter`) without touching the merge/rebuild path. `GreptimeWriter` already satisfies
 * this structurally.
 */
export interface GreptimeProjectionSink {
  addToQueue(
    table: GreptimeTable,
    record:
      | TraceRecordInsertType
      | ObservationRecordInsertType
      | ScoreRecordInsertType
      | DatasetRunItemRecordInsertType,
    // Monotonic EAV generation for this rebuild (max ingested_at). Stamped on the entity's projection
    // + EAV rows so reads select its current EAV set without an up-front DELETE. Omitted by one-shot
    // callers, which fall back to a record-derived value.
    generation?: number,
  ): void;
  /** Drain buffered rows. `fullQueue` flushes everything (used at the end of a reconciliation page). */
  flushAll(fullQueue?: boolean): Promise<void>;
}
