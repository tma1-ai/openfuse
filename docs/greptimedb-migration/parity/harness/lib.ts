/**
 * Quality Gate C — parity harness shared library.
 *
 * Config, HTTP (public REST, basic auth), canonicalization, tiered diff, and the
 * deterministic async-projection wait. Backend-agnostic: drives only public HTTP.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StackConfig {
  name: string;
  baseUrl: string;
}

export interface ParityConfig {
  fork: StackConfig;
  upstream: StackConfig;
  publicKey: string;
  secretKey: string;
  projectId: string;
  /** Single instant the run is anchored to (ms). Built once → identical payloads to both stacks. */
  runNowMs: number;
  /** Short id derived from runNowMs; salts entity ids so periodic runs never collide. */
  runId: string;
}

export function loadConfig(): ParityConfig {
  const runNowMs = process.env.PARITY_NOW_MS
    ? Number(process.env.PARITY_NOW_MS)
    : Date.now();
  return {
    fork: { name: "fork", baseUrl: process.env.PARITY_FORK_URL ?? "http://localhost:3000" },
    upstream: { name: "upstream", baseUrl: process.env.PARITY_UPSTREAM_URL ?? "http://localhost:3001" },
    publicKey: process.env.PARITY_PUBLIC_KEY ?? "pk-lf-parity00000000000000000001",
    secretKey: process.env.PARITY_SECRET_KEY ?? "sk-lf-parity00000000000000000001",
    projectId: process.env.PARITY_PROJECT_ID ?? "parity-proj",
    runNowMs,
    runId: runNowMs.toString(36),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  body: unknown;
  ok: boolean;
}

function authHeader(cfg: ParityConfig): string {
  return "Basic " + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
}

export async function apiGet(
  cfg: ParityConfig,
  stack: StackConfig,
  path: string,
): Promise<HttpResult> {
  const res = await fetch(stack.baseUrl + path, {
    method: "GET",
    headers: { Authorization: authHeader(cfg), Accept: "application/json" },
  });
  return { status: res.status, ok: res.ok, body: await safeJson(res) };
}

export async function apiPost(
  cfg: ParityConfig,
  stack: StackConfig,
  path: string,
  payload: unknown,
): Promise<HttpResult> {
  const res = await fetch(stack.baseUrl + path, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, ok: res.ok, body: await safeJson(res) };
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __nonJson: text.slice(0, 2000) };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Canonicalization + tiered diff
// ---------------------------------------------------------------------------

/** Field-name policy applied recursively during canonicalization. */
export interface NormalizePolicy {
  /** Fields dropped everywhere (volatile / server-assigned / host-specific). */
  drop: Set<string>;
  /** Float fields compared with relative tolerance (cost) — by suffix/name match. */
  costFloatKeys: Set<string>;
  /** Float fields compared with absolute tolerance (latency/time). */
  latencyFloatKeys: Set<string>;
}

export const DEFAULT_DROP = new Set([
  "createdAt",
  "updatedAt",
  "htmlPath",
  // pagination plumbing
  "meta",
  "nextCursor",
  "prevCursor",
  // server-generated model id (custom model created per-stack → different cuid; the derived
  // usagePricingTierId embeds it). Prices/tier NAME are compared (they match via custom model).
  "modelId",
  "usagePricingTierId",
  // fork-only pricing-tier enrichment (fork names the default tier "Standard"; upstream
  // v3.184.1 returns null) → additive fork feature, ledgered separately, not a read-path bug
  "usagePricingTierName",
  // dataset-run-item server-generated id (matched on natural key instead)
]);

export const COST_FLOAT_KEYS = new Set([
  "totalCost",
  "calculatedTotalCost",
  "calculatedInputCost",
  "calculatedOutputCost",
  "inputPrice",
  "outputPrice",
  "totalPrice",
]);

export const LATENCY_FLOAT_KEYS = new Set([
  "latency",
  "timeToFirstToken",
]);

/**
 * Canonical deep copy: sort object keys, drop policy fields, sort arrays by a stable key.
 * Arrays of objects are sorted by `id` if present, else by a JSON fingerprint; arrays of
 * scalars are sorted lexically. This removes ordering ties before diffing.
 */
export function canonical(value: unknown, policy: NormalizePolicy): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v, policy));
    return [...items].sort((a, b) => fingerprint(a).localeCompare(fingerprint(b)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (policy.drop.has(key)) continue;
      out[key] = canonical((value as Record<string, unknown>)[key], policy);
    }
    return out;
  }
  return value;
}

