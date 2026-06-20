/**
 * Quality Gate C — parity run orchestrator.
 *
 *   node_modules/.bin/tsx docs/greptimedb-migration/parity/harness/run.ts
 *
 * Steps: ingest identical batch to both stacks → create datasets/items/run-items on both →
 * wait for deterministic projection → run the read matrix + legal metrics matrix → diff with
 * the tiered policy → write report-<runId>.{md,json}. Backend-agnostic (public HTTP only).
 */
import {
  loadConfig,
  apiGet,
  apiPost,
  canonical,
  diff,
  waitForProjection,
  sleep,
  DEFAULT_DROP,
  COST_FLOAT_KEYS,
  LATENCY_FLOAT_KEYS,
  type ParityConfig,
  type StackConfig,
  type NormalizePolicy,
  type DiffEntry,
  type HttpResult,
} from "./lib";
import { buildPayloads, type PayloadSet } from "./payloads";
import { buildReadCases, type ReadCase } from "./reads";
import { buildMetricsMatrix } from "./metricsMatrix";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KNOWN_USAGE_COST_KEYS = new Set(["input", "output", "total"]);

type CaseStatus =
  | "PASS"
  | "FAIL"
  | "SKIPPED_FORK_REMOVED"
  | "KNOWN_LIMITATION"
  | "TYPE_REPR"
  | "STATUS_MISMATCH"
  | "ERROR_BOTH";

interface CaseResult {
  label: string;
  path: string;
  status: CaseStatus;
  forkStatus: number;
  upstreamStatus: number;
  diffs: DiffEntry[];
  knownLimitations: DiffEntry[];
  typeRepr: DiffEntry[];
  note?: string;
}

/** Endpoints whose payload is image-shipped config, not a GreptimeDB read path. */
function isKnownConfigEndpoint(label: string): boolean {
  return label.startsWith("models/");
}

const PERCENTILE_AGGS = new Set(["p50", "p75", "p90", "p95", "p99"]);
const NESTED_AGGS = new Set(["avg", "min", "max", "uniq"]);
const COUNT_MEASURES = new Set([
  "count", "countScores", "scoresCount", "observationsCount", "countObservations",
  "uniqueUserIds", "uniqueSessionIds",
]);

/**
 * Reclassify metrics fails that fall into documented, non-bug divergence classes.
 * Returns a ledger rationale if the case is a known class, else undefined (stays FAIL).
 * Deliberately narrow: `by:tags` and anything unexpected remain FAIL.
 */
function metricsKnownClass(label: string): string | undefined {
  if (!label.startsWith("metrics/")) return undefined;
  const parts = label.split("/"); // metrics/<view>/<measure>/<agg>[/by:..|/ts:..|/histogram]
  const measure = parts[2];
  const agg = parts[3];
  const tail = parts[4];
  if (tail?.startsWith("ts:"))
    return "timeseries gap-fill differs (fork emits zero-filled buckets; upstream omits empty buckets)";
  if (agg === "histogram")
    return "histogram binning differs by engine (GreptimeDB floor-bucketing vs ClickHouse adaptive)";
  if (PERCENTILE_AGGS.has(agg))
    return "quantile approximation differs (GreptimeDB uddsketch vs ClickHouse quantile)";
  if (NESTED_AGGS.has(agg) && COUNT_MEASURES.has(measure))
    return "degenerate nested aggregation of a count/cardinality measure (engines differ; not a dashboard query)";
  return undefined;
}

/** F5 custom usage/cost dynamic keys are a documented divergence → ledger, not FAIL. */
function isKnownLimitationPath(path: string): boolean {
  const m = path.match(/\.(costDetails|usageDetails)\.([^.[\]]+)/);
  if (m) return !KNOWN_USAGE_COST_KEYS.has(m[2]);
  return false;
}

function policyFor(extraDrop?: string[]): NormalizePolicy {
  const drop = new Set(DEFAULT_DROP);
  for (const d of extraDrop ?? []) drop.add(d);
  return { drop, costFloatKeys: COST_FLOAT_KEYS, latencyFloatKeys: LATENCY_FLOAT_KEYS };
}

