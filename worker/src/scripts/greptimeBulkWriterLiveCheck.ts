/**
 * Live integration check for GreptimeBulkWriter against a real GreptimeDB. Mirrors what the
 * reconciliation handler does (build records -> addToQueue -> flushAll) but drives the bulk writer
 * directly, so it exercises the real hybrid path end to end:
 *   - observation projection (3x DECIMAL) goes unary via the dedicated manual writer,
 *   - its EAV (observations_usage_cost / observations_metadata) is released to bulk only after the
 *     projection lands (gating),
 *   - decimal-free entities (trace + EAV, score) ride bulk.
 * Then it asserts the rows are readable and that no observations_usage_cost row is orphaned from its
 * observations projection.
 *
 * Run:
 *   GREPTIME_GRPC_URL=localhost:4001 GREPTIME_SQL_HOST=localhost GREPTIME_SQL_PORT=4002 \
 *     npx dotenv -e ../.env -- npx tsx src/scripts/greptimeBulkWriterLiveCheck.ts
 */
import {
  closeGreptimeConnections,
  createObservation,
  createTraceScore,
  createTrace,
  getGreptimeIngestClient,
  greptimeQuery,
  GreptimeTable,
} from "@langfuse/shared/src/server";

import { GreptimeWriter } from "../services/GreptimeWriter";
import { GreptimeBulkWriter } from "../services/GreptimeBulkWriter";

const PROJECT = `bulkwriter-live-${Date.now()}`;
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

const countWhere = async (table: string): Promise<number> => {
  const rows = await greptimeQuery<{ n: number | string }>({
    query: `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = :p`,
    params: { p: PROJECT },
  });
  return Number(rows[0]?.n ?? 0);
};

async function main() {
  const client = getGreptimeIngestClient();
  const bulk = new GreptimeBulkWriter({
    client,
    unary: GreptimeWriter.createManual({
      write: (tables) => client.write(tables),
    }),
    batchSize: 1000,
  });

  bulk.addToQueue(
    GreptimeTable.Traces,
    createTrace({
      project_id: PROJECT,
      id: "trace-1",
      metadata: { region: "us" },
      tags: ["a", "b"],
    }),
  );
  bulk.addToQueue(
    GreptimeTable.Observations,
    createObservation({
      project_id: PROJECT,
      id: "obs-1",
      trace_id: "trace-1",
      metadata: { k: "v" },
      usage_details: { input: 10, output: 20, total: 30, cache_read: 5 },
      cost_details: { input: 0.1, total: 0.3, cache_read: 0.05 },
      total_cost: 0.3,
    }),
  );
  bulk.addToQueue(
    GreptimeTable.Scores,
    createTraceScore({
      project_id: PROJECT,
      id: "score-1",
      trace_id: "trace-1",
    }),
  );

  await bulk.flushAll();

  check("trace projection landed", (await countWhere("traces")) === 1);
  check(
    "trace metadata EAV landed",
    (await countWhere("traces_metadata")) >= 1,
  );
  check("trace tags EAV landed", (await countWhere("traces_tags")) >= 1);
  check(
    "observation projection landed (unary)",
    (await countWhere("observations")) === 1,
  );
  check(
    "observation usage/cost EAV landed (gated bulk)",
    (await countWhere("observations_usage_cost")) >= 1,
  );
  check("score projection landed", (await countWhere("scores")) === 1);

  // Decimal round-trips through the unary projection path (string-preserved precision).
  const obs = await greptimeQuery<{ total_cost: string }>({
    query: `SELECT total_cost FROM observations WHERE project_id = :p AND id = 'obs-1'`,
    params: { p: PROJECT },
  });
  check(
    "observation total_cost preserved",
    obs.length === 1 && Number(obs[0].total_cost) === 0.3,
    obs,
  );

  // No orphan: every observations_usage_cost entity must have a matching observations projection row.
  const orphans = await greptimeQuery<{ entity_id: string }>({
    query: `SELECT DISTINCT uc.entity_id FROM observations_usage_cost uc
            LEFT JOIN observations o ON o.project_id = uc.project_id AND o.id = uc.entity_id
            WHERE uc.project_id = :p AND o.id IS NULL`,
    params: { p: PROJECT },
  });
  check(
    "no orphan observations_usage_cost rows",
    orphans.length === 0,
    orphans,
  );

  // Cleanup.
  for (const t of [
    "traces",
    "traces_metadata",
    "traces_tags",
    "observations",
    "observations_metadata",
    "observations_usage_cost",
    "scores",
    "scores_metadata",
  ]) {
    await greptimeQuery({
      query: `DELETE FROM ${t} WHERE project_id = ?`,
      params: [PROJECT],
    });
  }

  await closeGreptimeConnections();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
