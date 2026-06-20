import {
  createDatasetRunItem,
  DatasetRunItemRecordInsertType,
} from "../../../src/server";
import { utcDayStartMs } from "./rng";
import {
  ScenarioContext,
  ScenarioDefinition,
  SeedError,
  SeedSummary,
} from "./types";
import {
  greptimeCountRows,
  writeRecordsToGreptime,
} from "../utils/greptime-writer";

/**
 * Bulk `dataset_run_items` for the F7 ROW_NUMBER dedup benchmark. GreptimeDB has no QUALIFY, so the
 * read path dedups physical run-item rows with `ROW_NUMBER() OVER (PARTITION BY project_id,
 * dataset_id, dataset_run_id, dataset_item_id ORDER BY created_at DESC) = 1`. Re-runs / updates of an
 * experiment produce MANY physical rows per logical (run, item) key; this scenario reproduces that at
 * scale so the dedup's full hash-repartition + sort cost can be benchmarked.
 *
 * Writes only GreptimeDB `dataset_run_items` (the dedup operates solely on that table) — this is a
 * performance-benchmark scenario, not a UI scenario, so it intentionally skips the Postgres
 * dataset/run/run-item rows and the per-item traces/observations/scores. Deterministic: ids derive
 * from --id-prefix, time anchors from utcDayStartMs(); each of the `--duplicates` physical rows for a
 * logical key gets a distinct id and created_at so ROW_NUMBER has real work to do.
 */
const run = async (
  ctx: ScenarioContext,
  params: Record<string, string | number | boolean>,
): Promise<SeedSummary> => {
  const startedAt = Date.now();
  const runCount = params["runs"] as number;
  const itemCount = params["items"] as number;
  const duplicates = params["duplicates"] as number;

  if (runCount < 1 || runCount > 1000)
    throw new SeedError(`--runs must be 1-1000, got ${runCount}`);
  if (itemCount < 1 || itemCount > 5000)
    throw new SeedError(`--items must be 1-5000, got ${itemCount}`);
  if (duplicates < 1 || duplicates > 100)
    throw new SeedError(`--duplicates must be 1-100, got ${duplicates}`);

  const anchor = utcDayStartMs();
  const datasetId = `${ctx.idPrefix}-dataset`;
  const logical = runCount * itemCount;
  const physical = logical * duplicates;

  if (ctx.dryRun) {
    return {
      scenario: "dataset-run-scale",
      target: "greptime",
      params,
      projectId: ctx.projectId,
      environment: ctx.environment,
      traceIds: [],
      sessionIds: [],
      counts: { datasetRunItems: physical, logicalKeys: logical },
      verified: {},
      links: [],
      dryRun: true,
      durationMs: Date.now() - startedAt,
    };
  }

  // Build + flush in chunks to keep memory bounded at large physical counts.
  const CHUNK = 20_000;
  let buffer: DatasetRunItemRecordInsertType[] = [];
  const flush = async () => {
    if (!buffer.length) return;
    await writeRecordsToGreptime({ datasetRunItems: buffer });
    buffer = [];
  };

  for (let r = 0; r < runCount; r++) {
    const runId = `${ctx.idPrefix}-run-${r}`;
    const runCreatedAtMs = anchor + r * 3_600_000;
    for (let i = 0; i < itemCount; i++) {
      const itemId = `${ctx.idPrefix}-item-${i}`;
      const traceId = `${ctx.idPrefix}-r${r}-i${i}-trace`;
      // `duplicates` physical rows for the SAME logical (run,item) key, distinct id + created_at →
      // ROW_NUMBER must sort them and keep the latest (rn = 1).
      for (let k = 0; k < duplicates; k++) {
        const createdAtMs = runCreatedAtMs + k * 1000;
        buffer.push(
          createDatasetRunItem({
            id: `${ctx.idPrefix}-r${r}-i${i}-k${k}-dri`,
            project_id: ctx.projectId,
            trace_id: traceId,
            observation_id: null,
            dataset_id: datasetId,
            dataset_run_id: runId,
            dataset_item_id: itemId,
            dataset_run_name: `run-${r}`,
            dataset_run_description: null,
            dataset_run_metadata: {},
            dataset_item_input: JSON.stringify({ i }),
            dataset_item_expected_output: JSON.stringify({ a: i }),
            dataset_item_metadata: {},
            dataset_run_created_at: runCreatedAtMs,
            created_at: createdAtMs,
            updated_at: createdAtMs,
            event_ts: createdAtMs,
          }),
        );
      }
      if (buffer.length >= CHUNK) await flush();
    }
  }
  await flush();

  ctx.log(
    `wrote ${physical} physical run-item rows (${logical} logical keys x ${duplicates} duplicates)`,
  );

  const verifiedPhysical = await greptimeCountRows(
    "dataset_run_items",
    `project_id = :projectId AND dataset_id = :datasetId AND is_deleted = false`,
    { projectId: ctx.projectId, datasetId },
    "count(distinct id)",
  );
  if (verifiedPhysical < physical) {
    throw new SeedError(
      `Readback mismatch: expected ${physical} physical run-items, found ${verifiedPhysical}`,
    );
  }

  return {
    scenario: "dataset-run-scale",
    target: "greptime",
    params,
    projectId: ctx.projectId,
    environment: ctx.environment,
    traceIds: [],
    sessionIds: [],
    counts: {
      datasetRunItems: physical,
      logicalKeys: logical,
      duplicatesPerKey: duplicates,
    },
    verified: { datasetRunItemsPhysical: verifiedPhysical },
    // No UI deep link: this scenario writes only GreptimeDB dataset_run_items (no Postgres
    // dataset/run rows), so a /datasets/<id> link would 404. It is a benchmark, not a UI scenario.
    links: [],
    dryRun: false,
    durationMs: Date.now() - startedAt,
  };
};

export const datasetRunScaleScenario: ScenarioDefinition = {
  name: "dataset-run-scale",
  description:
    "Bulk dataset_run_items with duplicate physical rows per logical (run,item) key for the F7 ROW_NUMBER dedup benchmark. GreptimeDB-only (no Postgres/traces) — a performance scenario, not a UI scenario.",
  supportsV4: false,
  flags: [
    {
      flag: "runs",
      type: "number",
      default: 30,
      description: "number of dataset runs (1-1000)",
    },
    {
      flag: "items",
      type: "number",
      default: 100,
      description: "dataset items per run (1-5000)",
    },
    {
      flag: "duplicates",
      type: "number",
      default: 3,
      description:
        "physical rows per logical (run,item) key — re-run/update churn (1-100)",
    },
  ],
  run,
};