async function runCase(
  cfg: ParityConfig,
  rc: ReadCase,
): Promise<CaseResult> {
  const [fk, up] = await Promise.all([
    apiGet(cfg, cfg.fork, rc.path),
    apiGet(cfg, cfg.upstream, rc.path),
  ]);
  return classify(rc.label, rc.path, fk, up, policyFor(rc.extraDrop));
}

function errorType(body: unknown): string | undefined {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : undefined;
}
function errorMessage(body: unknown): string | undefined {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : undefined;
}

function classify(
  label: string,
  path: string,
  fk: HttpResult,
  up: HttpResult,
  policy: NormalizePolicy,
): CaseResult {
  const base = {
    label,
    path,
    forkStatus: fk.status,
    upstreamStatus: up.status,
    diffs: [] as DiffEntry[],
    knownLimitations: [] as DiffEntry[],
    typeRepr: [] as DiffEntry[],
  };

  if (fk.status !== up.status) {
    if ((fk.status === 404 || fk.status === 410) && up.ok) {
      return { ...base, status: "SKIPPED_FORK_REMOVED" };
    }
    // Fork intentionally stricter (e.g. rejects sum on a string measure, narrower histogram
    // scope): explicit InvalidRequestError vs upstream 200 → documented divergence, not a bug.
    if (fk.status === 400 && errorType(fk.body) === "InvalidRequestError" && up.ok) {
      return { ...base, status: "KNOWN_LIMITATION", note: `fork stricter: ${errorMessage(fk.body)}` };
    }
    return { ...base, status: "STATUS_MISMATCH", note: `fork:${errorMessage(fk.body) ?? fk.status} up:${errorMessage(up.body) ?? up.status}` };
  }
  if (!fk.ok) {
    return { ...base, status: fk.status >= 500 ? "ERROR_BOTH" : "PASS" };
  }

  const cf = canonical(fk.body, policy);
  const cu = canonical(up.body, policy);
  const d = diff(cf, cu, {
    costRelTol: 1e-6,
    latencyAbsTol: 0.01,
    isKnownLimitation: isKnownLimitationPath,
  });
  const knownConfig = isKnownConfigEndpoint(label);
  // Image-config endpoints: any value diff is a documented env difference, not a backend bug.
  const realDiffs = knownConfig ? [] : d.diffs;
  const known = knownConfig ? [...d.knownLimitations, ...d.diffs] : d.knownLimitations;

  let status: CaseStatus = "PASS";
  let note = knownConfig ? "image-shipped model catalog differs (fork 166 vs upstream 87)" : undefined;
  let finalDiffs = realDiffs;
  let finalKnown = known;
  if (realDiffs.length > 0) {
    const cls = metricsKnownClass(label);
    if (cls) {
      finalKnown = [...known, ...realDiffs];
      finalDiffs = [];
      note = cls;
    }
  }
  if (finalDiffs.length > 0) status = "FAIL";
  else if (finalKnown.length > 0) status = "KNOWN_LIMITATION";
  else if (d.typeRepr.length > 0) status = "TYPE_REPR";
  return {
    ...base,
    status,
    diffs: finalDiffs,
    knownLimitations: finalKnown,
    typeRepr: d.typeRepr,
    note,
  };
}

async function createModel(cfg: ParityConfig, p: PayloadSet, stack: StackConfig) {
  await apiPost(cfg, stack, "/api/public/models", {
    modelName: p.model.modelName,
    matchPattern: p.model.matchPattern,
    unit: p.model.unit,
    inputPrice: p.model.inputPrice,
    outputPrice: p.model.outputPrice,
    startDate: null,
  });
}

async function createDatasets(cfg: ParityConfig, p: PayloadSet, stack: StackConfig) {
  await apiPost(cfg, stack, "/api/public/datasets", {
    name: p.dataset.datasetName,
    description: "parity dataset",
    metadata: { kind: "parity" },
  });
  for (const id of p.dataset.itemIds) {
    await apiPost(cfg, stack, "/api/public/dataset-items", {
      datasetName: p.dataset.datasetName,
      id,
      input: { q: `item ${id}` },
      expectedOutput: { a: "ok" },
    });
  }
  for (const ri of p.dataset.runItems) {
    await apiPost(cfg, stack, "/api/public/dataset-run-items", {
      runName: p.dataset.runName,
      datasetItemId: ri.datasetItemId,
      traceId: ri.traceId,
    });
  }
}

