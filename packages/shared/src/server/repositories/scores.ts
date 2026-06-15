import { z } from "zod";
import {
  ScoreDataTypeType,
  ScoreDomain,
  ScoreSourceType,
  AggregatableScoreDataType,
  ScoreByDataType,
  LISTABLE_SCORE_TYPES,
  ScoreDataTypeEnum,
} from "../../domain/scores";
import { InvalidRequestError, InternalServerError } from "../../errors";
import type { APIScoreV3 } from "../../features/scores/interfaces/api/v3/schemas";
import type { ScoreFieldGroupV3 } from "../../features/scores/interfaces/api/v3/endpoints";
import { filterAndValidateV3GetScoreList } from "../../features/scores/interfaces/api/v3/validation";
import { FilterList } from "../queries";
import { FilterCondition, FilterState, TimeFilter } from "../../types";
import { OrderByState } from "../../interfaces/orderBy";
import { PreferredClickhouseService } from "../clickhouse/client";
import { ScoreRecordReadType } from "./definitions";
import { env } from "../../env";
import { _handleGetScoreById, _handleGetScoresByIds } from "./scores-utils";
import type { AnalyticsScoreEvent } from "../analytics-integrations/types";
import { ClickHouseClientConfigOptions } from "@clickhouse/client";
import { logger } from "../logger";
import * as greptimeScoreReads from "./greptime/scores";
import { upsertScoreToGreptime } from "./greptime/mutations";
import {
  streamScoresForAnalyticsGreptime,
  streamScoresForBlobGreptime,
} from "./greptime/exportToSink";

export const searchExistingAnnotationScore = (
  projectId: string,
  observationId: string | null,
  traceId: string | null,
  sessionId: string | null,
  name: string | undefined,
  configId: string | undefined,
  dataType: ScoreDataTypeType,
) =>
  greptimeScoreReads.searchExistingAnnotationScore(
    projectId,
    observationId,
    traceId,
    sessionId,
    name,
    configId,
    dataType,
  );

export const getScoreById = async ({
  projectId,
  scoreId,
  source,
}: {
  projectId: string;
  scoreId: string;
  source?: ScoreSourceType;
}): Promise<ScoreDomain | undefined> => {
  return _handleGetScoreById({
    projectId,
    scoreId,
    source,
    scoreScope: "all",
  });
};

export const getScoresByIds = async (
  projectId: string,
  scoreId: string[],
  source?: ScoreSourceType,
): Promise<ScoreDomain[]> => {
  return _handleGetScoresByIds({
    projectId,
    scoreId,
    source,
    scoreScope: "all",
    dataTypes: LISTABLE_SCORE_TYPES,
  });
};

/**
 * Accepts a score in a Clickhouse-ready format.
 * id, project_id, name, and timestamp must always be provided.
 */
export const upsertScore = async (score: Partial<ScoreRecordReadType>) => {
  if (!["id", "project_id", "name", "timestamp"].every((key) => key in score)) {
    throw new Error("Identifier fields must be provided to upsert Score.");
  }
  await upsertScoreToGreptime(score);
};

export type GetScoresForTracesProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  traceIds: string[];
  level?: "trace" | "observation" | "all";
  timestamp?: Date;
  limit?: number;
  offset?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
  preferredClickhouseService?: PreferredClickhouseService;
};

type GetScoresForSessionsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  sessionIds: string[];
  limit?: number;
  offset?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

type GetScoresForExperimentsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  runIds: string[];
  limit?: number;
  offset?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

export const getScoresForSessions = <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForSessionsProps<ExcludeMetadata, IncludeHasMetadata>,
) => greptimeScoreReads.getScoresForSessions(props);

export const getScoresForExperiments = <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForExperimentsProps<ExcludeMetadata, IncludeHasMetadata>,
) =>
  greptimeScoreReads.getScoresForExperiments(props) as unknown as Promise<
    ScoreByDataType<AggregatableScoreDataType>[]
  >;

export const getTraceScoresForDatasetRuns = (
  projectId: string,
  datasetRunIds: string[],
): Promise<Array<{ datasetRunId: string } & any>> =>
  greptimeScoreReads.getTraceScoresForDatasetRuns(projectId, datasetRunIds);

export const getScoresForExperimentItems = (
  projectId: string,
  experimentIds: string[],
): Promise<
  Array<
    ScoreByDataType<AggregatableScoreDataType> & {
      experimentId: string;
      hasMetadata: boolean;
    }
  >
