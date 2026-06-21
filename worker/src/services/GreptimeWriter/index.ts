import { backOff } from "exponential-backoff";
import type { AffectedRows, Table } from "@greptime/ingester";

import {
  bisectGroups,
  buildGreptimeRowsForRecord,
  buildGreptimeTables,
  classifyGreptimeWriteError,
  DatasetRunItemRecordInsertType,
  EAV_TABLES_FOR_PROJECTION,
  GreptimeRow,
  GreptimeTable,
  type GreptimeTableRows,
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
  type BisectHandlers,
  type WriteErrorClassification,
  type WriteGroup,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import { getFlushWorkerPool } from "./flushWorkerPool";
import type { GreptimeProjectionSink } from "./sink";

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
 * The size-triggered flush splices whole groups (`spliceGroupAwareBatch`), so a fan-out is never
 * spread across flushes either; an entity's projection + EAV thus share one atomic write + generation.
 */

// Re-exported so existing `import { GreptimeWriter, GreptimeTable } from ".../GreptimeWriter"`
// call sites keep working after the enum moved to shared.
export { GreptimeTable } from "@langfuse/shared/src/server";
export type { GreptimeProjectionSink } from "./sink";

/** EAV derived-index table names (the fan-out targets), used to tell projection rows from EAV rows. */
const EAV_TABLE_NAMES: ReadonlySet<string> = new Set(
  Object.values(EAV_TABLES_FOR_PROJECTION).flat(),
);

/**
 * Projection (entity) tables: every other physical table. Each `addToQueue` group has exactly one
 * projection row here that defines its entity identity `(table, project_id, id)` — the unit the
 * per-entity in-flight guard serializes so concurrent flushes never reorder one entity's EAV writes.
 */
const PROJECTION_TABLE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(PHYSICAL_TABLES).filter((t) => !EAV_TABLE_NAMES.has(t)),
);

/** Stable per-entity key for the in-flight guard: `table:project_id:id`. */
const entityKeyOf = (table: string, row: GreptimeRow): string =>
  `${table}:${row.project_id as string}:${row.id as string}`;

interface QueueItem {
  createdAt: number;
  attempts: number;
  /** Logical-group id shared by all physical rows fanned out from one `addToQueue` call. */
  groupId: number;
  row: GreptimeRow;
}

/**
 * Table-based write seam used by tests/manual writers: they build `Table`s on the calling thread and
 * inject a fake (no live DB). The running singleton instead offloads via a rows-based `WriteEntriesFn`
 * so the protobuf encode runs in a worker thread; the constructor derives one from the other.
 */
type WriteFn = (tables: Table[]) => Promise<AffectedRows>;

/**
 * Rows-based write seam (the offload boundary). Carries plain clone-safe `(table, rows)` pairs so the
 * singleton can hand them to the flush worker pool, which builds the `Table`s and runs `client.write`
 * off the main event loop. The return value is unused by the writer's accounting (landed rows are
 * counted from the logical groups), so it is intentionally opaque.
 */
type WriteEntriesFn = (entries: GreptimeTableRows[]) => Promise<unknown>;

export class GreptimeWriter implements GreptimeProjectionSink {
  private static instance: GreptimeWriter | null = null;
  private readonly batchSize: number;
  private readonly writeInterval: number;
  private readonly maxAttempts: number;
  private readonly maxFieldBytes: number;
  private readonly queues: Record<string, QueueItem[]>;
  /** The rows-based write seam every flush funnels through (live: worker pool; test/manual: a wrapped fake). */
  private readonly writeEntries: WriteEntriesFn;
  /** Size-triggered background flush is only armed on the running singleton; a test writer is fully manual. */
  private autoFlush: boolean;
  /** Max simultaneously in-flight auto (size/interval) flushes; one entity stays serialized regardless. */
  private readonly maxConcurrentFlushes: number;
  private intervalId: NodeJS.Timeout | null = null;
  /** Count of currently running auto-launched flushes, used to honor `maxConcurrentFlushes`. */
  private inFlightFlushes = 0;
  /** Promises of currently running auto-launched flushes; a full-queue drain awaits these first. */
  private readonly inFlightPromises = new Set<Promise<void>>();
  /**
   * Projection entities (`table:project_id:id`) currently being written by some in-flight flush. The
   * group-aware splice skips any group whose entity is here, so two concurrent flushes never reorder
   * one entity's writes: the latest rebuild must land last so its `generation` wins the `last_non_null`
   * merge (and the projection's `eav_generation` points at it). Replaces the mutual exclusion the old
   * single-flight gate gave for free.
   */
  private readonly inFlightEntities = new Set<string>();
  private nextGroupId = 0;

