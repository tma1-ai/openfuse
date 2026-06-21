/**
 * Merge/enrich microbenchmark — time IngestionService.mergeAndWrite (the per-rebuild CPU + PG enrich
 * work) in isolation, with a mock writer sink so no gRPC/queue cost is included.
 *
 * The read-path and writer-flush microbenches showed the GreptimeDB data layer is fast (read <3ms at
 * realistic depth, writer ~10k rec/s), so the ~26 t/s ceiling lives in the worker per-job path. This
 * measures the prime suspects in that path:
 *   - findModel: the model-match PG regex query, run per observation rebuild; its in-process cache is
 *     OFF by default (LANGFUSE_LOCAL_CACHE_MODEL_MATCH_ENABLED), so every rebuild hits PG.
 *   - tokenization: tiktoken runs when an observation provides NO usage (CPU-heavy, serializes the
 *     20 concurrent ingestion jobs on the single event loop).
 *
 * Scenarios (per run): provided-usage (no tokenize) vs tokenize (no usage, real tiktoken).
 * Cache regime is set by env at launch; run 3x:
 *   # both caches off (PG every call) — the default production-fork config
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeMergeEnrichBench.ts
 *   # in-process model cache on
 *   LANGFUSE_LOCAL_CACHE_MODEL_MATCH_ENABLED=true pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeMergeEnrichBench.ts
 *   # redis model cache on
 *   LANGFUSE_CACHE_MODEL_MATCH_ENABLED=true pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/greptimeMergeEnrichBench.ts
 */
import { randomUUID } from "crypto";

import { prisma } from "@langfuse/shared/src/db";
import {
  redis,
  type GreptimeTable,
  type TraceRecordInsertType,
  type ObservationRecordInsertType,
  type ScoreRecordInsertType,
  type DatasetRunItemRecordInsertType,
} from "@langfuse/shared/src/server";
import { IngestionService } from "../services/IngestionService";
import type { GreptimeProjectionSink } from "../services/GreptimeWriter";

const PROJECT = "merge-enrich-bench-0001";
const MODEL = "gpt-4o";
const ITERATIONS = Number(process.env.BENCH_ITERS ?? 300);
const DEPTH = Number(process.env.BENCH_DEPTH ?? 3); // events merged per rebuild
const IO_BYTES = Number(process.env.BENCH_IO_BYTES ?? 2000);

// Realistic natural-language-ish text: whitespace-separated short words, so the BPE pretokenizer
// splits into small units (the common case). Set BENCH_FILLER=blob to use a single whitespace-free
// run (an adversarial worst case for BPE — long base64/minified payloads).
const WORDS =
  "the model generated a response about distributed systems and time series data with usage metrics".split(
    " ",
  );
const filler = (n: number): string => {
  if (process.env.BENCH_FILLER === "blob") return "x".repeat(Math.max(0, n));
  let s = "";
  let i = 0;
  while (s.length < n) s += WORDS[i++ % WORDS.length] + " ";
  return s.slice(0, n);
};

/** No-op sink: isolates merge+enrich from the writer/gRPC cost. */
const mockSink: GreptimeProjectionSink = {
  addToQueue(
    _t: GreptimeTable,
    _r:
      | TraceRecordInsertType
      | ObservationRecordInsertType
      | ScoreRecordInsertType
      | DatasetRunItemRecordInsertType,
    _g?: number,
  ): void {},
  async flushAll(): Promise<void> {},
};

type ObsEvent = {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
};

/** Build a create + (depth-1) updates for one observation; `withUsage=false` forces tokenization. */
const buildEvents = (
  entityId: string,
  depth: number,
  withUsage: boolean,
): ObsEvent[] => {
  const now = Date.now();
  const events: ObsEvent[] = [];
  for (let i = 0; i < depth; i++) {
    const body: Record<string, unknown> = {
      id: entityId,
      traceId: `${entityId}-trace`,
      type: "GENERATION",
      name: "bench-gen",
      startTime: new Date(now).toISOString(),
      endTime: new Date(now + 1000).toISOString(),
      model: MODEL,
      input: filler(IO_BYTES),
      output: filler(IO_BYTES),
    };
    if (withUsage) body.usageDetails = { input: 100, output: 50, total: 150 };
    events.push({
      id: `${entityId}-evt-${i}`,
      type: i === 0 ? "generation-create" : "generation-update",
      timestamp: new Date(now + i).toISOString(),
      body,
    });
  }
  return events;
};

const seedModel = async (): Promise<void> => {
  // A default (project-agnostic) gpt-4o model with an OpenAI tokenizer, so findModel matches and
  // tokenization has a real tokenizer to run. Compound-unique `where` can't take null projectId, so
  // check-then-create on the (null project, modelName) pair.
  const existing = await prisma.model.findFirst({
    where: { projectId: null, modelName: MODEL, unit: "TOKENS" },
  });
  if (!existing) {
    await prisma.model.create({
      data: {
        id: randomUUID(),
        modelName: MODEL,
        matchPattern: "(?i)^(gpt-4o)$",
        unit: "TOKENS",
        tokenizerId: "openai",
        tokenizerConfig: { tokenizerModel: "gpt-4o" },
        inputPrice: "0.0000025",
        outputPrice: "0.00001",
      },
    });
  }
};

const stats = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const at = (p: number) =>
    s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { p50: at(50), p95: at(95), mean: sum / s.length };
};
const ms = (n: number) => `${n.toFixed(2)}ms`;

const runScenario = async (
  label: string,
  withUsage: boolean,
): Promise<void> => {
  const svc = new IngestionService(redis!, prisma, mockSink);
  // Warm: first call pays connection + (cache-off) the initial PG plan.
  await svc.mergeAndWrite(
    "observation",
    PROJECT,
    "warm",
    new Date(),
    buildEvents("warm", DEPTH, withUsage) as never,
    false,
    Date.now(),
  );

  const xs: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const id = `obs-${i}`;
    const events = buildEvents(id, DEPTH, withUsage) as never;
    const t0 = performance.now();
    await svc.mergeAndWrite(
      "observation",
      PROJECT,
      id,
      new Date(),
      events,
      false,
      Date.now(),
    );
    xs.push(performance.now() - t0);
  }
  const r = stats(xs);
  console.log(
    `${label.padEnd(22)} | p50 ${ms(r.p50).padStart(9)} | p95 ${ms(r.p95).padStart(9)} | mean ${ms(r.mean).padStart(9)} | ~max rec/s ${(1000 / r.mean).toFixed(0).padStart(6)}`,
  );
};

async function main() {
  console.log(
    `merge-enrich-bench iters=${ITERATIONS} depth=${DEPTH} ioBytes=${IO_BYTES}\n` +
      `model-match cache: local=${process.env.LANGFUSE_LOCAL_CACHE_MODEL_MATCH_ENABLED} redis=${process.env.LANGFUSE_CACHE_MODEL_MATCH_ENABLED}\n`,
  );
  await seedModel();

  console.log(
    "scenario               |   merge p50 |   merge p95 |  merge mean | single-thread ceiling",
  );
  console.log("-".repeat(94));
  await runScenario("provided-usage", true); // no tokenization
  await runScenario("tokenize (no usage)", false); // real tiktoken

  console.log(
    `\n'single-thread rec/s' x ingestion concurrency (default 20) ~ the per-job ceiling this stage imposes.\n` +
      `Compare provided-usage vs tokenize to size the tiktoken cost; rerun with the cache env flags to size findModel-PG.`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (redis) await redis.quit();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("merge-enrich-bench failed", e);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
