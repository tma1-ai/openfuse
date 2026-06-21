/**
 * Gated black-box integration suite for the GreptimeDB read path (issue #55).
 *
 * Why this exists
 * ---------------
 * The GreptimeDB read path can ship *plan-time* SQL errors (unresolved columns,
 * unsupported constructs) that pass every string-assertion unit test and only
 * fail when a real query is planned by GreptimeDB. The motivating regression:
 * `sessions.all` returned 500 for every Sessions-list query because the
 * `session_tags` CTE joined `traces_tags` on `mt.generation = t.eav_generation`
 * but its column-limited inner subquery did not project `eav_generation`
 * (fixed in b46fce768). The generated SQL *string* looked valid, so nothing
 * short of planning the query against a live engine could catch it.
 *
 * What this suite does
 * --------------------
 * It seeds a small, self-contained, *discriminating* dataset under a fresh
 * projectId through the real GreptimeDB write path, then exercises every
 * plan-time-fragile read query shape (sessions / traces / observations,
 * count + rows + metrics) across the filter operators that drive correlated
 * EAV / score / tool subqueries (`any of`, `none of`, `contains`, datetime
 * range, metadata, tags, scores, tool names). Each query must *plan and
 * execute* without error; the discriminating seed lets us also assert the
 * filter actually took effect, so a silently-dropped column (wrong filter
 * name -> no-op filter) fails red instead of passing green.
 *
 * The exact failing case from #55 — a Sessions-list query with a `none of`
 * environment filter, run through `getSessionsTable` (the rows query that
 * builds the `session_tags` CTE) — is asserted explicitly below.
 *
 * Run locally (needs a live GreptimeDB, e.g. `docker compose -f
 * docker-compose.dev.yml up -d greptimedb`):
 *   pnpm --filter web run test src/__tests__/server/greptime-read-path.servertest.ts
 */
import { v4 } from "uuid";
import {
  createObservation,
  createObservationsGreptime,
  createScoresGreptime,
  createSessionScore,
  createTrace,
  createTraceScore,
  createTracesGreptime,
  getObservationsTableCount,
  getObservationsTableWithModelData,
  getSessionsTable,
  getSessionsTableCount,
  getSessionsWithMetrics,
  getTraceIdentifiers,
  getTracesTable,
  getTracesTableCount,
  getTracesTableMetrics,
  type ObservationRecordInsertType,
  type ScoreRecordInsertType,
  type TraceRecordInsertType,
} from "@langfuse/shared/src/server";
import { type FilterState } from "@langfuse/shared";

// A fresh project isolates this suite's data; every read below is project-scoped
// so concurrent servertests writing other projects cannot perturb the counts.
const PROJECT = v4();

// Fixed base timestamp keeps the datetime-range filters deterministic.
const BASE_TS = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const beforeWindow = new Date(BASE_TS - DAY_MS);

const SESS_DEFAULT = v4();
const SESS_STAGING = v4();

const traceA = createTrace({
  id: v4(),
  project_id: PROJECT,
  session_id: SESS_DEFAULT,
  environment: "default",
  user_id: "alice",
  name: "alpha-trace",
  tags: ["prod", "critical"],
  metadata: { source: "API", region: "us" },
  timestamp: BASE_TS,
  event_ts: BASE_TS,
});

const traceB = createTrace({
  id: v4(),
  project_id: PROJECT,
  session_id: SESS_STAGING,
  environment: "staging",
  user_id: "bob",
  name: "beta-trace",
  tags: ["dev"],
  metadata: { source: "SDK", region: "eu" },
  timestamp: BASE_TS + 1_000,
  event_ts: BASE_TS + 1_000,
});

// Deleted trace under the staging session: must be excluded from every read.
const traceDeleted = createTrace({
  id: v4(),
  project_id: PROJECT,
  session_id: SESS_STAGING,
  environment: "staging",
  is_deleted: 1,
  timestamp: BASE_TS + 2_000,
  event_ts: BASE_TS + 2_000,
});

