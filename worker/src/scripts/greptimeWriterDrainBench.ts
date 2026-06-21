/**
 * Writer drain microbenchmark — measure the GreptimeWriter's actual flush ceiling (rows/sec pushed to
 * GreptimeDB over gRPC), isolated from the rebuild/read path. "Drain" is the writer queue emptying, so
 * this is the most direct measurement of the throughput the live ingestion is bounded by.
 *
 * The read-path microbench (greptimeDrainBench.ts) showed read+parse is a flat ~2-3ms at realistic
 * history depth, so the ~26 t/s ceiling is NOT read amplification. This measures the next suspect:
 * the writer's combined-gRPC flush throughput, swept over batch size and flush concurrency to tell a
 * round-trip-bound ceiling (helped by bigger batches) from a server-ingest-bound one (flat in batch).
 *
 * Also times getProjectDeletedAt — an extra per-job GreptimeDB round-trip in the hot path (uncached).
 *
 * Run:
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeWriterDrainBench.ts
 */
import {
  getProjectDeletedAt,
  getGreptimeIngestClient,
  closeGreptimeConnections,
  type ObservationRecordInsertType,
} from "@langfuse/shared/src/server";
import { GreptimeWriter, GreptimeTable } from "../services/GreptimeWriter";

const PROJECT = "writer-drain-bench-0001";
const RUN = Date.now();

// Records to push per configuration. Large enough that the fixed warmup is amortized.
const RECORDS = Number(process.env.BENCH_RECORDS ?? 20000);

// (batchSize, concurrency) grid. Round-trip-bound throughput climbs with both; server-ingest-bound
// throughput plateaus.
const CONFIGS = [
  { batchSize: 1000, concurrency: 4 }, // current defaults
  { batchSize: 1000, concurrency: 8 },
  { batchSize: 4000, concurrency: 4 },
  { batchSize: 4000, concurrency: 8 },
  { batchSize: 8000, concurrency: 8 },
];

const filler = (n: number): string => "x".repeat(Math.max(0, n));
const IO_BYTES = Number(process.env.BENCH_IO_BYTES ?? 500);

const makeObservation = (
  i: number,
  now: number,
): ObservationRecordInsertType => ({
  id: `${PROJECT}-obs-${RUN}-${i}`,
  project_id: PROJECT,
  trace_id: `${PROJECT}-trace-${RUN}-${i % 1000}`,
  type: "GENERATION",
  environment: "default",
  name: "bench-gen",
  level: "DEFAULT",
  start_time: now,
  end_time: now + 1000,
  metadata: { model_kind: "chat", run: String(RUN) },
  provided_model_name: "gpt-4o",
  internal_model_id: "m1",
  model_parameters: JSON.stringify({ temperature: 0.7 }),
  provided_usage_details: { input: 100, output: 50 },
  usage_details: { input: 100, output: 50, total: 150 },
  provided_cost_details: {},
  cost_details: { input: 0.0001, output: 0.0002, total: 0.0003 },
  total_cost: 0.0003,
  input: filler(IO_BYTES),
  output: filler(IO_BYTES),
  tool_definitions: {},
  tool_calls: [],
  tool_call_names: [],
  created_at: now,
  updated_at: now,
  event_ts: now,
  is_deleted: 0,
});

/**
 * Drain a pre-filled writer the way the live pump does: repeatedly launch up to `concurrency` partial
 * flushes (each splices <= batchSize rows) until the queue is empty. Returns wall time.
 */
const drain = async (
  writer: GreptimeWriter,
  concurrency: number,
): Promise<number> => {
  const t0 = performance.now();
  while (writer.pendingRows() > 0) {
    const batch: Promise<void>[] = [];
    for (let c = 0; c < concurrency && writer.pendingRows() > 0; c++) {
      batch.push(writer.flushAll(false));
    }
    await Promise.all(batch);
  }
  await writer.flushAll(true); // sweep any straggler released by the entity guard
  return performance.now() - t0;
};

async function measureProjectDeletedAt(): Promise<void> {
  // Warm.
  await getProjectDeletedAt(PROJECT);
  const xs: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await getProjectDeletedAt(PROJECT);
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  console.log(
    `getProjectDeletedAt (per-job hot-path round-trip): p50=${xs[15].toFixed(2)}ms p95=${xs[28].toFixed(2)}ms\n`,
  );
}

async function main() {
  console.log(
    `writer-drain-bench run=${RUN} records=${RECORDS} ioBytes=${IO_BYTES} (observation projection + EAV fan-out)\n`,
  );

  await measureProjectDeletedAt();

  const now = Date.now();
  const records: ObservationRecordInsertType[] = [];
  for (let i = 0; i < RECORDS; i++) records.push(makeObservation(i, now));

  const header =
    "batchSize | concurrency |  records |  rows fanned |  drain s |  rec/s |  row/s";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const { batchSize, concurrency } of CONFIGS) {
    const writer = GreptimeWriter.createForTest({
      write: (tables) => getGreptimeIngestClient().write(tables),
      batchSize,
      autoFlush: false, // we drive the drain loop ourselves for a deterministic measurement
      maxConcurrentFlushes: concurrency,
    });

    for (const r of records) writer.addToQueue(GreptimeTable.Observations, r);
    const fanned = writer.pendingRows();

    const elapsedMs = await drain(writer, concurrency);
    const s = elapsedMs / 1000;
    console.log(
      `${String(batchSize).padStart(9)} | ${String(concurrency).padStart(11)} | ${String(RECORDS).padStart(8)} | ${String(fanned).padStart(12)} | ${s.toFixed(2).padStart(8)} | ${(RECORDS / s).toFixed(0).padStart(6)} | ${(fanned / s).toFixed(0).padStart(6)}`,
    );
  }

  console.log(
    `\nrec/s = projection entities drained per second (compare to the ~26 t/s live ceiling and CH ~153).\n` +
      `If rec/s climbs with batchSize+concurrency, the writer is round-trip-bound; if flat, server-ingest-bound.`,
  );
}

main()
  .then(async () => {
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("writer-drain-bench failed", e);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
