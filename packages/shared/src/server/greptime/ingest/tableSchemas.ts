import { DataType, Precision, Table } from "@greptime/ingester";

/**
 * GreptimeDB physical-table gRPC schema builders (02-write-path.md, step 5).
 *
 * Extracted from the worker `GreptimeWriter` so both the worker write path and the
 * shared seeder build identical projection + EAV rows from the same definitions
 * (`packages/shared` must not depend on `worker`). A fresh `Table` is built per flush
 * because `addRowObject` mutates the builder.
 *
 * Column-role contract: PRIMARY KEY columns are TAG, the immutable logical time is the
 * TIMESTAMP, everything else is FIELD. Column names are passed verbatim to the gRPC
 * schema (no SQL, no quoting).
 */

export enum GreptimeTable {
  Traces = "traces",
  Observations = "observations",
  Scores = "scores",
  DatasetRunItems = "dataset_run_items",
}

export const tracesTable = (): Table =>
  Table.new("traces")
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("id", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("name", DataType.String)
    .addFieldColumn("environment", DataType.String)
    .addFieldColumn("session_id", DataType.String)
    .addFieldColumn("user_id", DataType.String)
    .addFieldColumn("release", DataType.String)
    .addFieldColumn("version", DataType.String)
    .addFieldColumn("tags", DataType.Json)
    .addFieldColumn("metadata", DataType.Json)
    .addFieldColumn("bookmarked", DataType.Bool)
    .addFieldColumn("public", DataType.Bool)
    .addFieldColumn("input", DataType.String)
    .addFieldColumn("output", DataType.String)
    .addFieldColumn("created_at", DataType.TimestampMillisecond)
    .addFieldColumn("updated_at", DataType.TimestampMillisecond)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation of this entity's current EAV set; reads correlate `eav.generation = eav_generation`.
    .addFieldColumn("eav_generation", DataType.Int64);

export const observationsTable = (): Table =>
  Table.new("observations")
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("id", DataType.String)
    .addTimestampColumn("start_time", Precision.Millisecond)
    .addFieldColumn("type", DataType.String)
    .addFieldColumn("trace_id", DataType.String)
    .addFieldColumn("parent_observation_id", DataType.String)
    .addFieldColumn("environment", DataType.String)
    .addFieldColumn("name", DataType.String)
    .addFieldColumn("level", DataType.String)
    .addFieldColumn("status_message", DataType.String)
    .addFieldColumn("version", DataType.String)
    .addFieldColumn("end_time", DataType.TimestampMillisecond)
    .addFieldColumn("completion_start_time", DataType.TimestampMillisecond)
    .addFieldColumn("provided_model_name", DataType.String)
    .addFieldColumn("internal_model_id", DataType.String)
    .addFieldColumn("model_parameters", DataType.Json)
    .addFieldColumn("input", DataType.String)
    .addFieldColumn("output", DataType.String)
    .addFieldColumn("metadata", DataType.Json)
    .addDecimalFieldColumn("input_cost", 38, 12)
    .addDecimalFieldColumn("output_cost", 38, 12)
    .addDecimalFieldColumn("total_cost", 38, 12)
    .addFieldColumn("input_usage", DataType.Int64)
    .addFieldColumn("output_usage", DataType.Int64)
    .addFieldColumn("total_usage", DataType.Int64)
    .addFieldColumn("usage_details", DataType.Json)
    .addFieldColumn("cost_details", DataType.Json)
    .addFieldColumn("provided_usage_details", DataType.Json)
    .addFieldColumn("provided_cost_details", DataType.Json)
    .addFieldColumn("usage_pricing_tier_id", DataType.String)
    .addFieldColumn("usage_pricing_tier_name", DataType.String)
    .addFieldColumn("prompt_id", DataType.String)
    .addFieldColumn("prompt_name", DataType.String)
    .addFieldColumn("prompt_version", DataType.Int32)
    .addFieldColumn("tool_definitions", DataType.Json)
    .addFieldColumn("tool_calls", DataType.Json)
    .addFieldColumn("tool_call_names", DataType.Json)
    .addFieldColumn("created_at", DataType.TimestampMillisecond)
    .addFieldColumn("updated_at", DataType.TimestampMillisecond)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation of this entity's current EAV set; reads correlate `eav.generation = eav_generation`.
    .addFieldColumn("eav_generation", DataType.Int64);

export const scoresTable = (): Table =>
  Table.new("scores")
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("id", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("name", DataType.String)
    .addFieldColumn("environment", DataType.String)
    .addFieldColumn("source", DataType.String)
    .addFieldColumn("data_type", DataType.String)
    .addFieldColumn("value", DataType.Float64)
    .addFieldColumn("string_value", DataType.String)
    .addFieldColumn("long_string_value", DataType.String)
    .addFieldColumn("comment", DataType.String)
    .addFieldColumn("metadata", DataType.Json)
    .addFieldColumn("trace_id", DataType.String)
    .addFieldColumn("observation_id", DataType.String)
    .addFieldColumn("session_id", DataType.String)
    .addFieldColumn("dataset_run_id", DataType.String)
    .addFieldColumn("execution_trace_id", DataType.String)
    .addFieldColumn("author_user_id", DataType.String)
    .addFieldColumn("config_id", DataType.String)
    .addFieldColumn("queue_id", DataType.String)
    .addFieldColumn("created_at", DataType.TimestampMillisecond)
    .addFieldColumn("updated_at", DataType.TimestampMillisecond)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation of this entity's current EAV set; reads correlate `eav.generation = eav_generation`.
    .addFieldColumn("eav_generation", DataType.Int64);

export const datasetRunItemsTable = (): Table =>
  Table.new("dataset_run_items")
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("id", DataType.String)
    .addTimestampColumn("dataset_run_created_at", Precision.Millisecond)
    .addFieldColumn("dataset_id", DataType.String)
    .addFieldColumn("dataset_run_id", DataType.String)
    .addFieldColumn("dataset_item_id", DataType.String)
    .addFieldColumn("trace_id", DataType.String)
    .addFieldColumn("observation_id", DataType.String)
    .addFieldColumn("error", DataType.String)
    .addFieldColumn("dataset_run_name", DataType.String)
    .addFieldColumn("dataset_run_description", DataType.String)
    .addFieldColumn("dataset_run_metadata", DataType.Json)
    .addFieldColumn("dataset_item_input", DataType.String)
    .addFieldColumn("dataset_item_expected_output", DataType.String)
    .addFieldColumn("dataset_item_metadata", DataType.Json)
    .addFieldColumn("dataset_item_version", DataType.TimestampMillisecond)
    .addFieldColumn("created_at", DataType.TimestampMillisecond)
    .addFieldColumn("updated_at", DataType.TimestampMillisecond)
    .addFieldColumn("is_deleted", DataType.Bool);

export const metadataTable = (name: string): Table =>
  Table.new(name)
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("entity_id", DataType.String)
    .addTagColumn("key", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("value", DataType.String)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation this row was written at; a read keeps only rows at the entity's current generation.
    .addFieldColumn("generation", DataType.Int64);

export const tagsTable = (name: string): Table =>
  Table.new(name)
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("entity_id", DataType.String)
    .addTagColumn("tag", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation this row was written at; a read keeps only rows at the entity's current generation.
    .addFieldColumn("generation", DataType.Int64);

// EAV usage/cost subtable (observations only): one row per (project, observation, kind, key).
// Tags = PRIMARY KEY (project_id, entity_id, kind, key); `value` is the numeric metric (Float64,
// matching the DOUBLE column in 0008_observations_usage_cost.sql). See rowBuilders.usageCostRows.
export const usageCostTable = (name: string): Table =>
  Table.new(name)
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("entity_id", DataType.String)
    .addTagColumn("kind", DataType.String)
    .addTagColumn("key", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("value", DataType.Float64)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation this row was written at; a read keeps only rows at the entity's current generation.
    .addFieldColumn("generation", DataType.Int64);

// EAV tool-name subtable (observations only): one row per (project, observation, tool_name).
// Tags = PRIMARY KEY (project_id, entity_id, tool_name). See rowBuilders.toolDefinitionRows /
// toolCallRows and 0009_observations_tool_names.sql.
export const toolNameTable = (name: string): Table =>
  Table.new(name)
    .addTagColumn("project_id", DataType.String)
    .addTagColumn("entity_id", DataType.String)
    .addTagColumn("tool_name", DataType.String)
    .addTimestampColumn("timestamp", Precision.Millisecond)
    .addFieldColumn("is_deleted", DataType.Bool)
    // Generation this row was written at; a read keeps only rows at the entity's current generation.
    .addFieldColumn("generation", DataType.Int64);

/**
 * The EAV derived-index tables fanned out from each projection entity (mirrors the per-table groups
 * `buildGreptimeRowsForRecord` emits). Used by the write path to clear an entity's stale EAV rows
 * before re-writing its current set: an EAV key/tag/tool that drops out of an updated entity (a
 * shrunk metadata map, a removed tool) leaves no row in the new fan-out, so without an up-front
 * delete the old row would linger and keep matching `EXISTS` filters / breakdown joins. ClickHouse
 * had no such gap — `tool_definitions`/`metadata` are whole `Map` columns read off the latest
 * ReplacingMergeTree row, so a shrink is naturally reflected. `dataset_run_items` has no EAV tables.
 *
 * MUST stay in sync with the fan-out in `rowBuilders.buildGreptimeRowsForRecord`.
 */
export const EAV_TABLES_FOR_PROJECTION: Partial<
  Record<GreptimeTable, readonly string[]>
> = {
  [GreptimeTable.Traces]: ["traces_metadata", "traces_tags"],
  [GreptimeTable.Observations]: [
    "observations_metadata",
    "observations_usage_cost",
    "observations_tool_definitions",
    "observations_tool_calls",
  ],
  [GreptimeTable.Scores]: ["scores_metadata"],
};

/** Physical table name -> fresh `Table` schema builder. The writer keeps one queue per key. */
export const PHYSICAL_TABLES: Record<string, () => Table> = {
  traces: tracesTable,
  observations: observationsTable,
  scores: scoresTable,
  dataset_run_items: datasetRunItemsTable,
  traces_metadata: () => metadataTable("traces_metadata"),
  observations_metadata: () => metadataTable("observations_metadata"),
  scores_metadata: () => metadataTable("scores_metadata"),
  traces_tags: () => tagsTable("traces_tags"),
  observations_usage_cost: () => usageCostTable("observations_usage_cost"),
  observations_tool_definitions: () =>
    toolNameTable("observations_tool_definitions"),
  observations_tool_calls: () => toolNameTable("observations_tool_calls"),
};
