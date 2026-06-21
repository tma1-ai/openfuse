import { DataType } from "@greptime/ingester";
import type { Client, BulkWriteOptions } from "@greptime/ingester";

import {
  buildGreptimeRowsForRecord,
  DatasetRunItemRecordInsertType,
  GreptimeRow,
  GreptimeTable,
  instrumentAsync,
  logger,
  ObservationRecordInsertType,
  PHYSICAL_TABLES,
  recordGauge,
  recordHistogram,
  recordIncrement,
  ScoreRecordInsertType,
  TraceRecordInsertType,
} from "@langfuse/shared/src/server";

import { GreptimeWriter } from "../GreptimeWriter";
import type { GreptimeProjectionSink } from "../GreptimeWriter/sink";

/**
 * GreptimeBulkWriter (P1) — a backfill-only projection sink that writes decimal-free tables through
 * GreptimeDB's bulk Arrow Flight DoPut (`createBulkStreamWriter`) instead of unary gRPC, for far higher
 * backfill throughput. Injected into the reconciliation handler behind an env gate; steady-state
 * ingestion keeps using the unary `GreptimeWriter`.
 *
 * Two correctness anchors:
 *   - Bulk rejects `Decimal128`, and `observations` is the only decimal projection. Its projection row
 *     therefore goes unary, and — because the no-JOIN read fast path reads `observations_usage_cost`
 *     EAV *directly* — its EAV bulk is GATED on the projection durably landing (`resolveGroups`), so a
 *     dropped projection never leaves orphaned phantom-cost EAV behind. The gate is schema-driven
 *     (`GATED_ENTITIES`), so a future decimal projection auto-gates.
 *   - All other entities (trace/score/dataset_run_item, projection + EAV) ride bulk; a bulk failure for
 *     a table falls back to the unary writer grouped by entity, so the unary isolation/oversize/poison
 *     machinery still protects those rows.
 */

const hasDecimalColumn = (table: string): boolean =>
  PHYSICAL_TABLES[table]()
    .schema()
    .columns.some((c) => c.dataType === DataType.Decimal128);

// Logical entities whose projection table carries a Decimal128 column (today: just `observations`).
// Each GreptimeTable enum value equals its projection physical-table name, so the schema check is
// applied to the enum value directly. A gated entity's projection goes unary-resolved and its EAV is
// released to bulk only after the projection lands.
const GATED_ENTITIES: ReadonlySet<GreptimeTable> = new Set(
  Object.values(GreptimeTable).filter((t) => hasDecimalColumn(t)),
);

/** One physical row tagged with the logical entity it fanned from, for grouped unary fallback. */
interface BulkRow {
  groupId: number;
  table: string;
  row: GreptimeRow;
}

/** A gated (decimal-projection) entity: projection goes unary-resolved, EAV is released only if it lands. */
interface GatedEntity {
  projectionRow?: GreptimeRow;
  projectionTable?: string;
  eav: { table: string; row: GreptimeRow }[];
}

export class GreptimeBulkWriter implements GreptimeProjectionSink {
  private readonly client: Client;
  private readonly unary: GreptimeWriter;
  private readonly batchSize: number;
  private readonly bulkOpts?: BulkWriteOptions;

  private nextGroupId = 0;
  private gated = new Map<number, GatedEntity>();
  private bulkRows: BulkRow[] = [];

  constructor(deps: {
    client: Client;
    unary: GreptimeWriter;
    batchSize: number;
    bulkOpts?: BulkWriteOptions;
  }) {
    this.client = deps.client;
    this.unary = deps.unary;
    this.batchSize = deps.batchSize;
    this.bulkOpts = deps.bulkOpts;
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
    const groupId = this.nextGroupId++;
    const fanned = buildGreptimeRowsForRecord(table, record, generation);

    if (GATED_ENTITIES.has(table)) {
      // The projection physical table name equals the enum value; everything else is its EAV.
      const entity: GatedEntity = { eav: [] };
      for (const { table: phys, rows } of fanned) {
        if (phys === table) {
          entity.projectionRow = rows[0];
          entity.projectionTable = phys;
        } else {
          for (const row of rows) entity.eav.push({ table: phys, row });
        }
      }
      this.gated.set(groupId, entity);
      return;
    }

    // Non-gated entities (trace/score + EAV) ride bulk together. No pre-write delete: the generation
    // stamped on each row supersedes the entity's prior EAV at read time.
    for (const { table: phys, rows } of fanned) {
      for (const row of rows) this.bulkRows.push({ groupId, table: phys, row });
    }
  }