  private constructor(deps: {
    /** Table-based fake (tests/manual): `Table`s are built on this thread and inspected by the fake. */
    write?: WriteFn;
    /** Rows-based seam (live singleton): offloads build + `client.write` to the flush worker pool. */
    writeEntries?: WriteEntriesFn;
    autoStart: boolean;
    batchSize?: number;
    /** Enable size-triggered auto-flush without arming the interval (tests drive the pump directly). */
    autoFlush?: boolean;
    maxConcurrentFlushes?: number;
  }) {
    // Exactly one seam is injected. A `write` fake is wrapped into the rows-based seam by building the
    // `Table`s here (cheap; the costly protobuf encode that warranted offloading lives in client.write,
    // which the fake stubs out), so the entire writer funnels through one `writeEntries` path.
    const write = deps.write;
    this.writeEntries =
      deps.writeEntries ?? ((entries) => write!(buildGreptimeTables(entries)));
    this.batchSize = deps.batchSize ?? env.LANGFUSE_INGESTION_WRITE_BATCH_SIZE;
    this.writeInterval = env.LANGFUSE_INGESTION_WRITE_INTERVAL_MS;
    this.maxAttempts = env.LANGFUSE_INGESTION_WRITE_MAX_ATTEMPTS;
    this.maxFieldBytes = env.LANGFUSE_GREPTIME_WRITE_MAX_FIELD_BYTES;
    this.maxConcurrentFlushes =
      deps.maxConcurrentFlushes ?? env.LANGFUSE_GREPTIME_MAX_CONCURRENT_FLUSHES;
    // The running singleton auto-flushes and runs the interval; a test writer can opt into the
    // auto-flush pump (to exercise the concurrency cap) without the interval.
    this.autoFlush = deps.autoStart || (deps.autoFlush ?? false);
    this.queues = Object.fromEntries(
      Object.keys(PHYSICAL_TABLES).map((t) => [t, [] as QueueItem[]]),
    );
    if (deps.autoStart) this.start();
  }

  public static getInstance(): GreptimeWriter {
    if (!GreptimeWriter.instance) {
      GreptimeWriter.instance = new GreptimeWriter({
        // Offload build + protobuf-encode + gRPC write to the worker pool; the pool reconstructs a
        // classified error on this thread so isolation/retry on the main thread is unchanged.
        writeEntries: (entries) => getFlushWorkerPool().write(entries),
        autoStart: true,
      });
    }
    return GreptimeWriter.instance;
  }

  /**
   * Build an isolated instance for tests: an injected `write` and no interval, so `flushAll` can be
   * driven explicitly against a fake that throws per row-predicate. Never touches the singleton.
   */
  public static createForTest(deps: {
    /** Table-based fake (the common case): inspect the built `Table`s, throw per row-predicate. */
    write?: WriteFn;
    /** Rows-based seam, to drive the real offload pool from a benchmark without the singleton interval. */
    writeEntries?: WriteEntriesFn;
    batchSize?: number;
    /** Arm the size-triggered auto-flush pump (no interval) to assert concurrency-cap behavior. */
    autoFlush?: boolean;
    maxConcurrentFlushes?: number;
  }): GreptimeWriter {
    return new GreptimeWriter({
      write: deps.write,
      writeEntries: deps.writeEntries,
      autoStart: false,
      batchSize: deps.batchSize,
      autoFlush: deps.autoFlush,
      maxConcurrentFlushes: deps.maxConcurrentFlushes,
    });
  }

  /**
   * Build a non-singleton writer with no background interval, driven entirely by explicit
   * `flushAll`/`resolveGroups` calls. Used by `GreptimeBulkWriter` as its dedicated unary lane for
   * decimal-table projections and bulk-failure fallback, so backfill writes never interleave with the
   * live singleton's queue.
   */
  public static createManual(deps: { write: WriteFn }): GreptimeWriter {
    return new GreptimeWriter({
      write: deps.write,
      autoStart: false,
    });
  }

  private start(): void {
    logger.info(
      `Starting GreptimeWriter. Interval: ${this.writeInterval} ms, batch size: ${this.batchSize}, ` +
        `max concurrent flushes: ${this.maxConcurrentFlushes}`,
    );
    // Time-based drain of partial batches: top up to the concurrency cap whenever there is flushable
    // work, regardless of batchSize.
    this.intervalId = setInterval(() => this.pumpFlushes(), this.writeInterval);
  }

