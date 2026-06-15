/**
 * Smoke test for P6 Piece 2 — export-to-sink readers on GreptimeDB.
 * Run from the worker package:
 *   dotenv -e ../.env -- npx tsx src/scripts/greptimeExportToSinkSmoke.ts
 *
 * Exercises the blob-storage and analytics-integration export functions (now GreptimeDB-backed):
 *   - blob exports yield legacy raw-row column shapes (traces/scores/observations/events)
 *   - observation/event field-group selection narrows columns; events carry trace denorm + ms latency
 *   - analytics exports yield the langfuse_* transform shape with trace rollup / denorm
 *   - window boundary: blob inclusive of maxTimestamp (<=), analytics exclusive (<)
 *   - getMinExportTimestampGreptime finds the earliest projection timestamp
 *
 * Idempotent: deletes its own fixture (project_id = SMOKE_PROJECT) before and after.
 */
import {
  greptimeQuery,
  closeGreptimeConnections,
  getTracesForBlobStorageExport,
  getScoresForBlobStorageExport,
  getObservationsForBlobStorageExport,
  getEventsForBlobStorageExport,
  getTracesForAnalyticsIntegrations,
  getGenerationsForAnalyticsIntegrations,
  getScoresForAnalyticsIntegrations,
  getEventsForAnalyticsIntegrations,
  getMinExportTimestampGreptime,
  type TraceRecordInsertType,
  type ObservationRecordInsertType,
  type ScoreRecordInsertType,
} from "@langfuse/shared/src/server";
import { GreptimeWriter, GreptimeTable } from "../services/GreptimeWriter";

const SMOKE_PROJECT = "smoke-export-sink-0001";
const T = Date.UTC(2026, 5, 14, 10, 0, 0);
const WIN_MIN = new Date(T - 60_000);
const WIN_MAX = new Date(T + 60_000);

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined && !ok ? ` -> ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanup = async () => {
  for (const table of ["observations", "traces", "scores"]) {
    await greptimeQuery({
      query: `DELETE FROM \`${table}\` WHERE \`project_id\` = ?`,
      params: [SMOKE_PROJECT],
    });
  }
};

const trace = (id: string): TraceRecordInsertType => ({
  id,
  project_id: SMOKE_PROJECT,
  timestamp: T,
  name: `trace-${id}`,
  environment: "default",
  user_id: "user-1",
  session_id: "sess-1",
  release: "rel-1",
  version: "v1",
  metadata: { $posthog_session_id: "ph-1", $mixpanel_session_id: "mx-1" },
  tags: ["alpha", "beta"],
  public: true,
  bookmarked: false,
  input: '{"q":"hi"}',
  output: '{"a":"yo"}',
  created_at: T,
  updated_at: T,
  event_ts: T,
  is_deleted: 0,
});

const observation = (
  id: string,
  traceId: string,
  type: string,
): ObservationRecordInsertType => ({
  id,
  project_id: SMOKE_PROJECT,
  trace_id: traceId,
  type,
  environment: "default",
  name: `obs-${id}`,
  level: "DEFAULT",
  status_message: null,
  version: "v1",
  start_time: T,
  end_time: T + 2000,
  completion_start_time: T + 500,
  metadata: { foo: "bar" },
  provided_model_name: "gpt-4o",
  internal_model_id: "model-internal-1",
  model_parameters: '{"temperature":0.5}',
  provided_usage_details: {},
  usage_details: { input: 10, output: 5, total: 15 },
  provided_cost_details: {},
  cost_details: { input: 0.01, output: 0.02, total: 0.03 },
  total_cost: 0.03,
  input: '{"prompt":"x"}',
  output: '{"completion":"y"}',
  prompt_id: "p1",
  prompt_name: "my-prompt",
  prompt_version: 2,
  usage_pricing_tier_id: null,
  usage_pricing_tier_name: null,
  tool_definitions: { calc: "calculator" },
  tool_calls: ["calc"],
  tool_call_names: ["calc"],
  created_at: T,
  updated_at: T,
  event_ts: T,
  is_deleted: 0,
});

const score = (id: string, traceId: string): ScoreRecordInsertType => ({
  id,
  project_id: SMOKE_PROJECT,
  timestamp: T,
  name: "quality",
  value: 0.9,
  source: "API",
  data_type: "NUMERIC",
  string_value: null,
  long_string_value: "",
  comment: "good",
  trace_id: traceId,
  observation_id: null,
  session_id: null,
  dataset_run_id: null,
  environment: "default",
  metadata: { note: "n" },
  created_at: T,
  updated_at: T,
  event_ts: T,
  is_deleted: 0,
});

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const rec of gen) out.push(rec);
  return out;
};

