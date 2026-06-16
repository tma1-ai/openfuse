import { DataType, Precision, Table } from "@greptime/ingester";

import { env } from "../../env";
import { getGreptimeIngestClient, greptimeQuery } from "./client";
import { quoteIdent } from "./schemaUtils";

/**
 * raw_events I/O (02-write-path.md, step 2 + step 3).
 *
 * raw_events is the append-only source of truth. The API writes one row per ingestion event
 * (verbatim body); the worker reads the entity's full history back to rebuild a projection
 * snapshot from scratch. No row is ever updated — dedup/ordering happen at read time.
 */

export interface RawEventInput {
  projectId: string;
  entityType: string; // 'trace' | 'observation' | 'score' | 'dataset_run_item'
  entityId: string;
  eventId: string;
  eventType: string;
  /** Logical event time (body timestamp/startTime), ms epoch; null when absent. */
  eventTs: number | null;
  /** Ingestion time, ms epoch — the append-order time index. */
  ingestedAt: number;
  /** Raw event JSON, stored verbatim. */
  body: string;
}

export interface RawEventRow {
  ingested_at: Date | string;
  event_id: string;
  event_type: string;
  event_ts: Date | string | null;
  body: string;
}

const buildRawEventsTable = (rows: RawEventInput[]): Table => {
  const table = Table.new(env.GREPTIME_RAW_EVENTS_TABLE)
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("entity_type", DataType.String)
    .addTagColumn("entity_id", DataType.String)
    .addTimestampColumn("ingested_at", Precision.Millisecond)
    .addFieldColumn("event_id", DataType.String)
    .addFieldColumn("event_type", DataType.String)
    .addFieldColumn("event_ts", DataType.TimestampMillisecond)
    .addFieldColumn("body", DataType.String);

  for (const r of rows) {
    table.addRowObject({
      project_id: r.projectId,
      entity_type: r.entityType,
      entity_id: r.entityId,
      ingested_at: r.ingestedAt,
      event_id: r.eventId,
      event_type: r.eventType,
      event_ts: r.eventTs,
      body: r.body,
    });
  }
  return table;
};

/**
 * Append events to raw_events. Fail-closed: the caller must treat a rejection as a hard ingestion
 * failure (the source of truth was not durably written).
 */
export const writeRawEvents = async (rows: RawEventInput[]): Promise<void> => {
  if (rows.length === 0) return;
  await getGreptimeIngestClient().write(buildRawEventsTable(rows));
};

/**
 * Read the complete history of an entity from raw_events, oldest-first by ingestion time.
 * Dedup + deterministic replay ordering happen downstream (IngestionService).
 */
export const readRawEventsForEntity = async (params: {
  projectId: string;
  entityType: string;
  entityId: string;
}): Promise<RawEventRow[]> => {
  const table = quoteIdent(env.GREPTIME_RAW_EVENTS_TABLE);
  return greptimeQuery<RawEventRow>({
    query: `
      SELECT ${quoteIdent("ingested_at")}, ${quoteIdent("event_id")}, ${quoteIdent("event_type")}, ${quoteIdent("event_ts")}, ${quoteIdent("body")}
      FROM ${table}
      WHERE ${quoteIdent("project_id")} = ?
        AND ${quoteIdent("entity_type")} = ?
        AND ${quoteIdent("entity_id")} = ?
      ORDER BY ${quoteIdent("ingested_at")} ASC, ${quoteIdent("event_id")} ASC
    `,
    params: [params.projectId, params.entityType, params.entityId],
    readOnly: true,
  });
};

export interface RawEventEntityRef {
  entity_type: string;
  entity_id: string;
}

/**
 * Enumerate distinct (entity_type, entity_id) for a project from raw_events, keyset-paginated so a
 * long-running reconciliation scan is stable: raw_events is append-only and grows during the scan, so
 * LIMIT/OFFSET would skip or duplicate rows. Pass the last ref of a page as `cursor` to fetch the
 * next page; omit it for the first page. Returns up to `limit` refs ordered by (entity_type, entity_id).
 */
export const listRawEventEntities = async (params: {
  projectId: string;
  limit: number;
  cursor?: { entityType: string; entityId: string };
}): Promise<RawEventEntityRef[]> => {
  const table = quoteIdent(env.GREPTIME_RAW_EVENTS_TABLE);
  const entityType = quoteIdent("entity_type");
  const entityId = quoteIdent("entity_id");
  const projectId = quoteIdent("project_id");

  // Keyset predicate over the composite (entity_type, entity_id) order, written out (not a row-value
  // comparison) for engine portability.
  const where = params.cursor
    ? `WHERE ${projectId} = ? AND (${entityType} > ? OR (${entityType} = ? AND ${entityId} > ?))`
    : `WHERE ${projectId} = ?`;
  const bind = params.cursor
    ? [
        params.projectId,
        params.cursor.entityType,
        params.cursor.entityType,
        params.cursor.entityId,
      ]
    : [params.projectId];

  // Clamp to a finite positive integer before interpolating into the SQL: a NaN/Infinity limit would
  // otherwise render `LIMIT NaN`/`LIMIT Infinity` and fail at the engine. This helper is exported, so
  // it must guard its own interpolation rather than trust callers.
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit))
    : 1;

  return greptimeQuery<RawEventEntityRef>({
    query: `
      SELECT DISTINCT ${entityType}, ${entityId}
      FROM ${table}
      ${where}
      ORDER BY ${entityType} ASC, ${entityId} ASC
      LIMIT ${limit}
    `,
    params: bind,
    readOnly: true,
  });
};