// GENERATION under the default session: carries model + cost + tool EAV rows.
const obsA = createObservation({
  id: v4(),
  trace_id: traceA.id,
  project_id: PROJECT,
  environment: "default",
  type: "GENERATION",
  level: "DEFAULT",
  start_time: BASE_TS,
  end_time: BASE_TS + 3_000,
  tool_definitions: { search: "search the web" },
  tool_calls: ["call-1"],
  tool_call_names: ["search"],
});

// SPAN under the staging session: no model, no cost, ERROR level, distinct
// metadata — lets the model / cost / level / metadata filters discriminate.
const obsB = createObservation({
  id: v4(),
  trace_id: traceB.id,
  project_id: PROJECT,
  environment: "staging",
  type: "SPAN",
  level: "ERROR",
  start_time: BASE_TS + 1_000,
  end_time: BASE_TS + 2_000,
  metadata: { source: "SDK" },
  provided_model_name: "",
  internal_model_id: undefined,
  total_cost: 0,
  cost_details: {},
  usage_details: {},
  provided_cost_details: {},
  provided_usage_details: {},
  tool_definitions: {},
  tool_calls: [],
  tool_call_names: [],
});

const scores: ScoreRecordInsertType[] = [
  // trace-grain numeric + categorical on trace A
  createTraceScore({
    project_id: PROJECT,
    trace_id: traceA.id,
    name: "quality",
    value: 0.9,
    data_type: "NUMERIC",
  }),
  createTraceScore({
    project_id: PROJECT,
    trace_id: traceA.id,
    name: "sentiment",
    value: 0,
    string_value: "positive",
    data_type: "CATEGORICAL",
  }),
  // observation-grain numeric on observation A
  createTraceScore({
    project_id: PROJECT,
    trace_id: traceA.id,
    observation_id: obsA.id,
    name: "obs_quality",
    value: 0.95,
    data_type: "NUMERIC",
  }),
  // session-grain numeric + categorical on the default session
  createSessionScore({
    project_id: PROJECT,
    session_id: SESS_DEFAULT,
    name: "sess_quality",
    value: 8,
    data_type: "NUMERIC",
  }),
  createSessionScore({
    project_id: PROJECT,
    session_id: SESS_DEFAULT,
    name: "sess_sentiment",
    value: 0,
    string_value: "good",
    data_type: "CATEGORICAL",
  }),
];

async function seed() {
  const traces: TraceRecordInsertType[] = [traceA, traceB, traceDeleted];
  const observations: ObservationRecordInsertType[] = [obsA, obsB];
  await createTracesGreptime(traces);
  await createObservationsGreptime(observations);
  await createScoresGreptime(scores);
}

beforeAll(async () => {
  await seed();
}, 60_000);

/**
 * A read query shape paired with a filter. `expected` (when set) is the exact
 * project-scoped row/count cardinality the filter must yield: it guards against
 * a mistyped column silently dropping the filter (which would otherwise return
 * the unfiltered total and pass a bounds-only check). `expected: undefined`
 * means we only assert the query plans and returns a sane shape.
 */
type Case = { label: string; filter: FilterState; expected?: number };