> =>
  greptimeScoreReads.getScoresForExperimentItems(
    projectId,
    experimentIds,
  ) as unknown as Promise<
    Array<
      ScoreByDataType<AggregatableScoreDataType> & {
        experimentId: string;
        hasMetadata: boolean;
      }
    >
  >;

// Used in multiple places, including the public API, hence the non-default exclusion of metadata via excludeMetadata flag
export const getScoresForTraces = <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForTracesProps<ExcludeMetadata, IncludeHasMetadata>,
) => greptimeScoreReads.getScoresForTraces(props);

export const getScoresAndCorrectionsForTraces = <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForTracesProps<ExcludeMetadata, IncludeHasMetadata>,
) => greptimeScoreReads.getScoresAndCorrectionsForTraces(props);

export type GetScoresForObservationsProps<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
> = {
  projectId: string;
  observationIds: string[];
  /**
   * When provided, adds `AND s.timestamp >= minTimestamp - SCORE_TO_TRACE_OBSERVATIONS_INTERVAL`
   * to the query so ClickHouse can prune monthly partitions and avoid full-table scans.
   * Pass the minimum startTime of the observations whose scores you are fetching.
   */
  minTimestamp?: Date;
  limit?: number;
  offset?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadata?: IncludeHasMetadata;
};

// Currently only used from the observations table, hence the exclusion of metadata without excludeMetadata flag
export const getScoresForObservations = <
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(
  props: GetScoresForObservationsProps<ExcludeMetadata, IncludeHasMetadata>,
) =>
  greptimeScoreReads.getScoresForObservations(props) as unknown as Promise<
    Array<
      ScoreByDataType<ScoreDataTypeType> & {
        hasMetadata: IncludeHasMetadata extends true ? boolean : never;
      }
    >
  >;

export const getScoresGroupedByNameSourceType = (args: {
  projectId: string;
  filter: FilterCondition[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
}) => greptimeScoreReads.getScoresGroupedByNameSourceType(args);

export const getNumericScoresGroupedByName = (
  projectId: string,
  filter?: FilterState,
) => greptimeScoreReads.getNumericScoresGroupedByName(projectId, filter);

export const getCategoricalScoresGroupedByName = (
  projectId: string,
  filter?: FilterState,
) => greptimeScoreReads.getCategoricalScoresGroupedByName(projectId, filter);

export const getScoresUiCount = (props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
}) => greptimeScoreReads.getScoresUiCount(props);

export type ScoreUiTableRow = ScoreDomain & {
  traceName: string | null;
  traceUserId: string | null;
  traceTags: Array<string> | null;
};

export function getScoresUiTable<
  ExcludeMetadata extends boolean,
  IncludeHasMetadata extends boolean,
>(props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
  clickhouseConfigs?: ClickHouseClientConfigOptions;
  excludeMetadata?: ExcludeMetadata;
  includeHasMetadataFlag?: IncludeHasMetadata;
}) {
  return greptimeScoreReads.getScoresUiTable({
    projectId: props.projectId,
    filter: props.filter,
    orderBy: props.orderBy,
    limit: props.limit,
    offset: props.offset,
    excludeMetadata: props.excludeMetadata,
    includeHasMetadataFlag: props.includeHasMetadataFlag,
  }) as unknown as Promise<
    Array<
      ScoreUiTableRow & {
        hasMetadata: IncludeHasMetadata extends true ? boolean : never;
      }
    >
  >;
}

export const getScoresUiCountFromEvents = (props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
}) => greptimeScoreReads.getScoresUiCount(props);

export async function getScoresUiTableFromEvents(props: {
  projectId: string;
  filter: FilterState;
  orderBy: OrderByState;
  limit?: number;
  offset?: number;
}) {
  // The events read path collapses onto the merged GreptimeDB scores projection
  // (there is no separate events_core table). Delegate to the public
  // getScoresUiTable overload so the metadata-omitted return shape is preserved.
  return getScoresUiTable({
    ...props,
    excludeMetadata: true,
    includeHasMetadataFlag: true,
  });
}

export const getScoreNames = (
  projectId: string,
  timestampFilter: FilterState,
) => greptimeScoreReads.getScoreNames(projectId, timestampFilter);

export const getScoreStringValues = (
  projectId: string,
  timestampFilter: FilterState,
) => greptimeScoreReads.getScoreStringValues(projectId, timestampFilter);

export const hasAnyScoreOlderThan = (projectId: string, beforeDate: Date) =>
  greptimeScoreReads.hasAnyScoreOlderThan(projectId, beforeDate);

export const getNumericScoreHistogram = (
  projectId: string,
  filter: FilterState,
  limit: number,
) => greptimeScoreReads.getNumericScoreHistogram(projectId, filter, limit);