  public async shutdown(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Stop launching new auto-flushes, let the in-flight ones settle (so the entity guard is clear),
    // then drain everything remaining in one full-queue flush.
    this.autoFlush = false;
    await this.flushAll(true);
  }

  /**
   * Launch auto-flushes up to the concurrency cap while there is work whose entity is not already
   * in-flight. Each launch's splice is synchronous, so the cap and the entity guard are evaluated
   * against an up-to-date queue with no interleaving. Re-armed when a flush completes (frees a slot
   * and an entity). A no-op for a manually-driven (non-auto) writer.
   */
  private pumpFlushes(): void {
    if (!this.autoFlush) return;
    while (
      this.inFlightFlushes < this.maxConcurrentFlushes &&
      this.hasFreeFlushableWork()
    ) {
      this.launchFlush();
    }
  }

  /** True if some queued group's projection entity is not currently being written by another flush. */
  private hasFreeFlushableWork(): boolean {
    for (const table of PROJECTION_TABLE_NAMES) {
      for (const item of this.queues[table]) {
        if (!this.inFlightEntities.has(entityKeyOf(table, item.row))) {
          return true;
        }
      }
    }
    return false;
  }

  /** Run one partial flush in the background, tracking it for the cap, the drain, and re-pumping. */
  private launchFlush(): void {
    this.inFlightFlushes++;
    const promise = this.flushAll()
      .catch((err) => {
        logger.error("GreptimeWriter.launchFlush", err);
      })
      .finally(() => {
        this.inFlightFlushes--;
        this.inFlightPromises.delete(promise);
        // A completed flush freed a slot and released its entities; pick up any work it had to skip.
        this.pumpFlushes();
      });
    this.inFlightPromises.add(promise);
  }

  public addToQueue(
    table: GreptimeTable,
    record:
      | TraceRecordInsertType
      | ObservationRecordInsertType
      | ScoreRecordInsertType
      | DatasetRunItemRecordInsertType,
    generation?: number,
  ): void {
    // Stale EAV rows are superseded by the new `generation` (read-time correlation), so the enqueue
    // path is a plain fan-out with no up-front delete.
    this.enqueueRows(buildGreptimeRowsForRecord(table, record, generation));
  }

  /**
   * Enqueue one logical record's already-fanned physical rows (projection + EAV) under a single new
   * group id, so bisection on failure keeps them together (same combined write -> same fate). The
   * row-level seam `addToQueue` is built on; `GreptimeBulkWriter` uses it to route decimal-table rows
   * and bulk-failure fallbacks back into this writer's isolation machinery.
   */
  public enqueueRows(entries: GreptimeTableRows[]): void {
    const groupId = this.nextGroupId++;
    for (const { table, rows } of entries) this.pushAll(table, rows, groupId);
  }

  public pendingRows(): number {
    return Object.values(this.queues).reduce(
      (count, queue) => count + queue.length,
      0,
    );
  }

  private push(table: string, row: GreptimeRow, groupId: number): void {
    this.queues[table].push({
      createdAt: Date.now(),
      attempts: 1,
      groupId,
      row,
    });
    // Size trigger: once a table reaches batchSize there is a full batch to write. The pump launches
    // up to the concurrency cap (no-op when not auto-flushing), so several flushes can pipeline
    // instead of being serialized behind one in-flight flush.
    if (this.queues[table].length >= this.batchSize) {
      this.pumpFlushes();
    }
  }

