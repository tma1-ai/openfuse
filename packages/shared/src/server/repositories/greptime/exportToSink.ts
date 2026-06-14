import { greptimeQuery } from "../../greptime/client";
import { selectJsonColumn, greptimeJson } from "../../greptime/sql/rowContract";
import { greptimeTsParam, notDeleted, greptimeInClause } from "./queryHelpers";
import { LISTABLE_SCORE_TYPES } from "../../../domain/scores";

/**
 * GreptimeDB export-to-sink readers (04-read-path.md, P6 Piece 2). These feed the blob-storage and
 * analytics-integration (PostHog/Mixpanel) export jobs. The ClickHouse versions streamed a single
 * FINAL/LIMIT-1-BY query; on the merged projection that collapses to a keyset-paged scan
 * (stable composite cursor `(timeCol, id)` DESC, bounded memory, no dedup).
 *
 * The trace-level rollup (cost/latency/observation_count) and trace denormalisation that the
 * analytics transforms expect are not columns on the observation/score projections, so they are
 * fetched per page (two-phase) keyed on the page's ids — exact per-entity, no time-window slack.
 *
 * Window boundaries are preserved per the legacy queries: blob export is inclusive of `maxTimestamp`
 * (`<=`), analytics export is exclusive (`<`). The primary scan is always project-scoped and
 * soft-delete aware.
 */

const PAGE_SIZE = 1000;

/** Lexicographic keyset predicate for a `(timeCol, id)` DESC scan (paged seek). */
const keysetDesc = (prefix: string, timeCol: string): string =>
  `(${prefix}.${timeCol} < :curTs OR (${prefix}.${timeCol} = :curTs AND ${prefix}.id < :curId))`;

type Cursor = { ts: string; id: string } | null;

type TraceDenorm = {
  name: unknown;
  session_id: unknown;
  user_id: unknown;
  release: unknown;
  tags: unknown;
  posthog_session_id: unknown;
  mixpanel_session_id: unknown;
};

/**
 * Fetch trace-level denormalised fields for a page of trace ids. LEFT-JOIN semantics: missing trace
 * ids simply absent from the map, so the caller yields NULL trace fields (parity with the legacy
 * LEFT JOIN that ships orphan rows rather than dropping them).
 */
async function fetchTraceDenormByIds(
  projectId: string,
  traceIds: string[],
): Promise<Map<string, TraceDenorm>> {
  const ids = traceIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  const inClause = greptimeInClause("t.id", ids, "trace");
  const rows: Record<string, unknown>[] = await greptimeQuery<
    Record<string, unknown>
  >({
    query: `
      SELECT
        t.id AS id,
        t.name AS name,
        t.session_id AS session_id,
        t.user_id AS user_id,
        t.release AS release,
        ${selectJsonColumn("tags", { alias: "tags", tablePrefix: "t" })},
        json_get_string(t.metadata, '$posthog_session_id') AS posthog_session_id,
        json_get_string(t.metadata, '$mixpanel_session_id') AS mixpanel_session_id
      FROM traces t
      WHERE t.project_id = :projectId AND ${notDeleted("t")} AND ${inClause.sql}`,
    params: { projectId, ...inClause.params },
    readOnly: true,
  });
  const map = new Map<string, TraceDenorm>();
  for (const r of rows) {
    map.set(String(r.id), {
      name: r.name ?? null,
      session_id: r.session_id ?? null,
      user_id: r.user_id ?? null,
      release: r.release ?? null,
      tags: greptimeJson<string[]>(r.tags, []),
      posthog_session_id: r.posthog_session_id ?? null,
      mixpanel_session_id: r.mixpanel_session_id ?? null,
    });
  }
  return map;
}

/**
 * Analytics: traces with observation rollup (total_cost / latency seconds / observation_count).
 * Yields raw records consumed by the `getTracesForAnalyticsIntegrations` transform.
 */
