import {
  type DatasetRunItemRecordInsertType,
  type ObservationRecordInsertType,
  type ScoreRecordInsertType,
  type TraceRecordInsertType,
} from "../../repositories/definitions";
import { USAGE_COST_KNOWN_KEYS } from "../sql/fragments";
import { GreptimeTable } from "./tableSchemas";

// Standard input/output/total are read straight from the observations usage_details/cost_details
// JSON columns on every read path (dashboard Q1), so exploding them into the EAV table would be
// pure write amplification: the only EAV reader (dashboard Q2) excludes them with a NOT IN guard.
// Only custom/dynamic keys (cache_read, reasoning, ...) need the per-key EAV fan-out.
const KNOWN_USAGE_COST_KEYS = new Set<string>(USAGE_COST_KNOWN_KEYS);

/**
 * Record -> GreptimeDB gRPC row mappers + EAV fan-out (02-write-path.md, step 5).
 *
 * Extracted from the worker `GreptimeWriter` so the worker write path and the shared
 * seeder produce byte-identical projection + EAV rows. A logical entity fans out to its
 * projection row plus EAV subtable rows (metadata key/value, tags); `buildGreptimeRowsForRecord`
 * is the single reusable unit both call sites use.
 */

export type GreptimeRow = Record<string, unknown>;

/** A projection/EAV physical table name paired with the rows destined for it. */
export type GreptimeTableRows = { table: string; rows: GreptimeRow[] };

const jsonOrNull = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : JSON.stringify(v);

const num = (v: number | null | undefined): number | null => v ?? null;

export const traceRow = (r: TraceRecordInsertType): GreptimeRow => ({
  project_id: r.project_id,
  id: r.id,
  timestamp: r.timestamp,
  name: r.name ?? null,
  environment: r.environment,
  session_id: r.session_id ?? null,
  user_id: r.user_id ?? null,
  release: r.release ?? null,
  version: r.version ?? null,
  tags: jsonOrNull(r.tags ?? []),
  metadata: jsonOrNull(r.metadata ?? {}),
  bookmarked: r.bookmarked ?? null,
  public: r.public ?? null,
  input: r.input ?? null,
  output: r.output ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
  is_deleted: Boolean(r.is_deleted),
});

export const observationRow = (r: ObservationRecordInsertType): GreptimeRow => {
  const cost = r.cost_details ?? {};
  const usage = r.usage_details ?? {};
  return {
    project_id: r.project_id,
    id: r.id,
    start_time: r.start_time,
    type: r.type ?? null,
    trace_id: r.trace_id ?? null,
    parent_observation_id: r.parent_observation_id ?? null,
    environment: r.environment,
    name: r.name ?? null,
    level: r.level ?? null,
    status_message: r.status_message ?? null,
    version: r.version ?? null,
    end_time: num(r.end_time),
    completion_start_time: num(r.completion_start_time),
    provided_model_name: r.provided_model_name ?? null,
    internal_model_id: r.internal_model_id ?? null,
    model_parameters: jsonOrNull(r.model_parameters),
    input: r.input ?? null,
    output: r.output ?? null,
    metadata: jsonOrNull(r.metadata ?? {}),
    // Flattened cost/usage columns; full maps preserved in the JSON columns below.
    input_cost: num(cost["input"]),
    output_cost: num(cost["output"]),
    total_cost: num(r.total_cost ?? cost["total"]),
    input_usage: num(usage["input"]),
    output_usage: num(usage["output"]),
    total_usage: num(usage["total"]),
    usage_details: jsonOrNull(usage),
    cost_details: jsonOrNull(cost),
    provided_usage_details: jsonOrNull(r.provided_usage_details ?? {}),
    provided_cost_details: jsonOrNull(r.provided_cost_details ?? {}),
    usage_pricing_tier_id: r.usage_pricing_tier_id ?? null,
    usage_pricing_tier_name: r.usage_pricing_tier_name ?? null,
    prompt_id: r.prompt_id ?? null,
    prompt_name: r.prompt_name ?? null,
    prompt_version: num(r.prompt_version),
    tool_definitions: jsonOrNull(r.tool_definitions ?? {}),
    tool_calls: jsonOrNull(r.tool_calls ?? []),
    tool_call_names: jsonOrNull(r.tool_call_names ?? []),
    created_at: r.created_at,
    updated_at: r.updated_at,
    is_deleted: Boolean(r.is_deleted),
  };
};

export const scoreRow = (r: ScoreRecordInsertType): GreptimeRow => ({
  project_id: r.project_id,
  id: r.id,
  timestamp: r.timestamp,
  name: r.name,
  environment: r.environment,
  source: r.source,
  data_type: r.data_type,
  value: r.value ?? null,
  string_value: r.string_value ?? null,
  long_string_value: r.long_string_value ?? null,
  comment: r.comment ?? null,
  metadata: jsonOrNull(r.metadata ?? {}),
  trace_id: r.trace_id ?? null,
  observation_id: r.observation_id ?? null,
  session_id: r.session_id ?? null,
  dataset_run_id: r.dataset_run_id ?? null,
  execution_trace_id: r.execution_trace_id ?? null,
  author_user_id: r.author_user_id ?? null,
  config_id: r.config_id ?? null,
  queue_id: r.queue_id ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
  is_deleted: Boolean(r.is_deleted),
});