export const getAggregatedScoresForPrompts = (
  projectId: string,
  promptIds: string[],
  fetchScoreRelation: "observation" | "trace",
  timestampWindow: { fromTimestamp?: Date; toTimestamp?: Date } = {},
) =>
  greptimeScoreReads.getAggregatedScoresForPrompts(
    projectId,
    promptIds,
    fetchScoreRelation,
    timestampWindow,
  );

export const getScoreCountsByProjectInCreationInterval = (args: {
  start: Date;
  end: Date;
}) => greptimeScoreReads.getScoreCountsByProjectInCreationInterval(args);

export const getScoreCountOfProjectsSinceCreationDate = (args: {
  projectIds: string[];
  start: Date;
}) => greptimeScoreReads.getScoreCountOfProjectsSinceCreationDate(args);

export const getDistinctScoreNames = (p: {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterState;
  isTimestampFilter: (filter: FilterCondition) => filter is TimeFilter;
  clickhouseConfigs?: ClickHouseClientConfigOptions | undefined;
}) =>
  greptimeScoreReads.getDistinctScoreNames({
    projectId: p.projectId,
    cutoffCreatedAt: p.cutoffCreatedAt,
    filter: p.filter,
    isTimestampFilter: p.isTimestampFilter,
  });

export const getScoresForBlobStorageExport = function (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
) {
  return streamScoresForBlobGreptime(projectId, minTimestamp, maxTimestamp);
};

export const getScoresForAnalyticsIntegrations = async function* (
  projectId: string,
  projectName: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  _options: { useGraceHash?: boolean } = {},
) {
  const records = streamScoresForAnalyticsGreptime(
    projectId,
    minTimestamp,
    maxTimestamp,
  );

  const baseUrl = env.NEXTAUTH_URL?.replace("/api/auth", "");
  for await (const record of records) {
    // Determine the effective session_id based on score attachment
    const effectiveSessionId =
      record.score_session_id || record.trace_session_id;

    // Determine the effective trace_id (could be null for session-only or dataset-run-only scores)
    const effectiveTraceId = record.score_trace_id || null;

    yield {
      timestamp: record.timestamp,
      langfuse_score_name: record.name,
      langfuse_score_value: record.value,
      langfuse_score_comment: record.comment,
      langfuse_score_metadata: record.metadata,
      langfuse_score_string_value: record.string_value,
      langfuse_score_data_type: record.data_type,
      langfuse_trace_name: record.trace_name,
      langfuse_trace_id: effectiveTraceId,
      langfuse_user_url: record.trace_user_id
        ? `${baseUrl}/project/${projectId}/users/${encodeURIComponent(record.trace_user_id as string)}`
        : undefined,
      langfuse_id: record.id,
      langfuse_session_id: effectiveSessionId,
      langfuse_project_id: projectId,
      langfuse_project_name: projectName,
      langfuse_user_id: record.trace_user_id || null,
      langfuse_release: record.trace_release,
      langfuse_tags: record.trace_tags,
      langfuse_environment: record.environment,
      langfuse_event_version: "1.0.0",
      langfuse_score_entity_type: record.score_trace_id
        ? "trace"
        : record.score_session_id
          ? "session"
          : record.score_dataset_run_id
            ? "dataset_run"
            : "unknown",
      langfuse_dataset_run_id: record.score_dataset_run_id,
      posthog_session_id: record.posthog_session_id ?? null,
      mixpanel_session_id: record.mixpanel_session_id ?? null,
    } satisfies AnalyticsScoreEvent;
  }
};

export const hasAnyScore = (projectId: string) =>
  greptimeScoreReads.hasAnyScore(projectId);

export const getScoreMetadataById = (
  projectId: string,
  id: string,
  source?: ScoreSourceType,
) => greptimeScoreReads.getScoreMetadataById(projectId, id, source);

/**
 * Get score counts grouped by project and day within a date range.
 *
 * Returns one row per project per day with the count of scores created on that day.
 * Uses half-open interval [startDate, endDate) for filtering based on timestamp.
 *
 * @param startDate - Start of date range (inclusive)
 * @param endDate - End of date range (exclusive)
 * @returns Array of { count, projectId, date } objects
 *
 * @example
 * // Get score counts for March 1-2, 2024
 * const counts = await getScoreCountsByProjectAndDay({
 *   startDate: new Date('2024-03-01T00:00:00Z'),
 *   endDate: new Date('2024-03-03T00:00:00Z')
 * });
 *
 * Note: Skips using FINAL (double counting risk) for faster and cheaper
 * queries against clickhouse. Generous 4x overcompensation before blocking allows
 * for usage aggregation to be meaningful.
 *
 */