export async function* streamTracesForAnalyticsGreptime(
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
): AsyncGenerator<Record<string, unknown>> {
  let cursor: Cursor = null;
  while (true) {
    const traceRows: Record<string, unknown>[] = await greptimeQuery<
      Record<string, unknown>
    >({
      query: `
        SELECT
          t.id AS id,
          t.timestamp AS timestamp,
          t.name AS name,
          t.session_id AS session_id,
          t.user_id AS user_id,
          t.release AS release,
          t.version AS version,
          t.environment AS environment,
          ${selectJsonColumn("tags", { alias: "tags", tablePrefix: "t" })},
          json_get_string(t.metadata, '$posthog_session_id') AS posthog_session_id,
          json_get_string(t.metadata, '$mixpanel_session_id') AS mixpanel_session_id
        FROM traces t
        WHERE t.project_id = :projectId AND ${notDeleted("t")}
          AND t.timestamp >= :minTs AND t.timestamp < :maxTs
          ${cursor ? `AND ${keysetDesc("t", "timestamp")}` : ""}
        ORDER BY t.timestamp DESC, t.id DESC
        LIMIT :pageSize`,
      params: {
        projectId,
        minTs: greptimeTsParam(minTimestamp),
        maxTs: greptimeTsParam(maxTimestamp),
        pageSize: PAGE_SIZE,
        ...(cursor ? { curTs: cursor.ts, curId: cursor.id } : {}),
      },
      readOnly: true,
    });
    if (traceRows.length === 0) return;

    const traceIds = traceRows.map((r) => String(r.id));
    const rollupIn = greptimeInClause("o.trace_id", traceIds, "tid");
    const rollupRows: Record<string, unknown>[] = await greptimeQuery<
      Record<string, unknown>
    >({
      query: `
        SELECT
          o.trace_id AS trace_id,
          sum(coalesce(o.total_cost, 0)) AS total_cost,
          count(*) AS observation_count,
          CAST(
            (to_unixtime(greatest(max(o.start_time), max(o.end_time)))
             - to_unixtime(least(min(o.start_time), min(o.end_time)))) * 1000 AS BIGINT
          ) AS latency_ms
        FROM observations o
        WHERE o.project_id = :projectId AND ${notDeleted("o")} AND ${rollupIn.sql}
        GROUP BY o.trace_id`,
      params: { projectId, ...rollupIn.params },
      readOnly: true,
    });
    const rollup = new Map<string, Record<string, unknown>>();
    for (const r of rollupRows) rollup.set(String(r.trace_id), r);

    for (const t of traceRows) {
      const agg = rollup.get(String(t.id));
      const latencyMs = agg?.latency_ms != null ? Number(agg.latency_ms) : null;
      yield {
        ...t,
        tags: greptimeJson<string[]>(t.tags, []),
        total_cost: agg?.total_cost ?? null,
        observation_count: agg?.observation_count ?? 0,
        latency: latencyMs != null ? latencyMs / 1000 : null,
      };
    }

    if (traceRows.length < PAGE_SIZE) return;
    const last = traceRows[traceRows.length - 1];
    cursor = {
      ts: greptimeTsParam(last.timestamp as Date),
      id: String(last.id),
    };
  }
}

/**
 * Analytics: GENERATION observations joined to trace denorm. Mirrors the legacy
 * `getGenerationsForAnalyticsIntegrations` column shape (including its usage/cost token mapping).
 */
export async function* streamGenerationsForAnalyticsGreptime(
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
): AsyncGenerator<Record<string, unknown>> {
  yield* streamObservationsForAnalyticsGreptime(
    projectId,
    minTimestamp,
    maxTimestamp,
    "GENERATION",
  );
}

/**
 * Analytics: all observations (events) joined to trace denorm. `typeFilter` null = all types
 * (events analytics), "GENERATION" = generations analytics.
 */