const sessionCases: Case[] = [
  { label: "no filter", filter: [], expected: 2 },
  {
    label: "environment any of [default]",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "any of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    // The exact #55 regression: Sessions-list with a `none of` environment filter.
    label: "environment none of [default] (issue #55)",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "none of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    label: "session id none of [SESS_DEFAULT]",
    filter: [
      {
        type: "stringOptions",
        column: "id",
        operator: "none of",
        value: [SESS_DEFAULT],
      },
    ],
    expected: 1,
  },
  {
    label: "userIds any of [alice]",
    filter: [
      {
        type: "arrayOptions",
        column: "userIds",
        operator: "any of",
        value: ["alice"],
      },
    ],
    expected: 1,
  },
  {
    label: "trace tags any of [prod]",
    filter: [
      {
        type: "arrayOptions",
        column: "traceTags",
        operator: "any of",
        value: ["prod"],
      },
    ],
    expected: 1,
  },
  {
    label: "createdAt datetime range",
    filter: [
      {
        type: "datetime",
        column: "createdAt",
        operator: ">=",
        value: beforeWindow,
      },
    ],
    expected: 2,
  },
  {
    label: "scores_avg sess_quality >= 5",
    filter: [
      {
        type: "numberObject",
        column: "scores_avg",
        key: "sess_quality",
        operator: ">=",
        value: 5,
      },
    ],
    expected: 1,
  },
  {
    label: "score_categories sess_sentiment any of [good]",
    filter: [
      {
        type: "categoryOptions",
        column: "score_categories",
        key: "sess_sentiment",
        operator: "any of",
        value: ["good"],
      },
    ],
    expected: 1,
  },
  {
    label: "session duration > 0",
    filter: [
      { type: "number", column: "sessionDuration", operator: ">", value: 0 },
    ],
  },
];

const traceCases: Case[] = [
  { label: "no filter", filter: [], expected: 2 },
  {
    label: "environment any of [default]",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "any of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    label: "environment none of [default]",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "none of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    label: "metadata source = API",
    filter: [
      {
        type: "stringObject",
        column: "metadata",
        key: "source",
        operator: "=",
        value: "API",
      },
    ],
    expected: 1,
  },
  {
    label: "metadata region contains 'us'",
    filter: [
      {
        type: "stringObject",
        column: "metadata",
        key: "region",
        operator: "contains",
        value: "us",
      },
    ],
    expected: 1,
  },
  {
    label: "tags any of [prod]",
    filter: [
      {
        type: "arrayOptions",
        column: "tags",
        operator: "any of",
        value: ["prod"],
      },
    ],
    expected: 1,
  },
  {
    label: "tags all of [prod, critical]",
    filter: [
      {
        type: "arrayOptions",
        column: "tags",
        operator: "all of",
        value: ["prod", "critical"],
      },
    ],
    expected: 1,
  },
  {
    label: "tags none of [prod]",
    filter: [
      {
        type: "arrayOptions",
        column: "tags",
        operator: "none of",
        value: ["prod"],
      },
    ],
    expected: 1,
  },
  {
    label: "userId contains 'alic'",
    filter: [
      { type: "string", column: "userId", operator: "contains", value: "alic" },
    ],
    expected: 1,
  },
  {
    label: "name any of [alpha-trace]",
    filter: [
      {
        type: "stringOptions",
        column: "traceName",
        operator: "any of",
        value: ["alpha-trace"],
      },
    ],
    expected: 1,
  },
  {
    label: "timestamp datetime range",
    filter: [
      {
        type: "datetime",
        column: "timestamp",
        operator: ">=",
        value: beforeWindow,
      },
    ],
    expected: 2,
  },
  {
    label: "level any of [ERROR] (observation rollup)",
    filter: [
      {
        type: "stringOptions",
        column: "level",
        operator: "any of",
        value: ["ERROR"],
      },
    ],
    expected: 1,
  },
  {
    label: "scores_avg quality >= 0.8",
    filter: [
      {
        type: "numberObject",
        column: "scores_avg",
        key: "quality",
        operator: ">=",
        value: 0.8,
      },
    ],
    expected: 1,
  },
  {
    label: "score_categories sentiment any of [positive]",
    filter: [
      {
        type: "categoryOptions",
        column: "score_categories",
        key: "sentiment",
        operator: "any of",
        value: ["positive"],
      },
    ],
    expected: 1,
  },
  {
    label: "score_categories sentiment none of [positive]",
    filter: [
      {
        type: "categoryOptions",
        column: "score_categories",
        key: "sentiment",
        operator: "none of",
        value: ["positive"],
      },
    ],
    expected: 1,
  },
];