export const getScoreCountsByProjectAndDay = (args: {
  startDate: Date;
  endDate: Date;
}) => greptimeScoreReads.getScoreCountsByProjectAndDay(args);

// ─── Cursor helpers (v3 pagination) ───────────────────────────────────────────

export const ScoresCursorV3 = z.discriminatedUnion("v", [
  z.object({
    v: z.literal(1),
    lastTimestamp: z.coerce.date(),
    lastId: z.string(),
  }),
]);
export type ScoresCursorV3Type = z.infer<typeof ScoresCursorV3>;

export const EncodedScoresCursorV3 = z
  .string()
  .transform((val) => {
    try {
      const decoded = Buffer.from(val, "base64url").toString("utf-8");
      return JSON.parse(decoded);
    } catch (_e) {
      throw new InvalidRequestError("Invalid cursor format");
    }
  })
  .pipe(ScoresCursorV3);

export const encodeCursorV3 = (cursor: ScoresCursorV3Type): string =>
  Buffer.from(
    JSON.stringify({
      v: cursor.v,
      lastTimestamp: cursor.lastTimestamp.toISOString(),
      lastId: cursor.lastId,
    }),
  ).toString("base64url");

// ─── v1/v2 public-API score query helpers ─────────────────────────────────────

export type ScoreQueryType = {
  page: number;
  limit: number;
  projectId: string;
  traceId?: string;
  userId?: string;
  name?: string;
  source?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  value?: number;
  scoreId?: string;
  configId?: string;
  sessionId?: string;
  datasetRunId?: string;
  queueId?: string;
  traceTags?: string | string[];
  operator?: string;
  scoreIds?: string[];
  observationId?: string[];
  dataType?: string;
  environment?: string | string[];
  fields?: string[] | null;
  advancedFilters?: FilterState;
};

export const _handleGenerateScoresForPublicApi = (args: {
  projectId: string;
  scoresFilter: FilterList;
  tracesFilter: FilterList;
  scoreScope: "traces_only" | "all";
  includeTrace: boolean;
  needsTraceJoin: boolean;
  pagination?: { limit: number; page: number };
}) => greptimeScoreReads._handleGenerateScoresForPublicApi(args);

export const _handleGetScoresCountForPublicApi = (args: {
  projectId: string;
  scoresFilter: FilterList;
  tracesFilter: FilterList;
  scoreScope: "traces_only" | "all";
  includeTrace: boolean;
  needsTraceJoin: boolean;
}) => greptimeScoreReads._handleGetScoresCountForPublicApi(args);

// ─── v3 public-API score query helpers ────────────────────────────────────────

export type ListFilterParams = {
  id?: string[];
  name?: string[];
  source?: string[];
  dataType?: string[];
  environment?: string[];
  configId?: string[];
  queueId?: string[];
  authorUserId?: string[];
  value?: string[];
  valueMin?: number;
  valueMax?: number;
  traceId?: string[];
  sessionId?: string[];
  observationId?: string[];
  experimentId?: string[];
  fromTimestamp?: Date;
  toTimestamp?: Date;
};

const CORE_COLUMNS_V3 = [
  "s.id as id",
  "s.project_id as project_id",
  "s.timestamp as timestamp",
  "s.environment as environment",
  "s.name as name",
  "s.value as value",
  "s.string_value as string_value",
  "s.long_string_value as long_string_value",
  "s.source as source",
  "s.data_type as data_type",
  "s.created_at as created_at",
  "s.updated_at as updated_at",
  "s.execution_trace_id as execution_trace_id",
];
const DETAILS_COLUMNS_V3 = [
  "s.comment as comment",
  "s.metadata as metadata",
  "s.config_id as config_id",
];
const SUBJECT_COLUMNS_V3 = [
  "s.trace_id as trace_id",
  "s.observation_id as observation_id",
  "s.session_id as session_id",
  "s.dataset_run_id as dataset_run_id",
];
const ANNOTATION_COLUMNS_V3 = [
  "s.author_user_id as author_user_id",
  "s.queue_id as queue_id",
];

export const buildSelectColumns = (fields: ScoreFieldGroupV3[]): string => {
  const selected = [...CORE_COLUMNS_V3];
  if (fields.includes("details")) selected.push(...DETAILS_COLUMNS_V3);
  if (fields.includes("subject")) selected.push(...SUBJECT_COLUMNS_V3);
  if (fields.includes("annotation")) selected.push(...ANNOTATION_COLUMNS_V3);
  return selected.join(",\n    ");
};