  private pushAll(table: string, rows: GreptimeRow[], groupId: number): void {
    for (const row of rows) this.push(table, row, groupId);
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
    // Hand the per-table rows to the write seam as one combined unit. Table construction + protobuf
    // encode happen wherever the seam runs (a worker thread for the live singleton), never splitting an
    // entity's projection from its EAV across calls.
    await this.writeEntries(
      [...byTable].map(([table, rows]) => ({ table, rows })),
    );
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
  private async salvageOrDrop(
    group: WriteGroup<QueueItem>,
    classification: WriteErrorClassification,
  ): Promise<boolean> {
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
          return true;
        } catch (retryErr) {
          const retryClass = classifyGreptimeWriteError(retryErr);
          if (retryClass.class === "transient") {
            this.requeueGroups([truncatedGroup]);
          } else {
            this.dropGroup(group, retryClass);
          }
          return false;
        }
      }
    }
    this.dropGroup(group, classification);
    return false;
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
   * Synchronously claim a batch of whole logical groups, marking their entities in-flight. Called as
   * the first statement of `flushAll` BEFORE any await, so concurrent flushes each grab a DISJOINT set
   * of groups with no interleaving — the queues need no lock.
   *
   * A group (an entity's projection row + all its EAV rows, sharing one groupId) is never split.
   * Selection rules:
   *  - skip a group whose entity is already in-flight in another flush (`inFlightEntities`), so one
   *    entity's EAV delete/write is never reordered across concurrent flushes;
   *  - for a partial flush, take at most ONE group per entity (lowest groupId first, preserving the
   *    entity's write order) and stop near `batchSize` (always >= 1 group so an oversized fan-out still
   *    makes progress); `fullQueue` takes every group of every free entity.
   * Selection is by a groupId SET + filter (not a prefix): a requeue re-appends an older groupId at the
   * tail, so the queues are not strictly ordered. Returns the spliced rows plus the entity keys claimed
   * (the caller releases them once the write settles).
   */
  private spliceGroupAwareBatch(fullQueue: boolean): {
    spliced: { table: string; items: QueueItem[] }[];
    claimedEntities: string[];
  } {
    const tables = Object.keys(this.queues);

    // Map each queued group to its projection entity and count its rows. Every group has exactly one
    // projection row, which defines the entity the guard serializes on.
    const groupEntity = new Map<number, string>();
    const rowsByGroup = new Map<number, number>();
    for (const table of tables) {
      const isProjection = PROJECTION_TABLE_NAMES.has(table);
      for (const item of this.queues[table]) {
        rowsByGroup.set(item.groupId, (rowsByGroup.get(item.groupId) ?? 0) + 1);
        if (isProjection) {
          groupEntity.set(item.groupId, entityKeyOf(table, item.row));
        }
      }
    }

    const chosen = new Set<number>();
    const claimed = new Set<string>();
    let total = 0;
    for (const groupId of [...rowsByGroup.keys()].sort((a, b) => a - b)) {
      const entity = groupEntity.get(groupId);
      // Another flush owns this entity — leave the group for a later flush to keep EAV order.
      if (entity !== undefined && this.inFlightEntities.has(entity)) continue;
      if (!fullQueue) {
        // One group per entity per flush: avoids merging two snapshots' EAV under a single delete.
        if (entity !== undefined && claimed.has(entity)) continue;
        const rows = rowsByGroup.get(groupId)!;
        if (chosen.size > 0 && total + rows > this.batchSize) break; // always take >= 1 group
        total += rows;
      }
      chosen.add(groupId);
      if (entity !== undefined) claimed.add(entity);
      if (!fullQueue && total >= this.batchSize) break;
    }

    const spliced: { table: string; items: QueueItem[] }[] = [];
    for (const table of tables) {
      const q = this.queues[table];
      if (q.length === 0) continue;
      const taken: QueueItem[] = [];
      const remaining: QueueItem[] = [];
      for (const item of q)
        (chosen.has(item.groupId) ? taken : remaining).push(item);
      if (taken.length > 0) {
        this.queues[table] = remaining;
        spliced.push({ table, items: taken });
      }
    }

    for (const entity of claimed) this.inFlightEntities.add(entity);
    return { spliced, claimedEntities: [...claimed] };
  }

  /**
   * Splice one group-aware batch and write it in a SINGLE gRPC call, so an entity's projection row and
   * its EAV rows share fate — they all land, or all requeue, never split across flushes.
   *
   * The backOff retry predicate only retries *transient* failures (network/region blips); a
   * *deterministic* poison/oversize failure breaks out immediately (no wasted attempts) and is handed
   * to `bisectGroups`, which splits by logical group to isolate the bad entity while good entities
   * land. GreptimeDB has no cross-table transaction, so any residual server-side partial write is
   * surfaced via metrics/logs and healed by the idempotent full-history rebuild on reprocess.
   */
  public async flushAll(fullQueue = false): Promise<void> {
    // A full-queue drain (shutdown / reconciliation) must see a quiescent queue: wait for the
    // concurrent partial flushes to release their entities, then splice everything that remains. Only
    // partial flushes are auto-launched, so this never awaits itself.
    if (fullQueue && this.inFlightPromises.size > 0) {
      await Promise.allSettled([...this.inFlightPromises]);
    }

    // Splice synchronously, BEFORE any await, so concurrent flushes atomically claim disjoint groups
    // and mark their entities in-flight (see spliceGroupAwareBatch). Hoisted out of instrumentAsync
    // because the claim must not depend on when the tracer's callback first runs.
    const { spliced, claimedEntities } = this.spliceGroupAwareBatch(fullQueue);
    if (spliced.length === 0) return;

    try {
      return await instrumentAsync({ name: "write-to-greptime" }, async () => {
        const total = spliced.reduce((n, s) => n + s.items.length, 0);
        recordHistogram("langfuse.queue.greptime_writer.batch_size", total);

        // No up-front EAV delete: each row carries the rebuild's `generation`, and reads keep only an
        // entity's current generation, so a dropped key is excluded without a delete (which is costly
        // on GreptimeDB — tombstones + compaction pressure that saturated the cluster under live load).
        // The group-aware splice still writes an entity's projection + EAV in one call so they share
        // the same generation atomically.
        let landedRows = 0;
        await this.writeWithIsolation(this.regroup(spliced), {
          onLanded: (gs) => {
            landedRows += gs.reduce((n, g) => n + g.items.length, 0);
          },
          onTransient: (gs) => this.requeueGroups(gs),
          onPoisonLeaf: async (group, leafClass) => {
            // A truncation-salvaged oversize group is durably written; count it too so the insert
            // gauge doesn't under-report this path.
            if (await this.salvageOrDrop(group, leafClass)) {
              landedRows += group.items.length;
            }
          },
        });
        if (landedRows > 0) {
          recordGauge("greptime_writer_insert", landedRows, {
            unit: "records",
          });
        }
      });
    } finally {
      // Release this flush's entities (whether it wrote or requeued) so a later flush can pick them up.
      // Done after the write settles to keep same-entity writes ordered (latest generation lands last).
      for (const entity of claimedEntities)
        this.inFlightEntities.delete(entity);
    }
  }

  /**
   * Write the given logical groups in ONE combined gRPC call, retrying only *transient* failures via
   * backOff; a *deterministic* poison/oversize failure breaks out immediately and is bisected to
   * isolate the bad group while good groups land. The terminal actions for landed / transient / poison
   * subsets are injected, so the queue flush (requeue/drop) and the backfill `resolveGroups` (collect
   * landed ids) share one isolation core instead of forking it.
   */
  private async writeWithIsolation(
    groups: WriteGroup<QueueItem>[],
    handlers: BisectHandlers<QueueItem>,
  ): Promise<void> {
    if (groups.length === 0) return;
    try {
      await backOff(() => this.writeGroups(groups), {
        numOfAttempts: this.maxAttempts,
        startingDelay: 100,
        timeMultiple: 2,
        maxDelay: 1000,
        // Only transient failures retry; deterministic poison/oversize stops immediately so it can be
        // bisected rather than burning the whole attempt budget on a doomed write.
        retry: (err) => classifyGreptimeWriteError(err).class === "transient",
      });
      handlers.onLanded?.(groups);
    } catch (err) {
      const classification = classifyGreptimeWriteError(err);
      if (classification.class === "transient") {
        logger.error("GreptimeWriter.writeWithIsolation (transient)", err);
        handlers.onTransient(groups);
        return;
      }
      logger.error(
        `GreptimeWriter.writeWithIsolation bisecting (class=${classification.errorClass})`,
        err,
      );
      recordIncrement("langfuse.queue.greptime_writer.bisect_runs", 1, {
        error_class: classification.errorClass,
      });
      await bisectGroups(groups, (gs) => this.writeGroups(gs), handlers);
    }
  }

  /**
   * Backfill primitive: write these groups now to a terminal outcome (no queue accumulation) and
   * return the set of group ids that durably landed — including ones salvaged by truncation. Because
   * `landed <=> written`, `GreptimeBulkWriter` gates dependent EAV bulk writes on projection success,
   * never writing EAV orphaned from a dropped projection. Transient-after-backoff groups are requeued
   * onto THIS writer (drained by a later `flushAll(true)`) and reported as not-landed, so their EAV is
   * withheld this run and healed by the idempotent rebuild rather than written ahead of the projection.
   */
  public async resolveGroups(
    groups: { groupId: number; rows: GreptimeTableRows[] }[],
  ): Promise<Set<number>> {
    const landed = new Set<number>();
    if (groups.length === 0) return landed;
    const wgroups: WriteGroup<QueueItem>[] = groups.map((g) => ({
      groupId: g.groupId,
      items: g.rows.flatMap(({ table, rows }) =>
        rows.map((row) => ({
          table,
          item: { createdAt: Date.now(), attempts: 1, groupId: g.groupId, row },
        })),
      ),
    }));
    await this.writeWithIsolation(wgroups, {
      onLanded: (gs) => {
        for (const g of gs) landed.add(g.groupId);
      },
      onTransient: (gs) => this.requeueGroups(gs),
      onPoisonLeaf: async (group, leafClass) => {
        if (await this.salvageOrDrop(group, leafClass)) {
          landed.add(group.groupId);
        }
      },
    });
    return landed;
  }
}