async function main() {
  await cleanup();
  const writer = GreptimeWriter.getInstance();
  // 2 live traces; trace t1 has a GENERATION + a SPAN observation, trace t2 has a GENERATION.
  // t3 is soft-deleted but has an orphan observation to verify trace denorm does not leak.
  writer.addToQueue(GreptimeTable.Traces, trace("t1"));
  writer.addToQueue(GreptimeTable.Traces, trace("t2"));
  writer.addToQueue(GreptimeTable.Traces, { ...trace("t3"), is_deleted: 1 });
  writer.addToQueue(
    GreptimeTable.Observations,
    observation("o1", "t1", "GENERATION"),
  );
  writer.addToQueue(
    GreptimeTable.Observations,
    observation("o2", "t1", "SPAN"),
  );
  writer.addToQueue(
    GreptimeTable.Observations,
    observation("o3", "t2", "GENERATION"),
  );
  writer.addToQueue(
    GreptimeTable.Observations,
    observation("o4", "t3", "GENERATION"),
  );
  writer.addToQueue(GreptimeTable.Scores, score("s1", "t1"));
  await writer.flushAll(true);
  await sleep(500);

  // --- Blob exports (raw legacy columns, inclusive window) ---
  const tracesBlob = await collect(
    getTracesForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, WIN_MAX),
  );
  check("traces blob: 2 rows", tracesBlob.length === 2, tracesBlob.length);
  const tb = tracesBlob.find((r) => r.id === "t1");
  check(
    "traces blob: metadata parsed object",
    !!tb &&
      typeof tb.metadata === "object" &&
      (tb.metadata as Record<string, unknown>).$posthog_session_id === "ph-1",
  );
  check(
    "traces blob: tags parsed array",
    !!tb && Array.isArray(tb.tags) && (tb.tags as string[]).includes("alpha"),
  );
  check(
    "traces blob: input passthrough string",
    !!tb && typeof tb.input === "string",
  );

  const scoresBlob = await collect(
    getScoresForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, WIN_MAX),
  );
  check("scores blob: 1 row", scoresBlob.length === 1, scoresBlob.length);
  check(
    "scores blob: cols",
    !!scoresBlob[0] &&
      scoresBlob[0].name === "quality" &&
      scoresBlob[0].data_type === "NUMERIC" &&
      scoresBlob[0].trace_id === "t1",
  );

  const obsBlobFull = await collect(
    getObservationsForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, WIN_MAX),
  );
  check("obs blob: 4 rows", obsBlobFull.length === 4, obsBlobFull.length);
  const ob = obsBlobFull.find((r) => r.id === "o1");
  check("obs blob: model_id alias", !!ob && ob.model_id === "model-internal-1");
  check(
    "obs blob: latency seconds (2.0)",
    !!ob && Number(ob.latency) === 2,
    ob?.latency,
  );
  check(
    "obs blob: ttft seconds (0.5)",
    !!ob && Number(ob.time_to_first_token) === 0.5,
    ob?.time_to_first_token,
  );
  check(
    "obs blob: usage_details parsed",
    !!ob &&
      typeof ob.usage_details === "object" &&
      (ob.usage_details as Record<string, unknown>).total === 15,
  );

  const obsBlobCore = await collect(
    getObservationsForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, WIN_MAX, [
      "core",
    ]),
  );
  const obc = obsBlobCore.find((r) => r.id === "o1");
  check(
    "obs blob core-only: has id/type, no name/metadata",
    !!obc &&
      "id" in obc &&
      "type" in obc &&
      !("name" in obc) &&
      !("metadata" in obc),
  );

  const eventsBlob = await collect(
    getEventsForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, WIN_MAX),
  );
  check("events blob: 4 rows", eventsBlob.length === 4, eventsBlob.length);
  const eb = eventsBlob.find((r) => r.id === "o1");
  check(
    "events blob: trace denorm (trace_name/user_id/tags/release)",
    !!eb &&
      eb.trace_name === "trace-t1" &&
      eb.user_id === "user-1" &&
      Array.isArray(eb.tags) &&
      eb.release === "rel-1",
  );
  check(
    "events blob: latency MILLISECONDS (2000)",
    !!eb && Number(eb.latency) === 2000,
    eb?.latency,
  );
  check(
    "events blob: model_id alias",
    !!eb && eb.model_id === "model-internal-1",
  );
  const deletedTraceEvent = eventsBlob.find((r) => r.id === "o4");
  check(
    "events blob: deleted trace denorm stays null",
    !!deletedTraceEvent &&
      deletedTraceEvent.trace_name == null &&
      deletedTraceEvent.user_id == null &&
      deletedTraceEvent.tags == null &&
      deletedTraceEvent.release == null,
    deletedTraceEvent,
  );

  // --- Analytics integrations (langfuse_* transform shape, exclusive window) ---
  const tracesAnalytics = await collect(
    getTracesForAnalyticsIntegrations(SMOKE_PROJECT, "Smoke", WIN_MIN, WIN_MAX),
  );
  check(
    "traces analytics: 2 rows",
    tracesAnalytics.length === 2,
    tracesAnalytics.length,
  );
  const ta = tracesAnalytics.find((r) => r.langfuse_id === "t1") as
    | Record<string, unknown>
    | undefined;
  check(
    "traces analytics: rollup cost (0.06 = 2 obs * 0.03)",
    !!ta && Math.abs(Number(ta.langfuse_cost_usd) - 0.06) < 1e-9,
    ta?.langfuse_cost_usd,
  );
  check(
    "traces analytics: observation_count 2",
    !!ta && Number(ta.langfuse_count_observations) === 2,
    ta?.langfuse_count_observations,
  );
  check(
    "traces analytics: posthog_session_id from metadata",
    !!ta && ta.posthog_session_id === "ph-1",
  );

  const generations = await collect(
    getGenerationsForAnalyticsIntegrations(
      SMOKE_PROJECT,
      "Smoke",
      WIN_MIN,
      WIN_MAX,
    ),
  );
  check(
    "generations analytics: 3 (GENERATION only)",
    generations.length === 3,
    generations.length,
  );
  const ga = generations.find(
    (r) => (r as Record<string, unknown>).langfuse_trace_id === "t1",
  ) as Record<string, unknown> | undefined;
  check(
    "generations analytics: model + posthog from trace",
    !!ga && ga.langfuse_model === "gpt-4o" && ga.posthog_session_id === "ph-1",
  );

  const eventsAnalytics = await collect(
    getEventsForAnalyticsIntegrations(SMOKE_PROJECT, "Smoke", WIN_MIN, WIN_MAX),
  );
  check(
    "events analytics: 4 (all obs types)",
    eventsAnalytics.length === 4,
    eventsAnalytics.length,
  );
  const ea = eventsAnalytics.find(
    (r) => (r as Record<string, unknown>).langfuse_id === "o2",
  ) as Record<string, unknown> | undefined;
  check(
    "events analytics: observation_name + type for SPAN",
    !!ea &&
      ea.langfuse_observation_name === "obs-o2" &&
      ea.langfuse_type === "SPAN",
  );

  const scoresAnalytics = await collect(
    getScoresForAnalyticsIntegrations(SMOKE_PROJECT, "Smoke", WIN_MIN, WIN_MAX),
  );
  check(
    "scores analytics: 1 row",
    scoresAnalytics.length === 1,
    scoresAnalytics.length,
  );
  const sa = scoresAnalytics[0] as Record<string, unknown>;
  check(
    "scores analytics: trace_name join + posthog",
    !!sa &&
      sa.langfuse_trace_name === "trace-t1" &&
      sa.posthog_session_id === "ph-1",
  );

  // --- Window boundary: blob inclusive (<=), analytics exclusive (<) at maxTimestamp = T ---
  const blobAtT = await collect(
    getTracesForBlobStorageExport(SMOKE_PROJECT, WIN_MIN, new Date(T)),
  );
  check(
    "boundary: blob inclusive of maxTs=T (2 rows)",
    blobAtT.length === 2,
    blobAtT.length,
  );
  const analyticsAtT = await collect(
    getTracesForAnalyticsIntegrations(
      SMOKE_PROJECT,
      "Smoke",
      WIN_MIN,
      new Date(T),
    ),
  );
  check(
    "boundary: analytics exclusive of maxTs=T (0 rows)",
    analyticsAtT.length === 0,
    analyticsAtT.length,
  );

  // --- min export timestamp ---
  const minTs = await getMinExportTimestampGreptime(SMOKE_PROJECT);
  check(
    "min export timestamp ~ T",
    !!minTs && Math.abs(minTs.getTime() - T) < 1000,
    minTs?.toISOString(),
  );

  await cleanup();
  await closeGreptimeConnections();
  console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