export function transformBooleanValueForFilter(v: "true" | "false"): number {
  if (v === "true") return 1;
  if (v === "false") return 0;
  throw new InternalServerError(
    `transformBooleanValueForFilter received unexpected value: ${v}`,
  );
}

export function polymorphicValueForV3(score: {
  dataType: ScoreDataTypeType;
  value: number;
  stringValue?: string | null;
  longStringValue?: string | null;
}): number | boolean | string {
  switch (score.dataType) {
    case ScoreDataTypeEnum.NUMERIC:
      return score.value;
    case ScoreDataTypeEnum.BOOLEAN:
      return score.value === 1;
    case ScoreDataTypeEnum.CATEGORICAL:
    case ScoreDataTypeEnum.TEXT:
      if (score.stringValue == null) {
        throw new InternalServerError(
          `Score with dataType ${score.dataType} is missing its stringValue`,
        );
      }
      return score.stringValue;
    case ScoreDataTypeEnum.CORRECTION:
      if (score.longStringValue == null) {
        throw new InternalServerError(
          "Score with dataType CORRECTION is missing its longStringValue",
        );
      }
      return score.longStringValue;
    default: {
      const _exhaustiveCheck: never = score.dataType;
      throw new InternalServerError(
        `Score has unknown dataType: ${_exhaustiveCheck as string}`,
      );
    }
  }
}

function deriveSubjectForV3(
  score: ScoreDomain,
):
  | { kind: "observation"; id: string; traceId?: string }
  | { kind: "trace" | "session" | "experiment"; id: string } {
  if (score.datasetRunId) {
    return { kind: "experiment", id: score.datasetRunId };
  }
  if (score.observationId) {
    return {
      kind: "observation",
      id: score.observationId,
      ...(score.traceId ? { traceId: score.traceId } : {}),
    };
  }
  if (score.sessionId) {
    return { kind: "session", id: score.sessionId };
  }
  if (!score.traceId) {
    throw new InternalServerError(
      `Score ${score.id} has kind=trace but missing traceId`,
    );
  }
  return { kind: "trace", id: score.traceId };
}

function domainToV3Shared(
  score: ScoreDomain,
  fields: ScoreFieldGroupV3[],
): APIScoreV3 {
  return {
    id: score.id,
    projectId: score.projectId,
    name: score.name,
    dataType: score.dataType,
    value: polymorphicValueForV3({
      dataType: score.dataType,
      value: score.value,
      stringValue: score.stringValue as string | null | undefined,
      longStringValue: score.longStringValue as string | null | undefined,
    }),
    source: score.source,
    timestamp: score.timestamp,
    environment: score.environment,
    createdAt: score.createdAt,
    updatedAt: score.updatedAt,
    ...(fields.includes("details")
      ? {
          comment: score.comment,
          configId: score.configId,
          metadata: score.metadata,
        }
      : {}),
    ...(fields.includes("annotation")
      ? {
          authorUserId: score.authorUserId,
          queueId: score.queueId,
        }
      : {}),
    ...(fields.includes("subject")
      ? { subject: deriveSubjectForV3(score) }
      : {}),
  } as APIScoreV3;
}

export async function listScoresV3ForPublicApi(
  params: {
    projectId: string;
    limit: number;
    cursor?: ScoresCursorV3Type;
    fields: ScoreFieldGroupV3[];
  } & ListFilterParams,
): Promise<{ data: APIScoreV3[]; cursor?: string }> {
  // GreptimeDB merged projection: cursor keyset + dynamic filters live in the greptime reader, which
  // returns domain scores + hasMore; the field-group API shaping stays here.
  const { scores, hasMore } =
    await greptimeScoreReads.listScoresV3RowsForPublicApi(params);

  let nextCursor: string | undefined;
  if (hasMore && scores.length > 0) {
    const last = scores[scores.length - 1];
    nextCursor = encodeCursorV3({
      v: 1,
      lastTimestamp: last.timestamp,
      lastId: last.id,
    });
  }

  const items: APIScoreV3[] = [];
  for (const score of scores) {
    try {
      items.push(domainToV3Shared(score, params.fields));
    } catch (error) {
      logger.error("v3 score row dropped from response: conversion error", {
        error,
        scoreId: score.id,
        projectId: params.projectId,
      });
    }
  }
  return {
    data: filterAndValidateV3GetScoreList(items, (error) => {
      logger.error(
        "v3 score row dropped from response: schema validation error",
        {
          issues: error.issues,
          projectId: params.projectId,
        },
      );
    }),
    cursor: nextCursor,
  };
}
