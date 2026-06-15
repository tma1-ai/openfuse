/**
 * Live smoke for P7 Piece 6d — the `createEventsAsGreptime` seed converter.
 *
 * Proves the test-only converter (`EventRecordInsertType` -> observation projection
 * row + synthesized denormalised trace) round-trips through the merged GreptimeDB
 * projection: the `*FromEventsTable` read functions resolve the seeded observations
 * with the trace-level userId/sessionId/traceName/tags populated by the read-time
 * trace join. This is the local proof that the servertest seed swap is faithful.
 *
 * Run: cd worker && ../node_modules/.bin/dotenv -e ../.env -- npx tsx src/scripts/greptimeEventSeedSmoke.ts
 */
import { v4 as uuidv4 } from "uuid";
import {
  createEvent,
  createEventsAsGreptime,
  getObservationsForTraceFromEventsTable,
  getObservationByIdFromEventsTable,
  getTraceByIdFromEventsTable,
} from "@langfuse/shared/src/server";

const PROJECT_ID = uuidv4();
const TRACE_ID = uuidv4();
const USER_ID = `user-${uuidv4()}`;
const SESSION_ID = `session-${uuidv4()}`;
const TAGS = ["alpha", "beta"];

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}`, detail ?? "");
  }
};

async function main() {
  console.log("== P7 Piece 6d event-seed converter smoke ==");

  const rootId = uuidv4();
  const genId = uuidv4();

  const denorm = {
    project_id: PROJECT_ID,
    trace_id: TRACE_ID,
    user_id: USER_ID,
    session_id: SESSION_ID,
    trace_name: "smoke-trace",
    tags: TAGS,
  };

  const rootEvent = createEvent({
    ...denorm,
    id: rootId,
    span_id: rootId,
    name: "root-span",
    type: "SPAN",
    is_app_root: true,
  });

  const genEvent = createEvent({
    ...denorm,
    id: genId,
    span_id: genId,
    parent_span_id: rootId,
    name: "gen-span",
    type: "GENERATION",
    provided_model_name: "gpt-4o",
    model_id: "model-int-id",
    cost_details: { input: 10, output: 20, total: 30 },
    usage_details: { input: 5, output: 7, total: 12 },
    metadata_names: ["foo"],
    metadata_values: ["bar"],
  });

  await createEventsAsGreptime([rootEvent, genEvent], {
    synthesizeTraces: true,
  });

  // --- obs-for-trace: shape + denormalised join -------------------------------
  const { observations, totalCount } =
    await getObservationsForTraceFromEventsTable({
      projectId: PROJECT_ID,
      traceId: TRACE_ID,
      selectIOAndMetadata: true,
    });
  check("obs-for-trace returns both observations", observations.length === 2, {
    got: observations.length,
  });
  check("obs-for-trace totalCount matches", totalCount === 2, totalCount);
  check(
    "obs-for-trace carries denormalised userId",
    observations.every((o) => o.userId === USER_ID),
    observations.map((o) => o.userId),
  );
  check(
    "obs-for-trace carries denormalised sessionId",
    observations.every((o) => o.sessionId === SESSION_ID),
    observations.map((o) => o.sessionId),
  );
  check(
    "obs-for-trace carries trace tags",
    observations.every((o) => TAGS.every((t) => (o.tags ?? []).includes(t))),
    observations.map((o) => o.tags),
  );

  // --- obs-by-id: observation field fidelity ----------------------------------
  const gen = await getObservationByIdFromEventsTable({
    id: genId,
    projectId: PROJECT_ID,
    fetchWithInputOutput: true,
  });
  check("obs-by-id resolves generation", gen?.id === genId, gen?.id);
  check("obs-by-id type GENERATION", gen?.type === "GENERATION", gen?.type);
  check("obs-by-id model name preserved", gen?.model === "gpt-4o", {
    model: gen?.model,
  });
  check(
    "obs-by-id parentObservationId preserved",
    gen?.parentObservationId === rootId,
    gen?.parentObservationId,
  );

  // --- trace-by-id: synthesized trace -----------------------------------------
  const trace = await getTraceByIdFromEventsTable({
    traceId: TRACE_ID,
    projectId: PROJECT_ID,
  });
  check("trace-by-id resolves", trace?.id === TRACE_ID, trace?.id);
  check("trace-by-id carries userId", trace?.userId === USER_ID, trace?.userId);
  check("trace-by-id name from root span", trace?.name === "smoke-trace", {
    got: trace?.name,
  });

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
