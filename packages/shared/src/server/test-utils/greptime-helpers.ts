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
  EventRecordInsertType,
} from "../repositories/definitions";
import { metadataArraysToRecord } from "../utils/metadata_conversion";

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

/* ------------------------------------------------------------------------- *
 * Event-collapse seeding
 *
 * The legacy `events_full` table is gone. Tests that seeded `events_full` via
 * `createEventsCh` and read it back through the `*FromEventsTable` repository
 * functions now hit the merged GreptimeDB observations projection (with the
 * trace-level userId/sessionId/traceName/tags LEFT-joined from the traces
 * table at read time). `createEventsAsGreptime` is the drop-in seed replacement:
 * it decomposes each `EventRecordInsertType` into an observation row and,
 * optionally, a synthesized trace row carrying the denormalised trace-level
 * fields so the read-time join populates them.
 * ------------------------------------------------------------------------- */

// events_full stores microsecond epochs; the projection record types are millis.
const microsToMillis = (micros: number): number => Math.floor(micros / 1000);

/**
 * 1:1 event -> observation projection record. Drops events-only columns
 * (experiment_*, telemetry_*, span aliases) the observations projection does
 * not carry; folds `metadata_names`/`metadata_values` arrays into a map and
 * `model_id` into `internal_model_id`.
 */
export const eventRecordToObservationInsert = (
  event: EventRecordInsertType,
): ObservationRecordInsertType => ({
  // The observations projection is keyed by span id; `event.id` equals `span_id`
  // for normal events but tests may set them apart, and the experiment
  // root-span latency join resolves on `span_id == experiment_item_root_span_id`.
  id: event.span_id,
  trace_id: event.trace_id,
  project_id: event.project_id,
  type: event.type,
  parent_observation_id: event.parent_span_id,
  environment: event.environment,
  name: event.name,
  metadata:
    metadataArraysToRecord(event.metadata_names, event.metadata_values) ?? {},
  level: event.level,
  status_message: event.status_message,
  version: event.version,
  input: event.input,
  output: event.output,
  provided_model_name: event.provided_model_name,
  internal_model_id: event.model_id,
  model_parameters: event.model_parameters,
  total_cost: event.cost_details?.total ?? undefined,
  usage_pricing_tier_id: event.usage_pricing_tier_id,
  usage_pricing_tier_name: event.usage_pricing_tier_name,
  prompt_id: event.prompt_id,
  prompt_name: event.prompt_name,
  prompt_version: event.prompt_version,
  tool_definitions: event.tool_definitions,
  tool_calls: event.tool_calls,
  tool_call_names: event.tool_call_names,
  provided_usage_details: event.provided_usage_details,
  usage_details: event.usage_details,
  provided_cost_details: event.provided_cost_details,
  cost_details: event.cost_details,
  is_deleted: event.is_deleted,
  start_time: microsToMillis(event.start_time),
  end_time: event.end_time != null ? microsToMillis(event.end_time) : undefined,
  completion_start_time:
    event.completion_start_time != null
      ? microsToMillis(event.completion_start_time)
      : undefined,
  created_at: microsToMillis(event.created_at),
  updated_at: microsToMillis(event.updated_at),
  event_ts: microsToMillis(event.event_ts),
});

/**
 * Synthesize one trace per distinct `trace_id`, hoisting the trace-level
 * denormalised fields (userId/sessionId/tags/release/traceName) the read-time
 * join expects. Prefers the `is_app_root` event for root-level fields, falling
 * back to the first event of the group.
 */
export const eventRecordsToTraceInserts = (
  events: EventRecordInsertType[],
): TraceRecordInsertType[] => {
  const byTrace = new Map<string, EventRecordInsertType[]>();
  for (const event of events) {
    const group = byTrace.get(event.trace_id);
    if (group) group.push(event);
    else byTrace.set(event.trace_id, [event]);
  }

  const traces: TraceRecordInsertType[] = [];
  for (const [traceId, group] of byTrace) {
    const root = group.find((e) => e.is_app_root) ?? group[0];
    const firstDefined = <K extends keyof EventRecordInsertType>(
      key: K,
    ): EventRecordInsertType[K] | undefined =>
      group.find((e) => e[key] != null)?.[key];
    const minStart = Math.min(...group.map((e) => e.start_time));

    traces.push({
      id: traceId,
      project_id: root.project_id,
      name: root.trace_name ?? root.name,
      user_id: firstDefined("user_id"),
      session_id: firstDefined("session_id"),
      metadata:
        metadataArraysToRecord(root.metadata_names, root.metadata_values) ?? {},
      release: firstDefined("release"),
      version: root.version,
      environment: root.environment,
      public: root.public ?? false,
      bookmarked: root.bookmarked ?? false,
      tags: group.find((e) => e.tags.length > 0)?.tags ?? [],
      input: root.input,
      output: root.output,
      timestamp: microsToMillis(minStart),
      created_at: microsToMillis(root.created_at),
      updated_at: microsToMillis(root.updated_at),
      event_ts: microsToMillis(root.event_ts),
      is_deleted: 0,
    });
  }
  return traces;
};