const observationCases: Case[] = [
  { label: "no filter", filter: [], expected: 2 },
  {
    label: "environment any of [default]",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "any of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    label: "environment none of [default]",
    filter: [
      {
        type: "stringOptions",
        column: "environment",
        operator: "none of",
        value: ["default"],
      },
    ],
    expected: 1,
  },
  {
    label: "type any of [GENERATION]",
    filter: [
      {
        type: "stringOptions",
        column: "type",
        operator: "any of",
        value: ["GENERATION"],
      },
    ],
    expected: 1,
  },
  {
    label: "level any of [ERROR]",
    filter: [
      {
        type: "stringOptions",
        column: "level",
        operator: "any of",
        value: ["ERROR"],
      },
    ],
    expected: 1,
  },
  {
    label: "model any of [gpt-3.5-turbo]",
    filter: [
      {
        type: "stringOptions",
        column: "model",
        operator: "any of",
        value: ["gpt-3.5-turbo"],
      },
    ],
    expected: 1,
  },
  {
    label: "metadata source = API",
    filter: [
      {
        type: "stringObject",
        column: "metadata",
        key: "source",
        operator: "=",
        value: "API",
      },
    ],
    expected: 1,
  },
  {
    label: "total cost > 0",
    filter: [{ type: "number", column: "totalCost", operator: ">", value: 0 }],
    expected: 1,
  },
  {
    label: "startTime datetime range",
    filter: [
      {
        type: "datetime",
        column: "startTime",
        operator: ">=",
        value: beforeWindow,
      },
    ],
    expected: 2,
  },
  {
    label: "available tool names any of [search]",
    filter: [
      {
        type: "arrayOptions",
        column: "toolNames",
        operator: "any of",
        value: ["search"],
      },
    ],
    expected: 1,
  },
  {
    label: "called tool names any of [search]",
    filter: [
      {
        type: "arrayOptions",
        column: "calledToolNames",
        operator: "any of",
        value: ["search"],
      },
    ],
    expected: 1,
  },
  {
    label: "trace tags any of [prod]",
    filter: [
      {
        type: "arrayOptions",
        column: "tags",
        operator: "any of",
        value: ["prod"],
      },
    ],
    expected: 1,
  },
  {
    label: "scores_avg obs_quality >= 0.8 (observation grain)",
    filter: [
      {
        type: "numberObject",
        column: "scores_avg",
        key: "obs_quality",
        operator: ">=",
        value: 0.8,
      },
    ],
    expected: 1,
  },
];