function fingerprint(v: unknown): string {
  if (v && typeof v === "object") {
    const id = (v as Record<string, unknown>).id;
    if (typeof id === "string" || typeof id === "number") return `id:${id}`;
    // normalize numeric-string and datetime-format differences so equal rows sort together
    return "obj:" + JSON.stringify(deepNorm(v));
  }
  return "s:" + JSON.stringify(deepNorm(v));
}

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Coerce an ISO datetime / date string to epoch ms, else null. */
function asDate(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

/** Recursively coerce numeric strings → numbers and date strings → epoch for stable comparison. */
function deepNorm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepNorm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = deepNorm((v as Record<string, unknown>)[k]);
    return out;
  }
  const n = asNum(v);
  if (n !== null) return n;
  const d = asDate(v);
  if (d !== null) return `@${d}`;
  return v;
}

export interface DiffEntry {
  path: string;
  fork: unknown;
  upstream: unknown;
  kind: "value_mismatch" | "missing_in_fork" | "missing_in_upstream" | "type_mismatch";
}

export interface DiffOptions {
  costRelTol: number; // relative tolerance for cost floats
  latencyAbsTol: number; // absolute tolerance for latency floats
  /** Predicate: given a path, treat any diff under it as KNOWN_LIMITATION instead of FAIL. */
  isKnownLimitation?: (path: string) => boolean;
}

export interface DiffResult {
  diffs: DiffEntry[];
  knownLimitations: DiffEntry[];
  /** Numerically equal but JSON types differ (e.g. ClickHouse "2" vs GreptimeDB 2). */
  typeRepr: DiffEntry[];
}

