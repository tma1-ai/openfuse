/**
 * Size the per-flush MAIN-THREAD CPU that starves rebuild reads: buildTables (addRowObject) and the
 * ingester client.write() (which synchronously encodeTables -> proto before the async send). This is
 * the cost the writer imposes on the single event loop per flush; the fix space (offload / yield /
 * separate process / cut fan-out) is sized against it.
 *
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeFlushCpuProbe.ts
 */
import type { Table } from "@greptime/ingester";
import {
  buildGreptimeRowsForRecord,
  PHYSICAL_TABLES,
  getGreptimeIngestClient,
  closeGreptimeConnections,
  GreptimeTable,
  type ObservationRecordInsertType,
  type GreptimeRow,
} from "@langfuse/shared/src/server";

const RUN = Date.now();
const BATCH = Number(process.env.BENCH_BATCH ?? 1000); // writer default batchSize
const filler = (n: number) => "x".repeat(n);

const makeObs = (i: number): ObservationRecordInsertType => ({
  id: `cpu-${RUN}-${i}`,
  project_id: "flush-cpu-probe",
  trace_id: `cpu-${RUN}-t-${i % 500}`,
  type: "GENERATION",
  environment: "default",
  name: "p",
  level: "DEFAULT",
  start_time: RUN,
  end_time: RUN + 1,
  metadata: { a: "1", b: "2", c: "3" },
  provided_model_name: "gpt-4o",
  internal_model_id: "m1",
  model_parameters: "{}",
  provided_usage_details: { input: 100, output: 50 },
  usage_details: { input: 100, output: 50, total: 150 },
  provided_cost_details: {},
  cost_details: { input: 0.0001, output: 0.0002, total: 0.0003 },
  total_cost: 0.0003,
  input: filler(500),
  output: filler(500),
  tool_definitions: {},
  tool_calls: [],
  tool_call_names: [],
  created_at: RUN,
  updated_at: RUN,
  event_ts: RUN,
  is_deleted: 0,
});

const buildTables = (
  entries: { table: string; rows: GreptimeRow[] }[],
): Table[] =>
  entries.map(({ table, rows }) => {
    const t = PHYSICAL_TABLES[table]();
    for (const row of rows) t.addRowObject(row);
    return t;
  });

async function main() {
  console.log(
    `flush-cpu-probe batch=${BATCH} (observation projection + 4x EAV fan-out)\n`,
  );

  const records = Array.from({ length: BATCH }, (_, i) => makeObs(i));

  // Fan out (the addToQueue work) and group by physical table, as the writer does.
  let fanRowsTotal = 0;
  const N = 20;
  let buildMs = 0;
  let writeMs = 0;

  for (let iter = 0; iter < N; iter++) {
    const byTable = new Map<string, GreptimeRow[]>();
    for (const r of records) {
      for (const { table, rows } of buildGreptimeRowsForRecord(
        GreptimeTable.Observations,
        r,
        RUN + iter,
      )) {
        const cur = byTable.get(table);
        if (cur) cur.push(...rows);
        else byTable.set(table, [...rows]);
      }
    }
    const entries = [...byTable].map(([table, rows]) => ({ table, rows }));
    fanRowsTotal = entries.reduce((n, e) => n + e.rows.length, 0);

    const t0 = performance.now();
    const tables = buildTables(entries);
    const t1 = performance.now();
    await getGreptimeIngestClient().write(tables); // encodeTables (sync CPU) + async send
    const t2 = performance.now();
    buildMs += t1 - t0;
    writeMs += t2 - t1;
  }

  console.log(
    `per flush (${BATCH} obs -> ${fanRowsTotal} fanned rows across ${"projection+4 EAV"}):`,
  );
  console.log(
    `  buildTables (addRowObject)      : ${(buildMs / N).toFixed(2)}ms  (pure main-thread CPU)`,
  );
  console.log(
    `  client.write (encode CPU + send): ${(writeMs / N).toFixed(2)}ms  (encode is sync CPU, send is async)`,
  );
  console.log(
    `\nbuildTables alone blocks the event loop ${(buildMs / N).toFixed(1)}ms per flush; reads queued behind it stall that long.\n` +
      `With the writer's default concurrency, several of these overlap. This is what fix 1/2 must remove from the loop.`,
  );
}

main()
  .then(async () => {
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("flush-cpu-probe failed", e);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