/**
 * Drop-in replacement for the old `createEventsCh` seed. Writes the observation
 * projection rows for every event; with `synthesizeTraces` it also writes a
 * synthesized trace per `trace_id` so trace-level denormalised reads resolve.
 * Pass `synthesizeTraces: false` (default) when the test already seeds matching
 * traces itself.
 */
export const createEventsAsGreptime = async (
  events: EventRecordInsertType[],
  opts?: { synthesizeTraces?: boolean },
): Promise<void> => {
  const observations = events.map(eventRecordToObservationInsert);
  const traces = opts?.synthesizeTraces
    ? eventRecordsToTraceInserts(events)
    : [];
  await writeRecordsToGreptime({ traces, observations });
};

/* ------------------------------------------------------------------------- *
 * Experiment-event-collapse seeding
 *
 * The GreptimeDB experiment readers (`getExperiments*FromEvents`) read
 * `dataset_run_items` joined to traces/observations/scores — an experiment IS a
 * dataset run (`experiment_id == dataset_run_id`,
 * `experiment_item_id == dataset_item_id`,
 * `experiment_item_root_span_id == observation_id`, name/description/dataset_id
 * denormalised onto the run item). Events carrying `experiment_*` columns must
 * therefore seed `dataset_run_items` (+ observations for cost/latency metrics),
 * not the bare observations projection.
 * ------------------------------------------------------------------------- */

// metadata_values on experiment columns are (string | null)[]; coerce for the
// shared string-array zipper.
const coerceValues = (values: (string | null | undefined)[]): string[] =>
  values.map((v) => v ?? "");

/**
 * Maps an experiment-bearing event onto a `dataset_run_items` projection row,
 * following the `experiment_* -> dataset_run_*` contract the GreptimeDB
 * experiment readers expect.
 */
export const eventRecordToDatasetRunItemInsert = (
  event: EventRecordInsertType,
): DatasetRunItemRecordInsertType => ({
  id: event.id,
  project_id: event.project_id,
  trace_id: event.trace_id,
  observation_id: event.experiment_item_root_span_id ?? null,
  dataset_id: event.experiment_dataset_id ?? "",
  dataset_run_id: event.experiment_id ?? "",
  dataset_item_id: event.experiment_item_id ?? "",
  dataset_run_name: event.experiment_name ?? "",
  dataset_run_description: event.experiment_description,
  dataset_run_metadata:
    metadataArraysToRecord(
      event.experiment_metadata_names,
      coerceValues(event.experiment_metadata_values),
    ) ?? {},
  dataset_item_input: event.input ?? "{}",
  dataset_item_expected_output: event.experiment_item_expected_output ?? "{}",
  dataset_item_metadata:
    metadataArraysToRecord(
      event.experiment_item_metadata_names,
      coerceValues(event.experiment_item_metadata_values),
    ) ?? {},
  // Run-item recency is the iteration's execution time: the dedup that picks the
  // "latest" run item per (run,item) orders by created_at, and tests express
  // iteration order via start_time. Derive all run-item timestamps from it so a
  // later-started iteration deterministically wins.
  dataset_run_created_at: microsToMillis(event.start_time),
  created_at: microsToMillis(event.start_time),
  updated_at: microsToMillis(event.start_time),
  event_ts: microsToMillis(event.start_time),
  is_deleted: event.is_deleted,
  error: null,
});

/**
 * Drop-in replacement for the old `createEventsCh` seed in experiment tests.
 * Seeds a `dataset_run_items` row per event and (by default) a matching
 * observation row so the experiment cost/latency metrics readers — which join
 * observations on `dataset_run_items.trace_id`/`observation_id` — resolve.
 */
export const createExperimentEventsAsGreptime = async (
  events: EventRecordInsertType[],
  opts?: { withObservations?: boolean },
): Promise<void> => {
  const datasetRunItems = events.map(eventRecordToDatasetRunItemInsert);
  const observations =
    (opts?.withObservations ?? true)
      ? events.map(eventRecordToObservationInsert)
      : [];
  await writeRecordsToGreptime({ datasetRunItems, observations });
};
