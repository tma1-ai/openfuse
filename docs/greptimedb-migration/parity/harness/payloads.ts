/**
 * Deterministic payload set for the parity run.
 *
 * Built ONCE per run and sent byte-identical to both stacks. Entity ids are salted with
 * runId so periodic runs never collide; all timestamps sit inside a single run window,
 * placed off hour/day boundaries (date_bin vs toStartOfInterval bucket safety).
 *
 * Cost is provided EXPLICITLY (usageDetails + costDetails) so the core suite does not
 * depend on model-pricing config. A separate computed-cost generation (model + usage,
 * no costDetails) exercises pricing parity.
 */
import type { ParityConfig, WaitExpectation } from "./lib";

export interface DatasetSpec {
  datasetName: string;
  itemIds: string[];
  runName: string;
  /** run-item links: datasetItemId -> traceId */
  runItems: { datasetItemId: string; traceId: string }[];
}

export interface ModelSpec {
  modelName: string;
  matchPattern: string;
  unit: string;
  inputPrice: number;
  outputPrice: number;
}

export interface PayloadSet {
  batch: unknown[];
  manifest: WaitExpectation;
  window: { from: string; to: string };
  dataset: DatasetSpec;
  /** Custom model created identically on both stacks → equivalent cost computation. */
  model: ModelSpec;
  /** Values referenced by the read matrix. */
  facets: {
    traceT1: string;
    traceT2: string;
    genObs: string;
    userA: string;
    userB: string;
    sessionA: string;
    envProd: string;
    envStaging: string;
    tagAlpha: string;
    tagBeta: string;
    model: string;
    release: string;
    version: string;
    updatedGenName: string;
    numericScoreName: string;
    categoricalScoreName: string;
    toolSearch: string;
    toolCalc: string;
  };
}

