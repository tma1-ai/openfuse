import { v4 } from "uuid";
import { prisma } from "@langfuse/shared/src/db";
import {
  createObservation,
  createObservationsGreptime,
  createOrgProjectAndApiKey,
  createScoresGreptime,
  createSessionScore,
  createTracesGreptime,
  getSessionsWithMetrics,
  getSessionsWithMetricsFromEvents,
  getSessionMetricsFromEvents,
  getSessionsTable,
  getSessionsTableFromEvents,
  type TraceRecordInsertType,
  type ObservationRecordInsertType,
} from "@langfuse/shared/src/server";
import { createTrace } from "@langfuse/shared/src/server";
import { type FilterState } from "@langfuse/shared";
import { env } from "@/src/env.mjs";

const isEventsPath = env.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN === "true";

// Pick the right listing function based on env flag
const sessionsTable = isEventsPath
  ? getSessionsTableFromEvents
  : getSessionsTable;

// Adapter for metrics: legacy takes filter/orderBy, events-based takes sessionIds
async function sessionsWithMetrics(props: {
  projectId: string;
  filter: FilterState;
}) {
  if (!isEventsPath) {
    return getSessionsWithMetrics(props);
  }
  const idFilter = props.filter.find(
    (f): f is Extract<FilterState[number], { column: "id" }> =>
      f.column === "id",
  );
  const sessionIds =
    idFilter && "value" in idFilter ? (idFilter.value as string[]) : [];
  return getSessionMetricsFromEvents({
    projectId: props.projectId,
    sessionIds,
  });
}

/**
 * Seed both legacy tables (traces + observations) and events table.
 * This ensures the same test data is available for both code paths.
 */
async function seedSessionData(
  traces: TraceRecordInsertType[],
  observations?: ObservationRecordInsertType[],
) {
  await createTracesGreptime(traces);
  if (observations?.length) await createObservationsGreptime(observations);
}