/** Coerce a number or a pure-numeric string to a finite number, else null. */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Deep diff over already-canonicalized values. */
export function diff(
  fork: unknown,
  upstream: unknown,
  opts: DiffOptions,
  path = "$",
  acc: DiffResult = { diffs: [], knownLimitations: [], typeRepr: [] },
): DiffResult {
  const push = (e: DiffEntry) => {
    if (opts.isKnownLimitation?.(path)) acc.knownLimitations.push(e);
    else acc.diffs.push(e);
  };

  if (fork === undefined || upstream === undefined) {
    if (fork !== upstream) {
      push({
        path,
        fork,
        upstream,
        kind: fork === undefined ? "missing_in_fork" : "missing_in_upstream",
      });
    }
    return acc;
  }

  // numeric comparison incl. number-vs-numeric-string (cross-backend JSON serialization)
  const fa = asNum(fork);
  const ua = asNum(upstream);
  if (fa !== null && ua !== null) {
    if (numbersEqual(fa, ua, path, opts)) {
      if (typeof fork !== typeof upstream) {
        acc.typeRepr.push({ path, fork, upstream, kind: "type_mismatch" });
      }
    } else {
      push({ path, fork, upstream, kind: "value_mismatch" });
    }
    return acc;
  }

  // datetime comparison: same instant, different string format (e.g. "…T05:00:00Z" vs
  // "…T05:00:00.000Z" vs date-only) → representation; different instant → real diff.
  const fd = asDate(fork);
  const ud = asDate(upstream);
  if (fd !== null && ud !== null) {
    if (fd === ud) {
      if (fork !== upstream) acc.typeRepr.push({ path, fork, upstream, kind: "type_mismatch" });
    } else {
      push({ path, fork, upstream, kind: "value_mismatch" });
    }
    return acc;
  }

  if (Array.isArray(fork) && Array.isArray(upstream)) {
    const n = Math.max(fork.length, upstream.length);
    for (let i = 0; i < n; i++) {
      diff(fork[i], upstream[i], opts, `${path}[${i}]`, acc);
    }
    return acc;
  }

  if (isObj(fork) && isObj(upstream)) {
    const keys = new Set([...Object.keys(fork), ...Object.keys(upstream)]);
    for (const k of [...keys].sort()) {
      diff(
        (fork as Record<string, unknown>)[k],
        (upstream as Record<string, unknown>)[k],
        opts,
        `${path}.${k}`,
        acc,
      );
    }
    return acc;
  }

  if (typeof fork !== typeof upstream) {
    push({ path, fork, upstream, kind: "type_mismatch" });
    return acc;
  }
  if (JSON.stringify(fork) !== JSON.stringify(upstream)) {
    push({ path, fork, upstream, kind: "value_mismatch" });
  }
  return acc;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function lastSegmentKey(path: string): string {
  const m = path.match(/\.([A-Za-z0-9_]+)(\[\d+\])?$/);
  return m ? m[1] : "";
}

function numbersEqual(a: number, b: number, path: string, opts: DiffOptions): boolean {
  if (a === b) return true;
  const key = lastSegmentKey(path);
  if (COST_FLOAT_KEYS.has(key)) {
    const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return Math.abs(a - b) / denom <= opts.costRelTol;
  }
  if (LATENCY_FLOAT_KEYS.has(key)) {
    return Math.abs(a - b) <= opts.latencyAbsTol;
  }
  // generic float tolerance (aggregation rounding)
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / denom <= 1e-9;
}

// ---------------------------------------------------------------------------
// Deterministic async-projection wait (id / count based — NOT aggregate based)
// ---------------------------------------------------------------------------

export interface WaitExpectation {
  traceIds: string[];
  /** traceId -> expected observation count */
  observationCountByTrace: Record<string, number>;
  scoreIds: string[];
  /** Optional: an observation id whose `name` must equal the last-write value. */
  updatedObservation?: { id: string; expectedName: string };
}

export interface WaitResult {
  ok: boolean;
  stack: string;
  detail: string;
  elapsedMs: number;
}

export async function waitForProjection(
  cfg: ParityConfig,
  stack: StackConfig,
  exp: WaitExpectation,
  timeoutMs = 120_000,
  intervalMs = 1500,
): Promise<WaitResult> {
  const start = Date.now();
  let lastDetail = "";
  while (Date.now() - start < timeoutMs) {
    lastDetail = "";
    let allOk = true;

    // 1. every trace exists
    for (const id of exp.traceIds) {
      const r = await apiGet(cfg, stack, `/api/public/traces/${id}`);
      if (r.status !== 200) {
        allOk = false;
        lastDetail = `trace ${id} -> ${r.status}`;
        break;
      }
    }

    // 2. observation counts per trace
    if (allOk) {
      for (const [traceId, expected] of Object.entries(exp.observationCountByTrace)) {
        const r = await apiGet(
          cfg,
          stack,
          `/api/public/observations?traceId=${traceId}&limit=100`,
        );
        const got = countData(r.body);
        if (got < expected) {
          allOk = false;
          lastDetail = `obs(trace=${traceId}) ${got}/${expected}`;
          break;
        }
      }
    }

    // 3. updated-field reflects last write (deterministic, not an aggregate)
    if (allOk && exp.updatedObservation) {
      const r = await apiGet(
        cfg,
        stack,
        `/api/public/observations/${exp.updatedObservation.id}`,
      );
      const name = (r.body as Record<string, unknown> | null)?.name;
      if (name !== exp.updatedObservation.expectedName) {
        allOk = false;
        lastDetail = `update not applied: name=${String(name)}`;
      }
    }

    // 4. score count
    if (allOk && exp.scoreIds.length) {
      const csv = exp.scoreIds.join(",");
      const r = await apiGet(cfg, stack, `/api/public/scores?scoreIds=${csv}&limit=100`);
      const got = countData(r.body);
      if (got < exp.scoreIds.length) {
        allOk = false;
        lastDetail = `scores ${got}/${exp.scoreIds.length}`;
      }
    }

    if (allOk) return { ok: true, stack: stack.name, detail: "ready", elapsedMs: Date.now() - start };
    await sleep(intervalMs);
  }
  return { ok: false, stack: stack.name, detail: `timeout: ${lastDetail}`, elapsedMs: Date.now() - start };
}

function countData(body: unknown): number {
  const data = (body as { data?: unknown[] } | null)?.data;
  return Array.isArray(data) ? data.length : 0;
}