export function buildPayloads(cfg: ParityConfig): PayloadSet {
  const r = cfg.runId;
  const windowStartMs = cfg.runNowMs - 90 * 60_000;
  // off-boundary instant builder: minutesAfterStart + secs (never lands on :00)
  const t = (min: number, sec: number) =>
    new Date(windowStartMs + min * 60_000 + sec * 1000 + 137).toISOString();

  const traceT1 = `tr-${r}-1`;
  const traceT2 = `tr-${r}-2`;
  const genObs = `ob-${r}-gen1`;
  const spanObs = `ob-${r}-span1`;
  const eventObs = `ob-${r}-evt1`;
  const agentObs = `ob-${r}-agent1`;
  const gen2Obs = `ob-${r}-gen2`; // under T2
  const userA = `usr-${r}-A`;
  const userB = `usr-${r}-B`;
  const sessionA = `se-${r}-A`;
  // Run-unique environments isolate periodic runs from one another (broad metrics/list queries
  // are scoped to env IN [envProd, envStaging] so prior runs in the same project don't leak in).
  const envProd = `pe${r}`;
  const envStaging = `se${r}`;
  const tagAlpha = "alpha";
  const tagBeta = "beta";
  // Custom model (created on both stacks) so model-derived prices/cost are equivalent and do
  // not depend on the image-shipped default catalog (which differs: fork 166 vs upstream 87).
  const model = `parity-model-${r}`;
  const modelSpec = {
    modelName: model,
    matchPattern: `(?i)^${model}$`,
    unit: "TOKENS",
    inputPrice: 0.00001, // usage input 120 -> 0.0012
    outputPrice: 0.00002, // usage output 80 -> 0.0016 ; total 0.0028
  };
  const release = "1.0.0";
  const version = "v1";
  const updatedGenName = `gen-updated-${r}`;
  const numericScoreName = "quality";
  const categoricalScoreName = "sentiment";

  const sc1 = `sc-${r}-1`;
  const sc2 = `sc-${r}-2`;
  const sc3 = `sc-${r}-3`;
  const sc4 = `sc-${r}-4`;

  const usage = { input: 120, output: 80, total: 200 };
  const cost = { input: 0.0012, output: 0.0016, total: 0.0028 };

  // Tool introspection (05 Finding #1): both stacks run the same ingestion extraction —
  // input.tools -> tool_definitions keys; output.tool_calls -> tool_call_names (search twice ->
  // deduped in the EAV). Placed on g2 (no update event) so the merged input/output is not overridden.
  const toolSearch = "search";
  const toolCalc = "calculator";
  const toolInput = {
    messages: [{ role: "user", content: "use tools" }],
    tools: [
      { type: "function", function: { name: toolSearch, description: "search the kb" } },
      { type: "function", function: { name: toolCalc, description: "do math" } },
    ],
  };
  const toolOutput = {
    role: "assistant",
    tool_calls: [
      { id: "call-1", type: "function", function: { name: toolSearch, arguments: "{}" } },
      { id: "call-2", type: "function", function: { name: toolSearch, arguments: "{}" } },
      { id: "call-3", type: "function", function: { name: toolCalc, arguments: "{}" } },
    ],
  };

  const evt = (label: string, type: string, body: unknown, min: number, sec: number) => ({
    id: `evt-${r}-${label}`,
    timestamp: t(min, sec),
    type,
    body,
  });

  const batch: unknown[] = [
    // --- T1 trace create + update (re-send same id, last-write merge) ---
    evt("t1-create", "trace-create", {
      id: traceT1,
      timestamp: t(1, 5),
      name: "checkout-flow",
      userId: userA,
      sessionId: sessionA,
      environment: envProd,
      release,
      version,
      tags: [tagAlpha, tagBeta],
      metadata: { tier: "gold", region: "eu" },
      input: { q: "place order" },
      output: { a: "ok" },
      public: false,
    }, 1, 5),
    evt("t1-update", "trace-create", {
      id: traceT1,
      timestamp: t(1, 5),
      name: "checkout-flow",
      userId: userA,
      sessionId: sessionA,
      environment: envProd,
      tags: [tagAlpha, tagBeta, "updated"],
      output: { a: "ok", revised: true },
    }, 2, 9),

    // --- T2 trace (different user / env for dimension variety) ---
    evt("t2-create", "trace-create", {
      id: traceT2,
      timestamp: t(3, 11),
      name: "support-chat",
      userId: userB,
      environment: envStaging,
      release,
      version,
      tags: [tagBeta],
      metadata: { tier: "silver" },
    }, 3, 11),

    // --- T1 generation create + update (cost provided explicitly) ---
    evt("g1-create", "generation-create", {
      id: genObs,
      traceId: traceT1,
      environment: envProd,
      name: "llm-call",
      startTime: t(4, 3),
      endTime: t(4, 33),
      completionStartTime: t(4, 12),
      model,
      modelParameters: { temperature: 0.2, max_tokens: 256 },
      input: [{ role: "user", content: "hi" }],
      output: { role: "assistant", content: "hello" },
      usageDetails: usage,
      costDetails: cost,
      level: "DEFAULT",
      metadata: { stage: "answer" },
    }, 4, 3),
    evt("g1-update", "generation-update", {
      id: genObs,
      traceId: traceT1,
      environment: envProd,
      name: updatedGenName,
      startTime: t(4, 3),
      endTime: t(4, 40),
      output: { role: "assistant", content: "hello (revised)" },
    }, 5, 7),

    // --- T1 span create + update ---
    evt("s1-create", "span-create", {
      id: spanObs,
      traceId: traceT1,
      environment: envProd,
      name: "retriever",
      startTime: t(4, 1),
      endTime: t(4, 20),
      input: { query: "kb" },
      output: { hits: 3 },
      level: "DEFAULT",
    }, 4, 1),
    evt("s1-update", "span-update", {
      id: spanObs,
      traceId: traceT1,
      environment: envProd,
      startTime: t(4, 1),
      endTime: t(4, 25),
      statusMessage: "done",
    }, 5, 2),

    // --- T1 event observation ---
    evt("e1-create", "event-create", {
      id: eventObs,
      traceId: traceT1,
      environment: envProd,
      name: "cache-hit",
      startTime: t(4, 8),
      level: "DEFAULT",
      metadata: { source: "redis" },
    }, 4, 8),

    // --- T1 agent observation (non-GENERATION type) ---
    evt("a1-create", "agent-create", {
      id: agentObs,
      traceId: traceT1,
      environment: envProd,
      name: "planner",
      startTime: t(4, 15),
      endTime: t(4, 50),
      input: { goal: "plan" },
      output: { steps: 2 },
      level: "DEFAULT",
    }, 4, 15),

    // --- T2 generation (computed-cost: model + usage, NO costDetails) ---
    evt("g2-create", "generation-create", {
      id: gen2Obs,
      traceId: traceT2,
      environment: envStaging,
      name: "llm-call-2",
      startTime: t(6, 3),
      endTime: t(6, 28),
      completionStartTime: t(6, 9),
      model,
      input: toolInput,
      output: toolOutput,
      usageDetails: usage,
      level: "WARNING",
      statusMessage: "slow",
    }, 6, 3),

    // --- Scores: numeric / categorical / boolean on T1; numeric on the generation ---
    evt("sc1", "score-create", {
      id: sc1,
      traceId: traceT1,
      environment: envProd,
      name: numericScoreName,
      value: 0.85,
      dataType: "NUMERIC",
      comment: "good",
      source: "API",
    }, 7, 1),
    evt("sc2", "score-create", {
      id: sc2,
      traceId: traceT1,
      environment: envProd,
      name: categoricalScoreName,
      value: "positive",
      dataType: "CATEGORICAL",
      source: "API",
    }, 7, 4),
    evt("sc3", "score-create", {
      id: sc3,
      traceId: traceT1,
      environment: envProd,
      name: "passed",
      value: 1,
      dataType: "BOOLEAN",
      source: "API",
    }, 7, 6),
    evt("sc4", "score-create", {
      id: sc4,
      traceId: traceT1,
      observationId: genObs,
      environment: envProd,
      name: numericScoreName,
      value: 0.5,
      dataType: "NUMERIC",
      source: "API",
    }, 7, 9),
  ];

  const manifest: WaitExpectation = {
    traceIds: [traceT1, traceT2],
    observationCountByTrace: { [traceT1]: 4, [traceT2]: 1 },
    scoreIds: [sc1, sc2, sc3, sc4],
    updatedObservation: { id: genObs, expectedName: updatedGenName },
  };

  const dataset: DatasetSpec = {
    datasetName: `ds-${r}-1`,
    itemIds: [`di-${r}-1`, `di-${r}-2`],
    runName: `run-${r}-1`,
    runItems: [{ datasetItemId: `di-${r}-1`, traceId: traceT1 }],
  };

  return {
    batch,
    manifest,
    window: {
      from: new Date(windowStartMs - 10 * 60_000).toISOString(),
      to: new Date(cfg.runNowMs - 20 * 60_000).toISOString(),
    },
    dataset,
    model: modelSpec,
    facets: {
      traceT1,
      traceT2,
      genObs,
      userA,
      userB,
      sessionA,
      envProd,
      envStaging,
      tagAlpha,
      tagBeta,
      model,
      release,
      version,
      updatedGenName,
      numericScoreName,
      categoricalScoreName,
      toolSearch,
      toolCalc,
    },
  };
}