describe("trpc.sessions", () => {
  describe("GET sessions.all", () => {
    it("should GET all session", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      const sessionId = v4();

      await prisma.traceSession.create({
        data: {
          id: sessionId,
          projectId: projectId,
        },
      });

      const traces = [
        createTrace({ session_id: sessionId, project_id: projectId }),
        createTrace({ session_id: sessionId, project_id: projectId }),
      ];

      await seedSessionData(traces);

      const uiSessions = await sessionsTable({
        projectId: projectId,
        filter: [],
        orderBy: null,
        limit: 10000,
        page: 0,
      });

      expect(uiSessions.length).toBe(1);
      expect(uiSessions[0].session_id).toBe(sessionId);
      expect(uiSessions[0].trace_count).toBe(2);
      expect(uiSessions[0].trace_tags).toEqual(["doe", "john"]);
    });
  });

  it("should GET all session filtered by trace attribute only", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId = v4();

    await prisma.traceSession.create({
      data: {
        id: sessionId,
        projectId: projectId,
      },
    });

    const traces = [
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: "user1",
      }),
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: undefined,
      }),
    ];

    await seedSessionData(traces);

    const uiSessions = await sessionsTable({
      projectId: projectId,
      filter: [
        {
          column: "userIds",
          type: "stringOptions",
          operator: "any of",
          value: ["user1"],
        },
      ],
      orderBy: null,
      limit: 10000,
      page: 0,
    });

    expect(uiSessions.length).toBe(1);
    expect(uiSessions[0].session_id).toBe(sessionId);
    expect(uiSessions[0].trace_count).toBe(2);
    expect(uiSessions[0].trace_tags).toEqual(["doe", "john"]);
    expect(uiSessions[0].user_ids).toEqual(["user1"]);
  });

  it("LFE-10268: should GET sessions filtered by session id with 'none of' operator", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const excludedSessionId = v4();
    const keptSessionId = v4();

    await prisma.traceSession.createMany({
      data: [
        { id: excludedSessionId, projectId },
        { id: keptSessionId, projectId },
      ],
    });

    const traces = [
      createTrace({ session_id: excludedSessionId, project_id: projectId }),
      createTrace({ session_id: keptSessionId, project_id: projectId }),
    ];

    await seedSessionData(traces);

    const uiSessions = await sessionsTable({
      projectId: projectId,
      filter: [
        {
          column: "id",
          type: "stringOptions",
          operator: "none of",
          value: [excludedSessionId],
        },
      ],
      orderBy: null,
      limit: 10000,
      page: 0,
    });

    expect(uiSessions.length).toBe(1);
    expect(uiSessions[0].session_id).toBe(keptSessionId);
  });

  it("should GET sessions ordered by total cost", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId1 = v4();
    const sessionId2 = v4();

    await prisma.traceSession.createMany({
      data: [
        {
          id: sessionId1,
          projectId: projectId,
        },
        {
          id: sessionId2,
          projectId: projectId,
        },
      ],
    });

    const traces = [
      createTrace({
        session_id: sessionId1,
        project_id: projectId,
      }),
      createTrace({
        session_id: sessionId2,
        project_id: projectId,
      }),
    ];

    const observations = [
      createObservation({
        trace_id: traces[0].id,
        project_id: projectId,
        cost_details: {
          input: 0.1,
          output: 0.2,
          total: 0.3,
        },
        total_cost: 0.3,
      }),
      createObservation({
        trace_id: traces[1].id,
        project_id: projectId,
        cost_details: {
          input: 0.3,
          output: 0.4,
          total: 0.7,
        },
        total_cost: 0.7,
      }),
    ];

    await seedSessionData(traces, observations);

    const uiSessions = await sessionsTable({
      projectId: projectId,
      filter: [],
      orderBy: {
        column: "totalCost",
        order: "DESC" as const,
      },
      limit: 10000,
      page: 0,
    });

    expect(uiSessions.length).toBe(2);
    expect(uiSessions[0].session_id).toBe(sessionId2);
    expect(uiSessions[1].session_id).toBe(sessionId1);
  });

  it("should GET sessions ordered by duration", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId1 = v4();
    const sessionId2 = v4();

    await prisma.traceSession.createMany({
      data: [
        {
          id: sessionId1,
          projectId: projectId,
        },
        {
          id: sessionId2,
          projectId: projectId,
        },
      ],
    });

    const traces = [
      createTrace({
        session_id: sessionId1,
        project_id: projectId,
        timestamp: new Date("2024-01-01T00:00:00Z").getTime(),
      }),
      createTrace({
        session_id: sessionId2,
        project_id: projectId,
        timestamp: new Date("2024-01-01T00:00:00Z").getTime(),
      }),
    ];
    const observations = [
      createObservation({
        trace_id: traces[0].id,
        project_id: projectId,
        start_time: new Date("2024-01-01T00:00:00Z").getTime(),
        end_time: new Date("2024-01-01T00:00:10Z").getTime(), // 10 second duration
      }),
      createObservation({
        trace_id: traces[1].id,
        project_id: projectId,
        start_time: new Date("2024-01-01T00:00:00Z").getTime(),
        end_time: new Date("2024-01-01T00:00:20Z").getTime(), // 20 second duration
      }),
    ];

    await seedSessionData(traces, observations);

    const uiSessions = await sessionsTable({
      projectId: projectId,
      filter: [],
      orderBy: {
        column: "sessionDuration",
        order: "DESC" as const,
      },
      limit: 10000,
      page: 0,
    });

    expect(uiSessions.length).toBe(2);
    expect(uiSessions[0].session_id).toBe(sessionId2);
    expect(uiSessions[1].session_id).toBe(sessionId1);
  });

  it("should GET metrics for a list of sessions", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId1 = v4();
    const sessionId2 = v4();

    await prisma.traceSession.createMany({
      data: [
        {
          id: sessionId1,
          projectId: projectId,
        },
        {
          id: sessionId2,
          projectId: projectId,
        },
      ],
    });

    const traces = [
      createTrace({
        session_id: sessionId1,
        project_id: projectId,
        user_id: "user1",
      }),
      createTrace({
        session_id: sessionId1,
        project_id: projectId,
        user_id: "user2",
      }),
      createTrace({
        session_id: sessionId2,
        project_id: projectId,
        user_id: "user3",
      }),
    ];

    const observations = traces.flatMap((trace) => [
      createObservation({
        trace_id: trace.id,
        project_id: projectId,
      }),
      createObservation({
        trace_id: trace.id,
        project_id: projectId,
      }),
    ]);

    await seedSessionData(traces, observations);

    const sessions = await sessionsWithMetrics({
      projectId: projectId,
      filter: [
        {
          column: "id",
          type: "stringOptions",
          operator: "any of",
          value: [sessionId1, sessionId2],
        },
      ],
    });

    expect(sessions.length).toBe(2);

    // Session 1 checks
    const session1 = sessions.find((s) => s.session_id === sessionId1);
    expect(session1).toBeDefined();
    expect(session1?.trace_count).toBe(2);
    expect(session1?.user_ids).toEqual(
      expect.arrayContaining(["user1", "user2"]),
    );
    expect(session1?.trace_tags).toEqual(["doe", "john"]);
    expect(session1?.total_observations).toEqual(4);

    expect(Number(session1?.session_input_cost)).toBeGreaterThan(0);
    expect(Number(session1?.session_output_cost)).toBeGreaterThan(0);
    expect(Number(session1?.session_total_cost)).toBeGreaterThan(0);
    expect(Number(session1?.session_input_usage)).toBeGreaterThan(0);
    expect(Number(session1?.session_output_usage)).toBeGreaterThan(0);
    expect(Number(session1?.session_total_usage)).toBeGreaterThan(0);

    // Session 2 checks
    const session2 = sessions.find((s) => s.session_id === sessionId2);
    expect(session2).toBeDefined();
    expect(session2?.trace_count).toBe(1);
    expect(session2?.user_ids).toEqual(["user3"]);
    expect(session2?.trace_tags).toEqual(["doe", "john"]);
    expect(session2?.total_observations).toEqual(2);

    expect(Number(session2?.session_input_cost)).toBeGreaterThan(0);
    expect(Number(session2?.session_output_cost)).toBeGreaterThan(0);
    expect(Number(session2?.session_total_cost)).toBeGreaterThan(0);
    expect(Number(session2?.session_input_usage)).toBeGreaterThan(0);
    expect(Number(session2?.session_output_usage)).toBeGreaterThan(0);
    expect(Number(session2?.session_total_usage)).toBeGreaterThan(0);
  });

  it("LFE-4113: should GET correct metrics for a list of sessions without observations", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId = v4();

    await prisma.traceSession.createMany({
      data: [
        {
          id: sessionId,
          projectId: projectId,
        },
      ],
    });

    const traces = [
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: "user1",
      }),
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: "user3",
      }),
    ];

    // Only trace 2 has observations
    const observations = [
      createObservation({
        trace_id: traces[1].id,
        project_id: projectId,
        start_time: new Date().getTime() - 1000,
      }),
      createObservation({
        trace_id: traces[1].id,
        project_id: projectId,
        start_time: new Date().getTime(),
      }),
    ];

    await seedSessionData(traces, observations);

    const sessions = await sessionsWithMetrics({
      projectId: projectId,
      filter: [
        {
          column: "id",
          type: "stringOptions",
          operator: "any of",
          value: [sessionId],
        },
      ],
    });

    expect(sessions.length).toBe(1);

    expect(sessions[0]).toBeDefined();
    expect(sessions[0]?.trace_count).toBe(2);
    expect(parseInt(sessions[0]?.duration as any)).toBe(1);
  });

  it("should GET correct session data with filters", async () => {
    const project_id = v4();
    const trace_id_with_score = v4();
    const session_id_with_score = v4();
    const trace_id_without_score = v4();
    const session_id_without_score = v4();

    const filterState: FilterState = [
      {
        type: "numberObject",
        column: "Scores (numeric)",
        key: "test",
        operator: ">",
        value: 0,
      },
    ];

    const trace_with_score = createTrace({
      id: trace_id_with_score,
      project_id,
      session_id: session_id_with_score,
    });
    const trace_without_score = createTrace({
      id: trace_id_without_score,
      project_id,
      session_id: session_id_without_score,
    });
    await seedSessionData([trace_with_score, trace_without_score]);

    const score = createSessionScore({
      project_id,
      session_id: session_id_with_score,
      name: "test",
      value: 1,
      data_type: "NUMERIC",
    });
    await createScoresGreptime([score]);

    const tableRows = await sessionsTable({
      projectId: project_id,
      filter: filterState,
      limit: 10,
      page: 0,
    });

    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].session_id).toEqual(session_id_with_score);
  });
});

