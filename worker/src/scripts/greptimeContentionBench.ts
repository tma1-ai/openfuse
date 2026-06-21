/**
 * Contention microbench — the one the idle benches can't do. The fork funnels EVERYTHING onto a single
 * GreptimeDB (mito) engine: raw_events reads, projection writes, EAV writes, getProjectDeletedAt reads,
 * and background compaction. Upstream ClickHouse instead splits the load — history reads come from S3,
 * writes go to ClickHouse — so its read path never contends with its write path. That split, not
 * tokenization (which is identical on both), is the likely source of the CH-vs-fork drain gap.
 *
 * This measures readRawEventsForEntity latency (a) idle and (b) WHILE a sustained projection+EAV write
 * storm hammers the same engine. If the read p50/p95 inflates sharply under write load, read/write/
 * compaction contention on the single engine is the real bottleneck — exactly what the serial idle
 * benches missed.
 *
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeContentionBench.ts
 */
import {
  writeRawEvents,
  readRawEventsForEntity,
  getGreptimeIngestClient,
  closeGreptimeConnections,
  type RawEventInput,
  type ObservationRecordInsertType,
} from "@langfuse/shared/src/server";
import { GreptimeWriter, GreptimeTable } from "../services/GreptimeWriter";

const PROJECT = "contention-bench-0001";
const RUN = Date.now();
const READ_ENTITIES = 50; // probe entities we read repeatedly
const DEPTH = 10; // events per probe entity (realistic mid-range history)
const WRITE_RECORDS = 200_000; // sustained write load pushed during the loaded read phase
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 8000);

const filler = (n: number) => "x".repeat(Math.max(0, n));

const seedProbeEntities = async (): Promise<string[]> => {
  const ids: string[] = [];
  for (let e = 0; e < READ_ENTITIES; e++) {
    const id = `probe-${RUN}-${e}`;
    const rows: RawEventInput[] = [];
    for (let s = 0; s < DEPTH; s++) {
      const body = JSON.stringify({
        id,
        type: s === 0 ? "observation-create" : "observation-update",
        timestamp: new Date(RUN + s).toISOString(),
        body: {
          id,
          traceId: `${id}-t`,
          input: filler(750),
          output: filler(750),
        },
      });
      rows.push({
        projectId: PROJECT,
        entityType: "observation",
        entityId: id,
        eventId: `${id}-evt-${s}`,
        eventType: s === 0 ? "observation-create" : "observation-update",
        eventTs: RUN + s,
        ingestedAt: RUN + s,
        body,
      });
    }
    await writeRawEvents(rows);
    ids.push(id);
  }
  return ids;
};

const makeObservation = (i: number): ObservationRecordInsertType => ({
  id: `${PROJECT}-w-${RUN}-${i}`,
  project_id: PROJECT,
  trace_id: `${PROJECT}-wt-${RUN}-${i % 1000}`,
  type: "GENERATION",
  environment: "default",
  name: "load",
  level: "DEFAULT",
  start_time: RUN,
  end_time: RUN + 1,
  metadata: { k: "v" },
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

const stats = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (p: number) =>
    s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: s[s.length - 1],
    n: s.length,
  };
};
const ms = (n: number) => `${n.toFixed(2)}ms`;

/** Read each probe entity in a loop for `durationMs`, returning the per-read latencies. */
const probeReads = async (
  ids: string[],
  durationMs: number,
): Promise<number[]> => {
  const lat: number[] = [];
  const deadline = performance.now() + durationMs;
  let i = 0;
  while (performance.now() < deadline) {
    const id = ids[i++ % ids.length];
    const t0 = performance.now();
    await readRawEventsForEntity({
      projectId: PROJECT,
      entityType: "observation",
      entityId: id,
    });
    lat.push(performance.now() - t0);
  }
  return lat;
};

/** Sustained write storm against the engine for `durationMs`; returns rows pushed. */
const writeStorm = async (durationMs: number): Promise<number> => {
  const writer = GreptimeWriter.createForTest({
    write: (tables) => getGreptimeIngestClient().write(tables),
    batchSize: 4000,
    autoFlush: false,
    maxConcurrentFlushes: 8,
  });
  const deadline = performance.now() + durationMs;
  let i = 0;
  while (performance.now() < deadline) {
    for (let b = 0; b < 8000 && i < WRITE_RECORDS; b++, i++) {
      writer.addToQueue(GreptimeTable.Observations, makeObservation(i));
    }
    const flushes: Promise<void>[] = [];
    for (let c = 0; c < 8; c++) flushes.push(writer.flushAll(false));
    await Promise.all(flushes);
    if (i >= WRITE_RECORDS) i = 0;
  }
  await writer.flushAll(true);
  return i;
};

async function main() {
  const role = process.env.BENCH_ROLE ?? "combined";
  console.log(
    `contention-bench run=${RUN} role=${role} probes=${READ_ENTITIES}x${DEPTH}ev durationMs=${DURATION_MS}\n`,
  );

  // role=write: pure sustained write storm in its OWN process (server-side load source).
  if (role === "write") {
    const n = await writeStorm(DURATION_MS * 4);
    console.log(`WRITE storm done: pushed ${n} records`);
    return;
  }

  // role=read: pure read probe in its OWN process. Run concurrently with a separate role=write
  // process to isolate SERVER-side read/write contention from client event-loop starvation.
  if (role === "read") {
    const ids = await seedProbeEntities();
    const r = stats(await probeReads(ids, DURATION_MS));
    console.log(
      `READ-ONLY proc reads n=${r.n} (${(r.n / (DURATION_MS / 1000)).toFixed(0)}/s) | p50 ${ms(r.p50)} | p95 ${ms(r.p95)} | p99 ${ms(r.p99)} | max ${ms(r.max)}`,
    );
    return;
  }

  // role=combined (default): idle baseline, then reads + writes on the SAME process/engine.
  const ids = await seedProbeEntities();
  const idle = stats(await probeReads(ids, DURATION_MS));
  console.log(
    `IDLE    reads n=${idle.n} | p50 ${ms(idle.p50)} | p95 ${ms(idle.p95)} | p99 ${ms(idle.p99)} | max ${ms(idle.max)}`,
  );

  let written = 0;
  const storm = (async () => {
    written = await writeStorm(DURATION_MS);
  })();
  const loaded = stats(await probeReads(ids, DURATION_MS));
  await storm;

  console.log(
    `LOADED  reads n=${loaded.n} | p50 ${ms(loaded.p50)} | p95 ${ms(loaded.p95)} | p99 ${ms(loaded.p99)} | max ${ms(loaded.max)}   (writes pushed: ${written})`,
  );
  const infl = (a: number, b: number) => `${(b / a).toFixed(1)}x`;
  console.log(
    `\nread inflation under write load: p50 ${infl(idle.p50, loaded.p50)}, p95 ${infl(idle.p95, loaded.p95)}, p99 ${infl(idle.p99, loaded.p99)}.`,
  );
}

main()
  .then(async () => {
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("contention-bench failed", e);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