async function* streamObservationsForAnalyticsGreptime(
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  typeFilter: string | null,
): AsyncGenerator<Record<string, unknown>> {
  let cursor: Cursor = null;
  while (true) {
    const obsRows: Record<string, unknown>[] = await greptimeQuery<
      Record<string, unknown>
    >({
      query: `
        SELECT
          o.id AS id,
          o.trace_id AS trace_id,
          o.start_time AS start_time,
          o.name AS name,
          o.level AS level,
          o.type AS type,
          o.version AS version,
          o.environment AS environment,
          o.provided_model_name AS model,
          o.total_cost AS total_cost,
          json_get_float(o.usage_details, 'input') AS input_tokens_input,
          json_get_float(o.usage_details, 'output') AS output_tokens,
          json_get_float(o.usage_details, 'total') AS usage_total,
          json_get_float(o.cost_details, 'total') AS cost_total,
          CASE WHEN o.end_time IS NULL THEN NULL
            ELSE CAST((to_unixtime(o.end_time) - to_unixtime(o.start_time)) * 1000 AS BIGINT) END AS latency_ms,
          CASE WHEN o.completion_start_time IS NULL THEN NULL
            ELSE CAST((to_unixtime(o.completion_start_time) - to_unixtime(o.start_time)) * 1000 AS BIGINT) END AS ttft_ms
        FROM observations o
        WHERE o.project_id = :projectId AND ${notDeleted("o")}
          AND o.start_time >= :minTs AND o.start_time < :maxTs
          ${typeFilter ? "AND o.type = :typeFilter" : ""}
          ${cursor ? `AND ${keysetDesc("o", "start_time")}` : ""}
        ORDER BY o.start_time DESC, o.id DESC
        LIMIT :pageSize`,
      params: {
        projectId,
        minTs: greptimeTsParam(minTimestamp),
        maxTs: greptimeTsParam(maxTimestamp),
        pageSize: PAGE_SIZE,
        ...(typeFilter ? { typeFilter } : {}),
        ...(cursor ? { curTs: cursor.ts, curId: cursor.id } : {}),
      },
      readOnly: true,
    });
    if (obsRows.length === 0) return;

    const traceIds = obsRows
      .map((r) => r.trace_id)
      .filter((id): id is string => Boolean(id))
      .map(String);
    const traceMap = await fetchTraceDenormByIds(projectId, traceIds);

    for (const o of obsRows) {
      const t = o.trace_id ? traceMap.get(String(o.trace_id)) : undefined;
      const latencyMs = o.latency_ms != null ? Number(o.latency_ms) : null;
      const ttftMs = o.ttft_ms != null ? Number(o.ttft_ms) : null;
      yield {
        id: o.id,
        start_time: o.start_time,
        name: o.name,
        level: o.level,
        type: o.type,
        version: o.version,
        environment: o.environment,
        model: o.model,
        provided_model_name: o.model,
        total_cost: o.total_cost,
        // Legacy token mapping preserved verbatim (generations had input<-usage_details['total']).
        input_tokens: typeFilter ? o.usage_total : o.input_tokens_input,
        output_tokens: o.output_tokens,
        total_tokens: typeFilter ? o.cost_total : o.usage_total,
        latency: latencyMs != null ? latencyMs / 1000 : null,
        time_to_first_token: ttftMs != null ? ttftMs / 1000 : null,
        trace_id: o.trace_id,
        trace_name: t?.name ?? null,
        trace_session_id: t?.session_id ?? null,
        session_id: t?.session_id ?? null,
        user_id: t?.user_id ?? null,
        trace_user_id: t?.user_id ?? null,
        trace_release: t?.release ?? null,
        release: t?.release ?? null,
        trace_tags: t?.tags ?? [],
        tags: t?.tags ?? [],
        posthog_session_id: t?.posthog_session_id ?? null,
        mixpanel_session_id: t?.mixpanel_session_id ?? null,
      };
    }

    if (obsRows.length < PAGE_SIZE) return;
    const last = obsRows[obsRows.length - 1];
    cursor = {
      ts: greptimeTsParam(last.start_time as Date),
      id: String(last.id),
    };
  }
}

