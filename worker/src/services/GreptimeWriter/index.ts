import { backOff } from "exponential-backoff";
import type { AffectedRows, Table } from "@greptime/ingester";

import {
  bisectGroups,
  buildGreptimeRowsForRecord,
  classifyGreptimeWriteError,
  DatasetRunItemRecordInsertType,
  getGreptimeIngestClient,
  GreptimeRow,
  GreptimeTable,
  logger,
  ObservationRecordInsertType,
  PHYSICAL_TABLES,
  recordGauge,
  recordHistogram,
  recordIncrement,
  ScoreRecordInsertType,
  TraceRecordInsertType,
  instrumentAsync,
  truncateOversizedRow,
  type WriteErrorClassification,
  type WriteGroup,
} from "@langfuse/shared/src/server";

import { env } from "../../env";

/**
 * GreptimeWriter (02-write-path.md, step 5) — ports the legacy ClickHouse writer to the GreptimeDB gRPC
 * ingester. A singleton with one in-memory batch queue per physical table, an interval flush, and
 * size-triggered flushes.
 *
 * The pure parts (gRPC table schemas, record->row mapping, projection+EAV fan-out, write-error
 * classification, group bisection) live in shared (`greptime/ingest/{tableSchemas,rowBuilders,
 * writeErrors}`) so the seeder and any other shared caller produce byte-identical rows; this class is
 * only the queue/batch/flush machinery on top of them.
 *
 * Batch-failure isolation: the unary gRPC write is all-or-nothing per request with no per-row
 * diagnostics, so one bad/oversized row would otherwise fail the whole flush until it is dropped after
 * maxAttempts — taking every good row co-batched with it. Instead, the normal flush is wrapped in a
 * backOff whose retry predicate only retries *transient* failures; a *deterministic* (poison/oversize)
 * failure breaks out immediately and is handed to `bisectGroups`, which splits the batch by logical
 * group to isolate the bad entity while good entities land. The bisection unit is the logical group —
 * an entity's projection row plus its EAV rows — so bisection never splits a projection from its EAV.
 * (Independently, the per-table `batchSize` splice can still spread one fan-out across flushes if a
 * queue crosses the threshold mid-record; that is pre-existing behaviour, healed by the idempotent
 * full-history rebuild, not something bisection introduces or worsens.)
 */

// Re-exported so existing `import { GreptimeWriter, GreptimeTable } from ".../GreptimeWriter"`
// call sites keep working after the enum moved to shared.
export { GreptimeTable } from "@langfuse/shared/src/server";

interface QueueItem {
  createdAt: number;
  attempts: number;
  /** Logical-group id shared by all physical rows fanned out from one `addToQueue` call. */
  groupId: number;
  row: GreptimeRow;
}

/** Injected so tests can drive `flushAll` with a fake writer (no live DB) and disable the interval. */
type WriteFn = (tables: Table[]) => Promise<AffectedRows>;

export class GreptimeWriter {
  private static instance: GreptimeWriter | null = null;
  private readonly batchSize: number;
  private readonly writeInterval: number;
  private readonly maxAttempts: number;
  private readonly maxFieldBytes: number;
  private readonly queues: Record<string, QueueItem[]>;
  private readonly write: WriteFn;
  /** Size-triggered background flush is only armed on the running singleton; a test writer is fully manual. */
  private readonly autoFlush: boolean;
  private intervalId: NodeJS.Timeout | null = null;
  private isFlushInProgress = false;
  private nextGroupId = 0;

  private constructor(deps: { write: WriteFn; autoStart: boolean }) {
    this.write = deps.write;
    this.batchSize = env.LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE;
    this.writeInterval = env.LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS;
    this.maxAttempts = env.LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS;
    this.maxFieldBytes = env.LANGFUSE_GREPTIME_WRITE_MAX_FIELD_BYTES;
    this.autoFlush = deps.autoStart;
    this.queues = Object.fromEntries(
      Object.keys(PHYSICAL_TABLES).map((t) => [t, [] as QueueItem[]]),
    );
    if (deps.autoStart) this.start();
  }

  public static getInstance(): GreptimeWriter {
    if (!GreptimeWriter.instance) {
      GreptimeWriter.instance = new GreptimeWriter({
        write: (tables) => getGreptimeIngestClient().write(tables),
        autoStart: true,
      });
    }
    return GreptimeWriter.instance;
  }

  /**
   * Build an isolated instance for tests: an injected `write` and no interval, so `flushAll` can be
   * driven explicitly against a fake that throws per row-predicate. Never touches the singleton.
   */
  public static createForTest(deps: { write: WriteFn }): GreptimeWriter {
    return new GreptimeWriter({ write: deps.write, autoStart: false });
  }

