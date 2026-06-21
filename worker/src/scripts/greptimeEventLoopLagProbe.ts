/**
 * Split client.write() into its SYNC (event-loop-blocking) encode vs its ASYNC network send by
 * measuring event-loop lag: a heartbeat timer that should fire every 5ms; the largest gap while a
 * write is in flight is the synchronous stall (the protobuf encodeTables CPU). This decides whether
 * fix 1 (offload encode to a worker thread) is worthwhile vs the send being already async.
 *
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeEventLoopLagProbe.ts
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
const BATCH = Number(process.env.BENCH_BATCH ?? 1000);
const filler = (n: number) => "x".repeat(n);

const makeObs = (i: number): ObservationRecordInsertType => ({
  id: `lag-${RUN}-${i}`,
  project_id: "lag-probe",
  trace_id: `lag-${RUN}-t-${i % 500}`,
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

async function main() {
  console.log(`event-loop-lag-probe batch=${BATCH}\n`);

  const records = Array.from({ length: BATCH }, (_, i) => makeObs(i));
  const byTable = new Map<string, GreptimeRow[]>();
  for (const r of records) {
    for (const { table, rows } of buildGreptimeRowsForRecord(
      GreptimeTable.Observations,
      r,
      RUN,
    )) {
      const cur = byTable.get(table);
      if (cur) cur.push(...rows);
      else byTable.set(table, [...rows]);
    }
  }
  const tables: Table[] = [...byTable].map(([table, rows]) => {
    const t = PHYSICAL_TABLES[table]();
    for (const row of rows) t.addRowObject(row);
    return t;
  });

  // Heartbeat: expected every 5ms. Any gap >> 5ms is the event loop blocked by sync CPU.
  let lastBeat = performance.now();
  let maxLag = 0;
  const lags: number[] = [];
  const beat = () => {
    const now = performance.now();
    const lag = now - lastBeat - 5;
    if (lag > 1) lags.push(lag);
    if (lag > maxLag) maxLag = lag;
    lastBeat = now;
  };
  const timer = setInterval(beat, 5);

  // A few writes, measuring the worst event-loop stall each causes.
  for (let i = 0; i < 10; i++) {
    lastBeat = performance.now();
    const t0 = performance.now();
    await getGreptimeIngestClient().write(tables);
    const wall = performance.now() - t0;
    console.log(`write #${i}: wall=${wall.toFixed(1)}ms`);
  }
  clearInterval(timer);

  lags.sort((a, b) => b - a);
  console.log(
    `\nworst event-loop stalls (ms, sync CPU blocking the loop): ${lags
      .slice(0, 5)
      .map((x) => x.toFixed(1))
      .join(", ")}`,
  );
  console.log(
    `max stall = ${maxLag.toFixed(1)}ms. If this is a large fraction of write wall, the encode is sync CPU\n` +
      `(offloading it to a worker thread — fix 1 — removes the read starvation). If near 0, the send is\n` +
      `already async and the starvation is elsewhere (buildTables / merge / tokenize).`,
  );
}

main()
  .then(async () => {
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("event-loop-lag-probe failed", e);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