/** Analytics: events == all observations (trace-denormalised). */
export async function* streamEventsForAnalyticsGreptime(
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
): AsyncGenerator<Record<string, unknown>> {
  yield* streamObservationsForAnalyticsGreptime(
    projectId,
    minTimestamp,
    maxTimestamp,
    null,
  );
}

/**
 * Analytics: scores joined to trace denorm. Score window is `< maxTimestamp`; trace fields fetched
 * per page by trace_id (exact, replaces the legacy 7-day-lookback CTE pre-join).
 */
export async function* streamScoresForAnalyticsGreptime(
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
): AsyncGenerator<Record<string, unknown>> {
  const dataTypes = greptimeInClause("s.data_type", LISTABLE_SCORE_TYPES, "dt");
  let cursor: Cursor = null;
  while (true) {
    const scoreRows: Record<string, unknown>[] = await greptimeQuery<
      Record<string, unknown>
    >({
      query: `
        SELECT
          s.id AS id,
          s.timestamp AS timestamp,
          s.name AS name,
          s.value AS value,
          s.string_value AS string_value,
          s.data_type AS data_type,
          s.comment AS comment,
          s.environment AS environment,
          s.trace_id AS score_trace_id,
          s.session_id AS score_session_id,
          s.dataset_run_id AS score_dataset_run_id,
          ${selectJsonColumn("metadata", { alias: "metadata", tablePrefix: "s" })}
        FROM scores s
        WHERE s.project_id = :projectId AND ${notDeleted("s")}
          AND s.timestamp >= :minTs AND s.timestamp < :maxTs
          AND ${dataTypes.sql}
          AND (s.trace_id IS NOT NULL OR s.session_id IS NOT NULL OR s.dataset_run_id IS NOT NULL)
          ${cursor ? `AND ${keysetDesc("s", "timestamp")}` : ""}
        ORDER BY s.timestamp DESC, s.id DESC
        LIMIT :pageSize`,
      params: {
        projectId,
        minTs: greptimeTsParam(minTimestamp),
        maxTs: greptimeTsParam(maxTimestamp),
        pageSize: PAGE_SIZE,
        ...dataTypes.params,
        ...(cursor ? { curTs: cursor.ts, curId: cursor.id } : {}),
      },
      readOnly: true,
    });
    if (scoreRows.length === 0) return;

    const traceIds = scoreRows
      .map((r) => r.score_trace_id)
      .filter((id): id is string => Boolean(id))
      .map(String);
    const traceMap = await fetchTraceDenormByIds(projectId, traceIds);

    for (const s of scoreRows) {
      const t = s.score_trace_id
        ? traceMap.get(String(s.score_trace_id))
        : undefined;
      yield {
        id: s.id,
        timestamp: s.timestamp,
        name: s.name,
        value: s.value,
        string_value: s.string_value,
        data_type: s.data_type,
        comment: s.comment,
        environment: s.environment,
        metadata: greptimeJson(s.metadata, null),
        score_trace_id: s.score_trace_id,
        score_session_id: s.score_session_id,
        score_dataset_run_id: s.score_dataset_run_id,
        trace_id: t ? String(s.score_trace_id) : null,
        trace_name: t?.name ?? null,
        trace_session_id: t?.session_id ?? null,
        trace_user_id: t?.user_id ?? null,
        trace_release: t?.release ?? null,
        trace_tags: t?.tags ?? [],
        posthog_session_id: t?.posthog_session_id ?? null,
        mixpanel_session_id: t?.mixpanel_session_id ?? null,
      };
    }

    if (scoreRows.length < PAGE_SIZE) return;
    const last = scoreRows[scoreRows.length - 1];
    cursor = {
      ts: greptimeTsParam(last.timestamp as Date),
      id: String(last.id),
    };
  }
}