  private start(): void {
    logger.info(
      `Starting GreptimeWriter. Interval: ${this.writeInterval} ms, batch size: ${this.batchSize}`,
    );
    this.intervalId = setInterval(() => {
      if (this.isFlushInProgress) return;
      this.isFlushInProgress = true;
      this.flushAll()
        .catch((err) => logger.error("GreptimeWriter interval flushAll", err))
        .finally(() => {
          this.isFlushInProgress = false;
        });
    }, this.writeInterval);
  }

  public async shutdown(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.flushAll(true);
  }

  public addToQueue(
    table: GreptimeTable,
    record:
      | TraceRecordInsertType
      | ObservationRecordInsertType
      | ScoreRecordInsertType
      | DatasetRunItemRecordInsertType,
  ): void {
    // One logical record fans out to its projection row plus EAV rows; they all share a group id so
    // bisection on failure keeps them together (same combined write -> same fate).
    const groupId = this.nextGroupId++;
    for (const { table: physicalTable, rows } of buildGreptimeRowsForRecord(
      table,
      record,
    )) {
      this.pushAll(physicalTable, rows, groupId);
    }
  }

  private push(table: string, row: GreptimeRow, groupId: number): void {
    this.queues[table].push({
      createdAt: Date.now(),
      attempts: 1,
      groupId,
      row,
    });
    if (
      this.autoFlush &&
      this.queues[table].length >= this.batchSize &&
      !this.isFlushInProgress
    ) {
      this.isFlushInProgress = true;
      this.flushAll()
        .catch((err) => logger.error("GreptimeWriter.push flushAll", err))
        .finally(() => {
          this.isFlushInProgress = false;
        });
    }
  }

  private pushAll(table: string, rows: GreptimeRow[], groupId: number): void {
    for (const row of rows) this.push(table, row, groupId);
  }

  /** Build one fresh `Table` per physical table from `(table,row)` pairs (`addRowObject` mutates). */
  private buildTables(
    entries: { table: string; rows: GreptimeRow[] }[],
  ): Table[] {
    return entries.map(({ table, rows }) => {
      const t = PHYSICAL_TABLES[table]();
      for (const row of rows) t.addRowObject(row);
      return t;
    });
  }

  /** Write the rows of the given logical groups in a SINGLE combined call, regrouped per table. */
  private async writeGroups(groups: WriteGroup<QueueItem>[]): Promise<void> {
    const byTable = new Map<string, GreptimeRow[]>();
    for (const group of groups) {
      for (const { table, item } of group.items) {
        const rows = byTable.get(table);
        if (rows) rows.push(item.row);
        else byTable.set(table, [item.row]);
      }
    }
    const tables = this.buildTables(
      [...byTable].map(([table, rows]) => ({ table, rows })),
    );
    await this.write(tables);
  }

  /** Regroup spliced per-table batches into logical groups keyed by `groupId` for bisection. */
  private regroup(
    spliced: { table: string; items: QueueItem[] }[],
  ): WriteGroup<QueueItem>[] {
    const byGroup = new Map<number, WriteGroup<QueueItem>>();
    for (const { table, items } of spliced) {
      for (const item of items) {
        let group = byGroup.get(item.groupId);
        if (!group) {
          group = { groupId: item.groupId, items: [] };
          byGroup.set(item.groupId, group);
        }
        group.items.push({ table, item });
      }
    }
    return [...byGroup.values()];
  }