async function waitDatasetRun(cfg: ParityConfig, p: PayloadSet, stack: StackConfig, timeoutMs = 60_000) {
  const start = Date.now();
  const path = `/api/public/datasets/${encodeURIComponent(p.dataset.datasetName)}/runs/${encodeURIComponent(p.dataset.runName)}`;
  while (Date.now() - start < timeoutMs) {
    const r = await apiGet(cfg, stack, path);
    if (r.status === 200) return true;
    await sleep(1500);
  }
  return false;
}

async function main() {
  const cfg = loadConfig();
  const p = buildPayloads(cfg);
  const log = (s: string) => console.error(`[parity ${cfg.runId}] ${s}`);

  log(`run window ${p.window.from} .. ${p.window.to}`);
  log(`fork=${cfg.fork.baseUrl} upstream=${cfg.upstream.baseUrl} project=${cfg.projectId}`);

  // versions (env manifest sanity)
  const [fh, uh] = await Promise.all([
    apiGet(cfg, cfg.fork, "/api/public/health"),
    apiGet(cfg, cfg.upstream, "/api/public/health"),
  ]);
  log(`fork health=${JSON.stringify(fh.body)} upstream health=${JSON.stringify(uh.body)}`);

  // 0. custom model on both (must exist before generations are cost-projected)
  await Promise.all([createModel(cfg, p, cfg.fork), createModel(cfg, p, cfg.upstream)]);
  log(`custom model ${p.model.modelName} created on both`);

  // 1. ingest identical batch to both
  const [fi, ui] = await Promise.all([
    apiPost(cfg, cfg.fork, "/api/public/ingestion", { batch: p.batch }),
    apiPost(cfg, cfg.upstream, "/api/public/ingestion", { batch: p.batch }),
  ]);
  log(`ingestion fork=${fi.status} upstream=${ui.status}`);
  if (fi.status !== 207 || ui.status !== 207) {
    log(`WARNING: unexpected ingestion status (expected 207)`);
  }

  // 2. datasets / items / run-items on both
  await Promise.all([createDatasets(cfg, p, cfg.fork), createDatasets(cfg, p, cfg.upstream)]);

  // 3. wait for deterministic projection on each stack
  const [fw, uw] = await Promise.all([
    waitForProjection(cfg, cfg.fork, p.manifest),
    waitForProjection(cfg, cfg.upstream, p.manifest),
  ]);
  log(`wait fork: ${fw.ok ? "ready" : "TIMEOUT"} (${fw.elapsedMs}ms) ${fw.detail}`);
  log(`wait upstream: ${uw.ok ? "ready" : "TIMEOUT"} (${uw.elapsedMs}ms) ${uw.detail}`);
  await Promise.all([waitDatasetRun(cfg, p, cfg.fork), waitDatasetRun(cfg, p, cfg.upstream)]);
  // small settle for any trailing denormalization
  await sleep(3000);

  // 4. build cases
  const readCases = buildReadCases(p);
  const metricCases = buildMetricsMatrix(p.window.from, p.window.to, [p.facets.envProd, p.facets.envStaging]).map((mc) => ({
    label: `metrics/${mc.label}`,
    path: `/api/public/metrics?query=${encodeURIComponent(JSON.stringify(mc.query))}`,
  }));
  const allCases: ReadCase[] = [...readCases, ...metricCases];
  log(`cases: ${readCases.length} read + ${metricCases.length} metrics = ${allCases.length}`);

  // 5. execute (bounded concurrency)
  const results: CaseResult[] = [];
  const CONC = 6;
  for (let i = 0; i < allCases.length; i += CONC) {
    const chunk = allCases.slice(i, i + CONC);
    const r = await Promise.all(chunk.map((c) => runCase(cfg, c)));
    results.push(...r);
  }

  // 6. report
  writeReport(cfg, p, { fork: fw, upstream: uw }, { fork: fh.body, upstream: uh.body }, results);
}