export const datasetRunItemRow = (
  r: DatasetRunItemRecordInsertType,
): GreptimeRow => ({
  project_id: r.project_id,
  id: r.id,
  dataset_run_created_at: r.dataset_run_created_at,
  dataset_id: r.dataset_id ?? null,
  dataset_run_id: r.dataset_run_id ?? null,
  dataset_item_id: r.dataset_item_id ?? null,
  trace_id: r.trace_id ?? null,
  observation_id: r.observation_id ?? null,
  error: r.error ?? null,
  dataset_run_name: r.dataset_run_name ?? null,
  dataset_run_description: r.dataset_run_description ?? null,
  dataset_run_metadata: jsonOrNull(r.dataset_run_metadata ?? {}),
  dataset_item_input: r.dataset_item_input ?? null,
  dataset_item_expected_output: r.dataset_item_expected_output ?? null,
  dataset_item_metadata: jsonOrNull(r.dataset_item_metadata ?? {}),
  dataset_item_version: num(r.dataset_item_version),
  created_at: r.created_at,
  updated_at: r.updated_at,
  is_deleted: Boolean(r.is_deleted),
});

export const metadataRows = (params: {
  metadata: Record<string, string> | undefined;
  projectId: string;
  entityId: string;
  timestamp: number;
  generation: number;
  isDeleted: boolean;
}): GreptimeRow[] =>
  Object.entries(params.metadata ?? {}).map(([key, value]) => ({
    project_id: params.projectId,
    entity_id: params.entityId,
    key,
    timestamp: params.timestamp,
    value: value ?? null,
    is_deleted: params.isDeleted,
    generation: params.generation,
  }));

export const tagRows = (params: {
  tags: string[] | undefined;
  projectId: string;
  entityId: string;
  timestamp: number;
  generation: number;
  isDeleted: boolean;
}): GreptimeRow[] =>
  (params.tags ?? []).map((tag) => ({
    project_id: params.projectId,
    entity_id: params.entityId,
    tag,
    timestamp: params.timestamp,
    is_deleted: params.isDeleted,
    generation: params.generation,
  }));

/**
 * Explode an observation's usage_details / cost_details maps into observations_usage_cost EAV rows
 * (one row per custom key, tagged by `kind`). This is what lets the dashboard aggregate any
 * custom usage/cost key with a server-side GROUP BY instead of the hardcoded input/output/total
 * narrowing GreptimeDB SQL forced before (F5). The standard input/output/total keys are skipped:
 * they are served from the JSON columns on every read path, so the EAV table only carries the
 * long-tail custom keys (zero write amplification for the common case). Non-finite values are
 * dropped, mirroring `mergeUsageOrCostMaps`. `timestamp` carries the observation start_time,
 * matching the EAV convention used by `metadataRows`.
 */
export const usageCostRows = (params: {
  usageDetails: Record<string, number> | undefined;
  costDetails: Record<string, number> | undefined;
  projectId: string;
  entityId: string;
  timestamp: number;
  generation: number;
  isDeleted: boolean;
}): GreptimeRow[] => {
  const rowsForKind = (
    kind: "usage" | "cost",
    map: Record<string, number> | undefined,
  ): GreptimeRow[] =>
    Object.entries(map ?? {})
      .filter(
        ([key, value]) =>
          !KNOWN_USAGE_COST_KEYS.has(key) && Number.isFinite(Number(value)),
      )
      .map(([key, value]) => ({
        project_id: params.projectId,
        entity_id: params.entityId,
        timestamp: params.timestamp,
        kind,
        key,
        value: Number(value),
        is_deleted: params.isDeleted,
        generation: params.generation,
      }));
  return [
    ...rowsForKind("usage", params.usageDetails),
    ...rowsForKind("cost", params.costDetails),
  ];
};

/**
 * Explode an observation's `tool_definitions` map keys into observations_tool_definitions EAV rows
 * (one row per declared/available tool name). This is what lets the dashboard filter and break down
 * by available tool with a project-scoped EAV EXISTS / GROUP BY instead of the `mapKeys(...)` shape
 * GreptimeDB SQL cannot express (05 Finding #1). The full `tool_definitions` map stays on the
 * observations projection (exact restore). `timestamp` carries the observation start_time, matching
 * the EAV convention used by `metadataRows`.
 */
export const toolDefinitionRows = (params: {
  toolDefinitions: Record<string, unknown> | undefined;
  projectId: string;
  entityId: string;
  timestamp: number;
  generation: number;
  isDeleted: boolean;
}): GreptimeRow[] =>
  Object.keys(params.toolDefinitions ?? {}).map((toolName) => ({
    project_id: params.projectId,
    entity_id: params.entityId,
    tool_name: toolName,
    timestamp: params.timestamp,
    is_deleted: params.isDeleted,
    generation: params.generation,
  }));