// The events tables only exist where the v4 preview is enabled (CI creates
// them via ch:dev-tables in the default deploy mode only).
const maybeEventsTable = isEventsPath ? describe : describe.skip;

maybeEventsTable("parity: sessions metrics from events vs legacy", () => {
  it("returns equivalent metric fields for the same session data", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const sessionId = v4();

    await prisma.traceSession.create({
      data: { id: sessionId, projectId },
    });

    const traces = [
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: "user1",
      }),
      createTrace({
        session_id: sessionId,
        project_id: projectId,
        user_id: "user2",
      }),
    ];

    const observations = traces.flatMap((trace) => [
      createObservation({ trace_id: trace.id, project_id: projectId }),
      createObservation({ trace_id: trace.id, project_id: projectId }),
    ]);

    // Seed legacy path (sessions materialized view) and events table in parallel
    await createTracesGreptime(traces);
    await createObservationsGreptime(observations);

    const filter: FilterState = [];

    const [legacy, fromEvents] = await Promise.all([
      getSessionsWithMetrics({ projectId, filter }),
      getSessionsWithMetricsFromEvents({ projectId, filter }),
    ]);

    expect(legacy).toHaveLength(1);
    expect(fromEvents).toHaveLength(1);

    const l = legacy[0];
    const e = fromEvents[0];

    expect(e.session_id).toBe(l.session_id);
    expect(e.trace_count).toBe(l.trace_count);
    expect([...e.trace_ids].sort()).toEqual([...l.trace_ids].sort());
    expect([...e.user_ids].sort()).toEqual([...l.user_ids].sort());
    expect(e.total_observations).toBe(l.total_observations);

    // Export-critical cost/usage fields (getDatabaseReadStream maps these directly)
    expect(Number(e.session_input_cost)).toBeCloseTo(
      Number(l.session_input_cost),
      4,
    );
    expect(Number(e.session_output_cost)).toBeCloseTo(
      Number(l.session_output_cost),
      4,
    );
    expect(Number(e.session_total_cost)).toBeCloseTo(
      Number(l.session_total_cost),
      4,
    );
    expect(Number(e.session_input_usage)).toBeCloseTo(
      Number(l.session_input_usage),
      0,
    );
    expect(Number(e.session_output_usage)).toBeCloseTo(
      Number(l.session_output_usage),
      0,
    );
    expect(Number(e.session_total_usage)).toBeCloseTo(
      Number(l.session_total_usage),
      0,
    );
  });

  it("honours the same filter so only the targeted session is returned", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    const targetId = v4();
    const otherId = v4();

    await prisma.traceSession.createMany({
      data: [
        { id: targetId, projectId },
        { id: otherId, projectId },
      ],
    });

    const traces = [
      createTrace({ session_id: targetId, project_id: projectId }),
      createTrace({ session_id: otherId, project_id: projectId }),
    ];

    await createTracesGreptime(traces);

    const filter: FilterState = [
      {
        column: "id",
        type: "stringOptions",
        operator: "any of",
        value: [targetId],
      },
    ];

    const [legacy, fromEvents] = await Promise.all([
      getSessionsWithMetrics({ projectId, filter }),
      getSessionsWithMetricsFromEvents({ projectId, filter }),
    ]);

    expect(legacy).toHaveLength(1);
    expect(fromEvents).toHaveLength(1);
    expect(legacy[0].session_id).toBe(targetId);
    expect(fromEvents[0].session_id).toBe(targetId);
  });
});