  /**
   * Requeue items for a later flush with an incremented attempt counter; drop at `maxAttempts`. Used
   * for transient failures (whole batch, or a subset hit during bisection) — fate-sharing preserved.
   */
  private requeueItems(items: { table: string; item: QueueItem }[]): void {
    let dropped = 0;
    for (const { table, item } of items) {
      if (item.attempts < this.maxAttempts) {
        this.queues[table].push({ ...item, attempts: item.attempts + 1 });
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      recordIncrement("langfuse.queue.greptime_writer.rows_dropped", dropped);
      logger.error(
        `GreptimeWriter: dropped ${dropped} row(s) after ${this.maxAttempts} attempts`,
      );
    }
  }

  private requeueGroups(groups: WriteGroup<QueueItem>[]): void {
    const items: { table: string; item: QueueItem }[] = [];
    for (const group of groups) {
      for (const item of group.items) items.push(item);
    }
    this.requeueItems(items);
  }

  /**
   * Terminal action for a single deterministically-failing group. An `oversize` group gets one
   * reactive-truncation retry (cap each whitelisted field, rewrite); if that lands it is saved, if it
   * still fails it is requeued (transient) or dropped (deterministic). A `poison` group is dropped
   * outright — retrying a value/schema/business error is pointless.
   */
  private async handleLeaf(
    group: WriteGroup<QueueItem>,
    classification: WriteErrorClassification,
  ): Promise<void> {
    if (classification.class === "oversize") {
      const truncatedByTable = new Map<string, number>();
      const items = group.items.map(({ table, item }) => {
        const { row, truncated } = truncateOversizedRow(
          table,
          item.row,
          this.maxFieldBytes,
        );
        if (truncated) {
          truncatedByTable.set(table, (truncatedByTable.get(table) ?? 0) + 1);
          return { table, item: { ...item, row } };
        }
        return { table, item };
      });

      if (truncatedByTable.size > 0) {
        const truncatedGroup: WriteGroup<QueueItem> = {
          groupId: group.groupId,
          items,
        };
        try {
          await this.writeGroups([truncatedGroup]);
          for (const [table, count] of truncatedByTable) {
            recordIncrement(
              "langfuse.queue.greptime_writer.rows_truncated",
              count,
              {
                table,
              },
            );
          }
          return;
        } catch (retryErr) {
          const retryClass = classifyGreptimeWriteError(retryErr);
          if (retryClass.class === "transient") {
            this.requeueGroups([truncatedGroup]);
          } else {
            this.dropGroup(group, retryClass);
          }
          return;
        }
      }
    }
    this.dropGroup(group, classification);
  }

  /** Drop a whole group and record the loss per table + the bounded error class. */
  private dropGroup(
    group: WriteGroup<QueueItem>,
    classification: WriteErrorClassification,
  ): void {
    const byTable = new Map<string, number>();
    for (const { table } of group.items) {
      byTable.set(table, (byTable.get(table) ?? 0) + 1);
    }
    for (const [table, count] of byTable) {
      recordIncrement("langfuse.queue.greptime_writer.rows_dropped", count, {
        table,
        error_class: classification.errorClass,
      });
    }
    recordIncrement(
      "langfuse.queue.greptime_writer.poison_groups_isolated",
      1,
      {
        error_class: classification.errorClass,
      },
    );
    logger.error(
      `GreptimeWriter: dropped group ${group.groupId} (${group.items.length} row(s), class=${classification.errorClass})`,
    );
  }

  /**
   * Splice one batch from every non-empty physical table and write them all in a SINGLE gRPC call,
   * so an entity's projection row and its EAV rows share fate — they all land, or all requeue.
   *
   * The backOff retry predicate only retries *transient* failures (network/region blips); a
   * *deterministic* poison/oversize failure breaks out immediately (no wasted attempts) and is handed
   * to `bisectGroups`, which splits by logical group to isolate the bad entity while good entities
   * land. GreptimeDB has no cross-table transaction, so any residual server-side partial write is
   * surfaced via metrics/logs and healed by the idempotent full-history rebuild on reprocess.
   */
  public async flushAll(fullQueue = false): Promise<void> {
    return instrumentAsync({ name: "write-to-greptime" }, async () => {
      const spliced: { table: string; items: QueueItem[] }[] = [];
      for (const table of Object.keys(this.queues)) {
        const q = this.queues[table];
        if (q.length === 0) continue;
        spliced.push({
          table,
          items: q.splice(0, fullQueue ? q.length : this.batchSize),
        });
      }
      if (spliced.length === 0) return;
      const total = spliced.reduce((n, s) => n + s.items.length, 0);

      try {
        await backOff(
          () =>
            this.write(
              this.buildTables(
                spliced.map(({ table, items }) => ({
                  table,
                  rows: items.map((i) => i.row),
                })),
              ),
            ),
          {
            numOfAttempts: this.maxAttempts,
            startingDelay: 100,
            timeMultiple: 2,
            maxDelay: 1000,
            // Only transient failures retry; deterministic poison/oversize stops immediately so it
            // can be bisected rather than burning the whole attempt budget on a doomed write.
            retry: (err) =>
              classifyGreptimeWriteError(err).class === "transient",
          },
        );
        recordGauge("greptime_writer_insert", total, { unit: "records" });
        recordHistogram("langfuse.queue.greptime_writer.batch_size", total);
      } catch (err) {
        const classification = classifyGreptimeWriteError(err);
        if (classification.class === "transient") {
          logger.error("GreptimeWriter.flushAll (transient)", err);
          const items: { table: string; item: QueueItem }[] = [];
          for (const { table, items: queueItems } of spliced) {
            for (const item of queueItems) items.push({ table, item });
          }
          this.requeueItems(items);
          return;
        }
        // Deterministic failure: isolate the bad group(s) so good groups still land.
        logger.error(
          `GreptimeWriter.flushAll bisecting (class=${classification.errorClass})`,
          err,
        );
        recordIncrement("langfuse.queue.greptime_writer.bisect_runs", 1, {
          error_class: classification.errorClass,
        });
        await bisectGroups(
          this.regroup(spliced),
          (gs) => this.writeGroups(gs),
          {
            onTransient: (gs) => this.requeueGroups(gs),
            onPoisonLeaf: (group, leafClass) =>
              this.handleLeaf(group, leafClass),
          },
        );
      }
    });
  }
}