  // The `GreptimeProjectionSink.flushAll(fullQueue?)` arg is intentionally omitted: a backfill page
  // always drains everything buffered, so there is no partial-flush mode to honour.
  public async flushAll(): Promise<void> {
    return instrumentAsync({ name: "write-to-greptime-bulk" }, async () => {
      // 1. Write gated projections unary to a terminal outcome; learn which entities durably landed.
      const projectionGroups = [...this.gated]
        .filter(([, e]) => e.projectionRow && e.projectionTable)
        .map(([groupId, e]) => ({
          groupId,
          rows: [{ table: e.projectionTable!, rows: [e.projectionRow!] }],
        }));
      const landed = await this.unary.resolveGroups(projectionGroups);

      const notLanded = projectionGroups.length - landed.size;
      if (notLanded > 0) {
        recordIncrement(
          "langfuse.greptime_bulk.gated_projection_not_landed",
          notLanded,
        );
      }

      const pendingProjectionRows = this.unary.pendingRows();
      if (pendingProjectionRows > 0) {
        recordIncrement(
          "langfuse.greptime_bulk.gated_projection_pending_rows",
          pendingProjectionRows,
        );
        throw new Error(
          `GreptimeBulkWriter: ${pendingProjectionRows} gated projection row(s) remain pending`,
        );
      }

      // 2. Release EAV only for entities whose projection landed (never orphan EAV). The EAV rows
      // already carry this rebuild's generation, so no pre-write delete is needed — a dropped key is
      // excluded at read time by the generation correlation.
      for (const [groupId, e] of this.gated) {
        if (!landed.has(groupId)) continue;
        for (const { table, row } of e.eav) {
          this.bulkRows.push({ groupId, table, row });
        }
      }
      this.gated.clear();

      // 3. Bulk-flush per physical table; on a table failure fall back to unary grouped by entity.
      const byTable = new Map<string, BulkRow[]>();
      for (const br of this.bulkRows) {
        const arr = byTable.get(br.table);
        if (arr) arr.push(br);
        else byTable.set(br.table, [br]);
      }
      this.bulkRows = [];

      for (const [table, rows] of byTable) {
        try {
          await this.bulkWriteTable(table, rows);
        } catch (e) {
          logger.error(
            `GreptimeBulkWriter: bulk write failed for ${table}, falling back to unary`,
            e,
          );
          recordIncrement("langfuse.greptime_bulk.fallback_rows", rows.length, {
            table,
          });
          this.fallbackToUnary(table, rows);
        }
      }

      // 4. Drain the unary lane: grouped fallback rows + any projections requeued on transient failure.
      await this.unary.flushAll(true);
      const pendingUnaryRows = this.unary.pendingRows();
      if (pendingUnaryRows > 0) {
        recordIncrement(
          "langfuse.greptime_bulk.unary_pending_rows",
          pendingUnaryRows,
        );
        throw new Error(
          `GreptimeBulkWriter: ${pendingUnaryRows} unary fallback row(s) remain pending`,
        );
      }
    });
  }

  /**
   * Stream one physical table's rows over a single bulk DoPut, chunked at `batchSize`. Rows are encoded
   * as positional arrays in the client `schema` column order; the server matches Arrow fields by name
   * (verified by the bulk smoke), so client/server column ordering is independent. A throw is propagated
   * so the caller falls the whole table back to unary; bulk-acked chunks may then be rewritten, which is
   * safe because projection/EAV writes are idempotent on their primary key.
   */
  private async bulkWriteTable(table: string, rows: BulkRow[]): Promise<void> {
    const schema = PHYSICAL_TABLES[table]().schema();
    const writer = await this.client.createBulkStreamWriter(
      schema,
      this.bulkOpts,
    );
    try {
      for (let i = 0; i < rows.length; i += this.batchSize) {
        const chunk = rows.slice(i, i + this.batchSize);
        await writer.writeRows({
          kind: "rows",
          rows: chunk.map(({ row }) =>
            schema.columns.map((c) => row[c.name] ?? null),
          ),
        });
      }
      const summary = await writer.finish();
      recordGauge(
        "langfuse.greptime_bulk.affected_rows",
        summary.totalAffectedRows,
        { table },
      );
      recordHistogram("langfuse.greptime_bulk.table_rows", rows.length, {
        table,
      });
    } catch (e) {
      writer.cancel(e);
      throw e;
    }
  }

  /** Re-route a failed table's rows to the unary writer, grouped by entity so an entity's rows for that
   *  table keep sharing fate under unary bisection. */
  private fallbackToUnary(table: string, rows: BulkRow[]): void {
    const byGroup = new Map<number, GreptimeRow[]>();
    for (const { groupId, row } of rows) {
      const arr = byGroup.get(groupId);
      if (arr) arr.push(row);
      else byGroup.set(groupId, [row]);
    }
    for (const groupRows of byGroup.values()) {
      this.unary.enqueueRows([{ table, rows: groupRows }]);
    }
  }
}