describe("GreptimeDB read path — plan-time integration gate (issue #55)", () => {
  describe("sessions UI table", () => {
    it.each(sessionCases)(
      "plans + executes count/rows/metrics with filter: $label",
      async ({ filter, expected }) => {
        const count = await getSessionsTableCount({
          projectId: PROJECT,
          filter,
        });
        const rows = await getSessionsTable({
          projectId: PROJECT,
          filter,
          orderBy: { column: "createdAt", order: "DESC" },
          limit: 50,
          page: 0,
        });
        const metrics = await getSessionsWithMetrics({
          projectId: PROJECT,
          filter,
          orderBy: { column: "createdAt", order: "DESC" },
          limit: 50,
          page: 0,
        });

        expect(typeof count).toBe("number");
        expect(Array.isArray(rows)).toBe(true);
        expect(Array.isArray(metrics)).toBe(true);
        // rows reflect the same filter as count (both bounded by it)
        expect(rows.length).toBe(count);
        expect(metrics.length).toBe(count);
        if (expected !== undefined) {
          expect(count).toBe(expected);
        }
      },
    );

    it("returns the staging session (and only it) for a `none of` environment filter [issue #55]", async () => {
      const rows = await getSessionsTable({
        projectId: PROJECT,
        filter: [
          {
            type: "stringOptions",
            column: "environment",
            operator: "none of",
            value: ["default"],
          },
        ],
        orderBy: { column: "createdAt", order: "DESC" },
        limit: 50,
        page: 0,
      });
      expect(rows.map((r) => r.session_id)).toEqual([SESS_STAGING]);
    });

    it("environment any-of + none-of partition the total", async () => {
      const total = await getSessionsTableCount({
        projectId: PROJECT,
        filter: [],
      });
      const anyOf = await getSessionsTableCount({
        projectId: PROJECT,
        filter: [
          {
            type: "stringOptions",
            column: "environment",
            operator: "any of",
            value: ["default"],
          },
        ],
      });
      const noneOf = await getSessionsTableCount({
        projectId: PROJECT,
        filter: [
          {
            type: "stringOptions",
            column: "environment",
            operator: "none of",
            value: ["default"],
          },
        ],
      });
      expect(anyOf + noneOf).toBe(total);
    });

    it("joins trace tags through the session_tags EAV CTE", async () => {
      const rows = await getSessionsTable({
        projectId: PROJECT,
        filter: [
          {
            type: "stringOptions",
            column: "id",
            operator: "any of",
            value: [SESS_DEFAULT],
          },
        ],
        orderBy: { column: "createdAt", order: "DESC" },
        limit: 50,
        page: 0,
      });
      expect(rows).toHaveLength(1);
      expect([...rows[0].trace_tags].sort()).toEqual(["critical", "prod"]);
    });
  });

  describe("traces UI table", () => {
    it.each(traceCases)(
      "plans + executes count/rows/metrics/identifiers with filter: $label",
      async ({ filter, expected }) => {
        const count = await getTracesTableCount({
          projectId: PROJECT,
          filter,
          searchType: [],
        });
        const rows = await getTracesTable({
          projectId: PROJECT,
          filter,
          searchType: [],
          orderBy: { column: "timestamp", order: "DESC" },
          limit: 50,
          page: 0,
        });
        const metrics = await getTracesTableMetrics({
          projectId: PROJECT,
          filter,
          orderBy: { column: "timestamp", order: "DESC" },
          limit: 50,
          page: 0,
        });
        const identifiers = await getTraceIdentifiers({
          projectId: PROJECT,
          filter,
          orderBy: { column: "timestamp", order: "DESC" },
          limit: 50,
          page: 0,
        });

        expect(typeof count).toBe("number");
        expect(Array.isArray(rows)).toBe(true);
        expect(Array.isArray(metrics)).toBe(true);
        expect(Array.isArray(identifiers)).toBe(true);
        expect(rows.length).toBe(count);
        expect(identifiers.length).toBe(count);
        // metrics is keyed off the same row page
        expect(metrics.length).toBe(rows.length);
        if (expected !== undefined) {
          expect(count).toBe(expected);
        }
      },
    );

    it("excludes deleted traces", async () => {
      const ids = await getTraceIdentifiers({
        projectId: PROJECT,
        filter: [],
        orderBy: { column: "timestamp", order: "DESC" },
        limit: 50,
        page: 0,
      });
      expect(ids.map((r) => r.id).sort()).toEqual(
        [traceA.id, traceB.id].sort(),
      );
    });
  });

  describe("observations UI table", () => {
    it.each(observationCases)(
      "plans + executes count/rows with filter: $label",
      async ({ filter, expected }) => {
        const count = await getObservationsTableCount({
          projectId: PROJECT,
          filter,
        });
        const rows = await getObservationsTableWithModelData({
          projectId: PROJECT,
          filter,
          orderBy: { column: "startTime", order: "DESC" },
          limit: 50,
          offset: 0,
          selectIOAndMetadata: false,
        });

        expect(typeof count).toBe("number");
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBe(count);
        if (expected !== undefined) {
          expect(count).toBe(expected);
        }
      },
    );

    it("returns IO + metadata when selectIOAndMetadata is set", async () => {
      const rows = await getObservationsTableWithModelData({
        projectId: PROJECT,
        filter: [
          {
            type: "stringOptions",
            column: "type",
            operator: "any of",
            value: ["GENERATION"],
          },
        ],
        orderBy: { column: "startTime", order: "DESC" },
        limit: 50,
        offset: 0,
        selectIOAndMetadata: true,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(obsA.id);
    });
  });
});
