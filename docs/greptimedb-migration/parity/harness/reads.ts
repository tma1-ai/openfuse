/**
 * Read matrix: public REST list + detail endpoints with parity-relevant filters.
 * Each case is GET'd identically from both stacks and diffed. The metrics oracle is
 * generated separately (metricsMatrix.ts).
 *
 * Run isolation: broad / enum-filtered list cases are scoped to this run's environments
 * (env IN [envProd, envStaging]) so data from prior periodic runs in the same project cannot
 * leak in. Cases already keyed by a run-unique value (trace id, userId, custom model, session,
 * a single run-unique environment) need no extra scope.
 */
import type { PayloadSet } from "./payloads";

export interface ReadCase {
  label: string;
  path: string;
  /** Extra field names dropped before diff for this endpoint (e.g. server-generated ids). */
  extraDrop?: string[];
}

const enc = encodeURIComponent;

export function buildReadCases(p: PayloadSet): ReadCase[] {
  const f = p.facets;
  const { from, to } = p.window;
  const tWin = `fromTimestamp=${enc(from)}&toTimestamp=${enc(to)}`;
  const oWin = `fromStartTime=${enc(from)}&toStartTime=${enc(to)}`;
  // repeated env params == "any of" → scopes a broad query to this run only
  const envScope = `environment=${enc(f.envProd)}&environment=${enc(f.envStaging)}`;
  const cases: ReadCase[] = [];
  const add = (label: string, path: string, extraDrop?: string[]) =>
    cases.push({ label, path, extraDrop });

  // ---- traces ----
  add("traces/window", `/api/public/traces?${tWin}&${envScope}&limit=100&orderBy=timestamp.asc`);
  add("traces/userId", `/api/public/traces?${tWin}&userId=${enc(f.userA)}&limit=100`);
  add("traces/name", `/api/public/traces?${tWin}&${envScope}&name=${enc("checkout-flow")}&limit=100`);
  add("traces/tag", `/api/public/traces?${tWin}&${envScope}&tags=${enc(f.tagAlpha)}&limit=100`);
  add("traces/environment", `/api/public/traces?${tWin}&environment=${enc(f.envProd)}&limit=100`);
  add("traces/session", `/api/public/traces?${tWin}&sessionId=${enc(f.sessionA)}&limit=100`);
  add("traces/version", `/api/public/traces?${tWin}&${envScope}&version=${enc(f.version)}&limit=100`);
  add("traces/release", `/api/public/traces?${tWin}&${envScope}&release=${enc(f.release)}&limit=100`);
  add("traces/orderdesc", `/api/public/traces?${tWin}&${envScope}&limit=100&orderBy=timestamp.desc`);
  add("traces/detail-T1", `/api/public/traces/${enc(f.traceT1)}`);
  add("traces/detail-T2", `/api/public/traces/${enc(f.traceT2)}`);

  // ---- observations ----
  add("observations/byTrace", `/api/public/observations?${oWin}&traceId=${enc(f.traceT1)}&limit=100`);
  add("observations/type-gen", `/api/public/observations?${oWin}&${envScope}&type=GENERATION&limit=100`);
  add("observations/level-warn", `/api/public/observations?${oWin}&${envScope}&level=WARNING&limit=100`);
  add("observations/model", `/api/public/observations?${oWin}&model=${enc(f.model)}&limit=100`);
  add("observations/env", `/api/public/observations?${oWin}&environment=${enc(f.envProd)}&limit=100`);
  add("observations/detail-gen", `/api/public/observations/${enc(f.genObs)}`);

  // ---- scores (v1) ----
  add("scores/window", `/api/public/scores?${tWin}&${envScope}&limit=100`);
  add("scores/name", `/api/public/scores?${tWin}&${envScope}&name=${enc(f.numericScoreName)}&limit=100`);
  add("scores/dataType-num", `/api/public/scores?${tWin}&${envScope}&dataType=NUMERIC&limit=100`);
  add("scores/source-api", `/api/public/scores?${tWin}&${envScope}&source=API&limit=100`);
  add("scores/env", `/api/public/scores?${tWin}&environment=${enc(f.envProd)}&limit=100`);

  // ---- sessions ----
  add("sessions/window", `/api/public/sessions?${tWin}&${envScope}&limit=100`);
  add("sessions/env", `/api/public/sessions?${tWin}&environment=${enc(f.envProd)}&limit=100`);
  add("sessions/detail-A", `/api/public/sessions/${enc(f.sessionA)}`);

  // ---- legacy observation-shaped reads ----
  add("generations/byTrace", `/api/public/generations?${oWin}&traceId=${enc(f.traceT1)}&limit=100`);

  // ---- datasets (name-keyed; server ids dropped) ----
  add("datasets/list", `/api/public/datasets?limit=100`, ["id"]);
  add(
    "dataset-items/list",
    `/api/public/dataset-items?datasetName=${enc(p.dataset.datasetName)}&limit=100`,
    ["datasetId"],
  );
  add(
    "dataset-run",
    `/api/public/datasets/${enc(p.dataset.datasetName)}/runs/${enc(p.dataset.runName)}`,
    ["id", "datasetId", "datasetRunId"],
  );

  // ---- config-ish lists ----
  add("models/list", `/api/public/models?limit=100`);
  add("score-configs/list", `/api/public/score-configs?limit=100`);

  // ---- metrics/daily ----
  add("metrics-daily/window", `/api/public/metrics/daily?${tWin}&${envScope}`);
  add("metrics-daily/user", `/api/public/metrics/daily?${tWin}&userId=${enc(f.userA)}`);

  return cases;
}