/**
 * Explode an observation's `tool_call_names` array into observations_tool_calls EAV rows (one row
 * per distinct invoked tool name). Counterpart of `toolDefinitionRows` for the `calledToolNames`
 * surface. Names are de-duplicated: the PK already collapses repeats under `last_non_null`, and a
 * called-tool membership filter / breakdown is set-semantic, so emitting one row per distinct name
 * avoids redundant writes.
 */
export const toolCallRows = (params: {
  toolCallNames: string[] | undefined;
  projectId: string;
  entityId: string;
  timestamp: number;
  generation: number;
  isDeleted: boolean;
}): GreptimeRow[] =>
  [...new Set(params.toolCallNames ?? [])].map((toolName) => ({
    project_id: params.projectId,
    entity_id: params.entityId,
    tool_name: toolName,
    timestamp: params.timestamp,
    is_deleted: params.isDeleted,
    generation: params.generation,
  }));

/**
 * Map a logical record to all physical rows it produces: the projection row plus its EAV
 * subtable rows (traces -> traces + traces_metadata + traces_tags; observations -> observations
 * + observations_metadata; scores -> scores + scores_metadata; dataset_run_items -> projection
 * only, metadata is display-only JSON). Empty EAV groups are omitted so callers don't emit
 * no-op writes. This is the shared fan-out both the worker writer and the seeder rely on.
 */
/**
 * The EAV `generation` to stamp when the caller does not supply one (seeder, smoke scripts, tests).
 * The live ingestion path passes the rebuild's max(ingested_at) explicitly; this fallback derives a
 * best-effort monotonic value from the record so a one-shot writer still produces correlatable rows.
 */
let lastFallbackGeneration = 0;

const fallbackGeneration = (record: Record<string, unknown>): number => {
  const base = Number(
    record.updated_at ??
      record.timestamp ??
      record.start_time ??
      record.created_at ??
      Date.now(),
  );
  const next = Number.isFinite(base) ? base * 4096 : Date.now() * 4096;
  lastFallbackGeneration = Math.max(lastFallbackGeneration + 1, next);
  return lastFallbackGeneration;
};

export const buildGreptimeRowsForRecord = (
  table: GreptimeTable,
  record:
    | TraceRecordInsertType
    | ObservationRecordInsertType
    | ScoreRecordInsertType
    | DatasetRunItemRecordInsertType,
  // Monotonic EAV generation for this rebuild (max ingested_at). Stamped on the projection row
  // (`eav_generation`) and every EAV row (`generation`) so a read selects the entity's current EAV
  // set by correlation, with no up-front DELETE. Defaults to a record-derived value for one-shot
  // callers (seeder/tests) that do not rebuild from raw_events.
  generation?: number,
): GreptimeTableRows[] => {
  const out: GreptimeTableRows[] = [];
  const gen =
    generation ?? fallbackGeneration(record as Record<string, unknown>);
  const pushRows = (name: string, rows: GreptimeRow[]) => {
    if (rows.length > 0) out.push({ table: name, rows });
  };

  switch (table) {
    case GreptimeTable.Traces: {
      const r = record as TraceRecordInsertType;
      out.push({
        table: "traces",
        rows: [{ ...traceRow(r), eav_generation: gen }],
      });
      pushRows(
        "traces_metadata",
        metadataRows({
          metadata: r.metadata,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.timestamp,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      pushRows(
        "traces_tags",
        tagRows({
          tags: r.tags,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.timestamp,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      break;
    }
    case GreptimeTable.Observations: {
      const r = record as ObservationRecordInsertType;
      out.push({
        table: "observations",
        rows: [{ ...observationRow(r), eav_generation: gen }],
      });
      pushRows(
        "observations_metadata",
        metadataRows({
          metadata: r.metadata,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.start_time,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      pushRows(
        "observations_usage_cost",
        usageCostRows({
          usageDetails: r.usage_details,
          costDetails: r.cost_details,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.start_time,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      pushRows(
        "observations_tool_definitions",
        toolDefinitionRows({
          toolDefinitions: r.tool_definitions,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.start_time,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      pushRows(
        "observations_tool_calls",
        toolCallRows({
          toolCallNames: r.tool_call_names,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.start_time,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      break;
    }
    case GreptimeTable.Scores: {
      const r = record as ScoreRecordInsertType;
      out.push({
        table: "scores",
        rows: [{ ...scoreRow(r), eav_generation: gen }],
      });
      pushRows(
        "scores_metadata",
        metadataRows({
          metadata: r.metadata,
          projectId: r.project_id,
          entityId: r.id,
          timestamp: r.timestamp,
          generation: gen,
          isDeleted: Boolean(r.is_deleted),
        }),
      );
      break;
    }
    case GreptimeTable.DatasetRunItems: {
      // dataset_run_items has no EAV subtables, so it needs no generation.
      out.push({
        table: "dataset_run_items",
        rows: [datasetRunItemRow(record as DatasetRunItemRecordInsertType)],
      });
      break;
    }
  }
  return out;
};