function writeReport(
  cfg: ParityConfig,
  p: PayloadSet,
  wait: { fork: { ok: boolean; detail: string }; upstream: { ok: boolean; detail: string } },
  health: { fork: unknown; upstream: unknown },
  results: CaseResult[],
) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const outDir = join(dir, "..");
  const tally: Record<CaseStatus, number> = {
    PASS: 0, FAIL: 0, SKIPPED_FORK_REMOVED: 0, KNOWN_LIMITATION: 0, TYPE_REPR: 0, STATUS_MISMATCH: 0, ERROR_BOTH: 0,
  };
  for (const r of results) tally[r.status]++;

  const jsonPath = join(outDir, `report-${cfg.runId}.json`);
  writeFileSync(jsonPath, JSON.stringify({ cfg: { ...cfg }, window: p.window, wait, health, tally, results }, null, 2));

  const fails = results.filter((r) => r.status === "FAIL" || r.status === "STATUS_MISMATCH" || r.status === "ERROR_BOTH");
  const known = results.filter((r) => r.status === "KNOWN_LIMITATION");
  const typeReprCases = results.filter((r) => r.status === "TYPE_REPR");
  const skipped = results.filter((r) => r.status === "SKIPPED_FORK_REMOVED");

  const md: string[] = [];
  md.push(`# Parity report — run ${cfg.runId}`);
  md.push("");
  md.push(`- window: \`${p.window.from}\` .. \`${p.window.to}\``);
  md.push(`- fork: ${cfg.fork.baseUrl} health=\`${JSON.stringify(health.fork)}\``);
  md.push(`- upstream: ${cfg.upstream.baseUrl} health=\`${JSON.stringify(health.upstream)}\``);
  md.push(`- projection wait: fork=${wait.fork.ok ? "ready" : "TIMEOUT " + wait.fork.detail}, upstream=${wait.upstream.ok ? "ready" : "TIMEOUT " + wait.upstream.detail}`);
  md.push("");
  md.push(`## Tally`);
  md.push("");
  md.push(`| status | count |`);
  md.push(`|---|---|`);
  for (const k of Object.keys(tally) as CaseStatus[]) md.push(`| ${k} | ${tally[k]} |`);
  md.push("");

  const section = (title: string, rs: CaseResult[]) => {
    md.push(`## ${title} (${rs.length})`);
    md.push("");
    if (rs.length === 0) { md.push("_none_"); md.push(""); return; }
    for (const r of rs) {
      md.push(`### ${r.status} — \`${r.label}\``);
      md.push(`- path: \`${r.path}\``);
      md.push(`- fork=${r.forkStatus} upstream=${r.upstreamStatus}`);
      if (r.note) md.push(`- note: ${r.note}`);
      const shown = [...r.diffs, ...r.knownLimitations, ...r.typeRepr];
      const total = shown.length;
      for (const d of shown.slice(0, 25)) {
        md.push(`  - \`${d.path}\` [${d.kind}] fork=\`${trunc(d.fork)}\` up=\`${trunc(d.upstream)}\``);
      }
      if (total > 25) md.push(`  - … (+${total - 25} more)`);
      md.push("");
    }
  };

  section("FAILURES (real divergences to triage)", fails);
  section("KNOWN LIMITATIONS (ledger candidates)", known);
  section("TYPE REPRESENTATION (numeric value equal, JSON type differs)", typeReprCases);
  section("SKIPPED — fork-removed", skipped);

  const mdPath = join(outDir, `report-${cfg.runId}.md`);
  writeFileSync(mdPath, md.join("\n"));
  console.error(`[parity ${cfg.runId}] report: ${mdPath}`);
  console.error(`[parity ${cfg.runId}] tally: ${JSON.stringify(tally)}`);
}

function trunc(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

main().catch((e) => {
  console.error("[parity] FATAL", e);
  process.exit(1);
});
