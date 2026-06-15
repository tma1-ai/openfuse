import { getGreptimeIngestClient } from "../greptime/client";
import { buildGreptimeRowsForRecord } from "../greptime/ingest/rowBuilders";
import {
  GreptimeTable,
  PHYSICAL_TABLES,
} from "../greptime/ingest/tableSchemas";
import {
  TraceRecordInsertType,
  ObservationRecordInsertType,
  ScoreRecordInsertType,
  DatasetRunItemRecordInsertType,
} from "../repositories/definitions";

/**
 * GreptimeDB test seed helpers — the projection-write counterparts of the legacy
 * `create*Ch` helpers in `clickhouse-helpers.ts`. They build projection + EAV rows with the
 * same `buildGreptimeRowsForRecord` the worker writer uses and push them through the shared
 * gRPC ingest client. Direct projection write means immediate read-after-write visibility on
 * the merged projection (merge-on-write: a re-seed with the same ids overwrites, never
 * duplicates). They do NOT append `raw_events` — a `*RecordInsertType` snapshot is not a
 * replayable `IngestionEventType` (mirrors the seeder write path; see the 04 read-path plan).
 *
 * GreptimeDB has no events table, so there is no `createEventsGreptime`: tests that seeded
 * `events_full` collapse onto observation seeding.
 */

type EntityBatch = {
  traces?: TraceRecordInsertType[];
  observations?: ObservationRecordInsertType[];
  scores?: ScoreRecordInsertType[];
  datasetRunItems?: DatasetRunItemRecordInsertType[];
};

// Rows per gRPC write call. Bounds message size for bulk seeds.
const GREPTIME_WRITE_CHUNK = 2000;

/**
 * Seed an arbitrary mix of entities in one call. `await` resolves only after every row has been
 * flushed to GreptimeDB, so reads issued afterwards see the data deterministically.
 */
export const writeRecordsToGreptime = async (
  batch: EntityBatch,
): Promise<void> => {
  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  const collect = (
    table: GreptimeTable,
    records: ReadonlyArray<
      | TraceRecordInsertType
      | ObservationRecordInsertType
      | ScoreRecordInsertType
      | DatasetRunItemRecordInsertType
    >,
  ) => {
    for (const record of records) {
      for (const { table: physical, rows } of buildGreptimeRowsForRecord(
        table,
        record,
      )) {
        const acc = rowsByTable.get(physical);
        if (acc) acc.push(...rows);
        else rowsByTable.set(physical, [...rows]);
      }
    }
  };

  if (batch.traces?.length) collect(GreptimeTable.Traces, batch.traces);
  if (batch.observations?.length)
    collect(GreptimeTable.Observations, batch.observations);
  if (batch.scores?.length) collect(GreptimeTable.Scores, batch.scores);
  if (batch.datasetRunItems?.length)
    collect(GreptimeTable.DatasetRunItems, batch.datasetRunItems);

  const client = getGreptimeIngestClient();
  for (const [physical, rows] of rowsByTable) {
    for (let i = 0; i < rows.length; i += GREPTIME_WRITE_CHUNK) {
      const slice = rows.slice(i, i + GREPTIME_WRITE_CHUNK);
      const t = PHYSICAL_TABLES[physical]();
      for (const row of slice) t.addRowObject(row);
      await client.write([t]);
    }
  }
};

export const createTracesGreptime = async (traces: TraceRecordInsertType[]) =>
  writeRecordsToGreptime({ traces });

export const createObservationsGreptime = async (
  observations: ObservationRecordInsertType[],
) => writeRecordsToGreptime({ observations });

export const createScoresGreptime = async (scores: ScoreRecordInsertType[]) =>
  writeRecordsToGreptime({ scores });

export const createDatasetRunItemsGreptime = async (
  datasetRunItems: DatasetRunItemRecordInsertType[],
) => writeRecordsToGreptime({ datasetRunItems });
