/**
 * Drain microbenchmark — quantify the per-entity rebuild cost as a function of history depth K.
 *
 * Hypothesis under test (H1, "read amplification"): the live write path re-reads an entity's FULL
 * raw_events history on every rebuild (`readRawEventsForEntity`) and re-parses every body
 * (`parseRawEventHistory`). If both scale with the entity's accumulated event count K, then a
 * long-lived entity (a trace with many child updates, a generation updated repeatedly) gets
 * quadratically more expensive over its life — the suspected cause of the ~26 t/s drain ceiling.
 *
 * This isolates the read + parse stages (no PG / redis / writer gRPC), seeding controlled history
 * depths and timing each stage per rebuild. It does NOT measure the merge/enrich CPU (that path
 * needs PG + redis) — run it only after this settles whether read dominates.
 *
 * Run from the worker package against the local stack:
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeDrainBench.ts
 *
 * raw_events is append_mode (DELETE is rejected), so every run uses a unique entity-id prefix to stay
 * isolated; old fixtures age out via TTL.
 */
import {
  writeRawEvents,
  readRawEventsForEntity,
  parseRawEventHistory,
  closeGreptimeConnections,
  type RawEventInput,
} from "@langfuse/shared/src/server";

const PROJECT = "drain-bench-0001";
// History depths to sweep. Picked to span the realistic range (most entities are shallow) into the
// heavy tail (a long trace / repeatedly-updated generation) where amplification would bite.
const DEPTHS = [1, 3, 10, 30, 100, 300];
// Distinct entities per depth — each is read+parsed once; we aggregate the per-entity timings.
const ENTITIES_PER_DEPTH = 30;
// Approximate body payload size per event (input+output strings). A generation body is commonly a
// few KB; vary via BENCH_BODY_BYTES to see the read-bytes sensitivity.
const BODY_BYTES = Number(process.env.BENCH_BODY_BYTES ?? 1500);

const RUN = Date.now();

const filler = (n: number): string => "x".repeat(Math.max(0, n));

/** One realistic observation event body of ~BODY_BYTES, stored verbatim in raw_events.body. */
const makeEvent = (entityId: string, seq: number, startMs: number) => {
  const half = Math.floor(BODY_BYTES / 2);
  const type = seq === 0 ? "observation-create" : "observation-update";
  return {
    id: `${entityId}-evt-${seq}`,
    type,
    timestamp: new Date(startMs + seq).toISOString(),
    body: {
      id: entityId,
      traceId: `${entityId}-trace`,
      type: "GENERATION",
      name: "bench-generation",
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + seq + 1).toISOString(),
      model: "gpt-4o",
      input: filler(half),
      output: filler(half),
      usageDetails: { input: 100, output: 50, total: 150 },
    },
  };
};

const seedEntity = async (entityId: string, depth: number): Promise<number> => {
  const startMs = RUN;
  const rows: RawEventInput[] = [];
  let bytes = 0;
  for (let seq = 0; seq < depth; seq++) {
    const body = JSON.stringify(makeEvent(entityId, seq, startMs));
    bytes += Buffer.byteLength(body, "utf8");
    rows.push({
      projectId: PROJECT,
      entityType: "observation",
      entityId,
      eventId: `${entityId}-evt-${seq}`,
      eventType: seq === 0 ? "observation-create" : "observation-update",
      eventTs: startMs + seq,
      ingestedAt: startMs + seq,
      body,
    });
  }
  // Chunk the append so a deep entity doesn't build one oversized gRPC frame.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await writeRawEvents(rows.slice(i, i + CHUNK));
  }
  return bytes;
};

const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
};

const stats = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    p50: pct(s, 50),
    p95: pct(s, 95),
    mean: sum / s.length,
  };
};

const ms = (n: number) => `${n.toFixed(2)}ms`;

async function main() {
  console.log(
    `drain-bench run=${RUN} project=${PROJECT} bodyBytes=${BODY_BYTES} entitiesPerDepth=${ENTITIES_PER_DEPTH}`,
  );
  console.log(
    `depths=${DEPTHS.join(",")} — stage = readRawEventsForEntity + parseRawEventHistory (read+parse only)\n`,
  );

  const header =
    "depth |  read p50 |  read p95 | parse p50 | parse p95 | rebuild p50 | rebuild p95 |  rows |  bodyKB | KB/rebuild";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const depth of DEPTHS) {
    // Seed all entities for this depth first.
    const entityIds: string[] = [];
    let totalBodyBytes = 0;
    for (let i = 0; i < ENTITIES_PER_DEPTH; i++) {
      const id = `obs-${RUN}-d${depth}-${i}`;
      totalBodyBytes += await seedEntity(id, depth);
      entityIds.push(id);
    }

    // Warm one read so the first measured read doesn't pay connection/cache warmup.
    await readRawEventsForEntity({
      projectId: PROJECT,
      entityType: "observation",
      entityId: entityIds[0],
    });

    const readMs: number[] = [];
    const parseMs: number[] = [];
    const totalMs: number[] = [];
    let rowsSeen = 0;
    let bytesSeen = 0;

    for (const id of entityIds) {
      const t0 = performance.now();
      const rows = await readRawEventsForEntity({
        projectId: PROJECT,
        entityType: "observation",
        entityId: id,
      });
      const t1 = performance.now();
      const parsed = parseRawEventHistory(rows);
      const t2 = performance.now();

      readMs.push(t1 - t0);
      parseMs.push(t2 - t1);
      totalMs.push(t2 - t0);
      rowsSeen = rows.length;
      bytesSeen = rows.reduce(
        (n, r) => n + Buffer.byteLength(String(r.body), "utf8"),
        0,
      );
      // Sanity: parsed event count should equal depth (no dedup collisions).
      if (parsed.events.length !== depth) {
        console.error(
          `  WARN depth=${depth} id=${id}: parsed ${parsed.events.length} events, expected ${depth}`,
        );
      }
    }

    const r = stats(readMs);
    const p = stats(parseMs);
    const t = stats(totalMs);
    const kbPerRebuild = bytesSeen / 1024;
    console.log(
      `${String(depth).padStart(5)} | ${ms(r.p50).padStart(9)} | ${ms(r.p95).padStart(9)} | ${ms(p.p50).padStart(9)} | ${ms(p.p95).padStart(9)} | ${ms(t.p50).padStart(11)} | ${ms(t.p95).padStart(11)} | ${String(rowsSeen).padStart(5)} | ${(totalBodyBytes / 1024).toFixed(0).padStart(7)} | ${kbPerRebuild.toFixed(1).padStart(10)}`,
    );
  }

  console.log(
    `\nRead the slope: if read p50 grows ~linearly with depth and dominates rebuild time, H1 holds.\n` +
      `A flat read across depths means the bottleneck is elsewhere (merge/enrich or writer).`,
  );
}

main()
  .then(async () => {
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("drain-bench failed", e);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
