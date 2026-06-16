/**
 * Live smoke for P7 Piece 6d — the `createExperimentEventsAsGreptime` seed converter.
 *
 * Proves the experiment-event -> dataset_run_items (+ observation) converter round-trips
 * through the GreptimeDB experiment readers: an experiment IS a dataset run, so seeding the
 * run-item rows (with cost-bearing observations) makes `getExperimentsFromEvents` and
 * `getExperimentMetricsFromEvents` resolve name/description/datasetId/itemCount and the
 * cost/latency aggregate. Local proof for the experiment-repository servertest re-seed.
 *
 * Run: cd worker && ../node_modules/.bin/dotenv -e ../.env -- npx tsx src/scripts/greptimeExperimentSeedSmoke.ts
 */
import { v4 as uuidv4 } from "uuid";
import {
  createEvent,
  createExperimentEventsAsGreptime,
  getExperimentsFromEvents,
  getExperimentMetricsFromEvents,
} from "@langfuse/shared/src/server";

const PROJECT_ID = uuidv4();
const EXPERIMENT_ID = uuidv4();
const EXPERIMENT_NAME = `exp-${uuidv4()}`;
const EXPERIMENT_DESCRIPTION = `desc-${uuidv4()}`;
const DATASET_ID = uuidv4();

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
  console.log("== P7 Piece 6d experiment-seed converter smoke ==");

  const now = Date.now() * 1000; // micros
  const mkItem = (cost: number) => {
    const id = uuidv4();
    return createEvent({
      id,
      span_id: id,
      project_id: PROJECT_ID,
      trace_id: uuidv4(),
      type: "GENERATION",
      name: "exp-generation",
      experiment_id: EXPERIMENT_ID,
      experiment_name: EXPERIMENT_NAME,
      experiment_description: EXPERIMENT_DESCRIPTION,
      experiment_dataset_id: DATASET_ID,
      experiment_item_id: uuidv4(),
      experiment_item_root_span_id: id,
      start_time: now,
      end_time: now + 2_000_000, // +2s
      cost_details: { input: cost, output: cost, total: cost * 2 },
    });
  };

  const events = [mkItem(10), mkItem(15)];
  await createExperimentEventsAsGreptime(events);

  const experiments = await getExperimentsFromEvents({
    projectId: PROJECT_ID,
    filter: [],
    limit: 1000,
    page: 0,
  });
  const exp = experiments.find((e) => e.id === EXPERIMENT_ID);
  check("experiment resolves", Boolean(exp), experiments.length);
  check("experiment name", exp?.name === EXPERIMENT_NAME, exp?.name);
  check(
    "experiment description",
    exp?.description === EXPERIMENT_DESCRIPTION,
    exp?.description,
  );
  check("experiment datasetId", exp?.datasetId === DATASET_ID, exp?.datasetId);
  check("experiment itemCount=2", exp?.itemCount === 2, exp?.itemCount);

  const metrics = await getExperimentMetricsFromEvents({
    projectId: PROJECT_ID,
    experimentIds: [EXPERIMENT_ID],
  });
  const m = metrics.find((r) => r.id === EXPERIMENT_ID);
  check("metrics resolves", Boolean(m), metrics);
  // total cost = sum of distinct-trace observation total_cost = 20 + 30 = 50
  check(
    "metrics totalCost = 50",
    Math.abs(Number(m?.totalCost ?? 0) - 50) < 1e-6,
    m?.totalCost,
  );
  check(
    "metrics latencyAvg > 0",
    m?.latencyAvg != null && Number(m.latencyAvg) > 0,
    m?.latencyAvg,
  );

  console.log(`\n== ${pass} passed, ${fail} failed ==`);
  if (fail > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
