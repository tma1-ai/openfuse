import {
  createObservation as createObservationObject,
  createTrace,
} from "@langfuse/shared/src/server";
import {
  createObservationsGreptime as createObservationsInClickhouse,
  createTracesGreptime,
} from "@langfuse/shared/src/server";
import { v4 as uuidv4 } from "uuid";
import { getUserMetrics } from "@langfuse/shared/src/server";

describe("getUserMetrics function", () => {
  it("should return correct user metrics for a trace with two observations", async () => {
    const projectId = uuidv4();
    const userId = uuidv4();
    const traceId = uuidv4();

    const trace = createTrace({
      id: traceId,
      project_id: projectId,
      user_id: userId,
    });

    await createTracesGreptime([trace]);

    const observation1 = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      usage_details: {
        input: 100,
        output: 200,
        total: 300,
      },
      total_cost: 50,
      type: "GENERATION",
    });

    const observation2 = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      usage_details: {
        input: 150,
        output: 250,
        total: 400,
      },
      total_cost: 75,
      type: "GENERATION",
    });

    await createObservationsInClickhouse([observation1, observation2]);

    const userMetrics = await getUserMetrics(projectId, [userId], []);

    expect(userMetrics.length).toBe(1);
    expect(userMetrics[0]).toMatchObject({
      userId: userId,
      inputUsage: 250, // 100 + 150
      outputUsage: 450, // 200 + 250
      totalUsage: 700, // 300 + 400
      observationCount: 2,
      traceCount: 1,
      totalCost: 125, // 50 + 75
    });
  });

  it("should return correct user metrics for a trace with two observations and timestamp filter", async () => {
    const projectId = uuidv4();
    const userId = uuidv4();
    const traceId = uuidv4();

    const trace = createTrace({
      id: traceId,
      project_id: projectId,
      user_id: userId,
    });

    await createTracesGreptime([trace]);

    const observation1 = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      usage_details: {
        input: 100,
        output: 200,
        total: 300,
      },
      total_cost: 50,
      type: "GENERATION",
    });

    const observation2 = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      usage_details: {
        input: 150,
        output: 250,
        total: 400,
      },
      total_cost: 75,
      type: "GENERATION",
    });

    await createObservationsInClickhouse([observation1, observation2]);

    const userMetrics = await getUserMetrics(
      projectId,
      [userId],
      [
        {
          column: "timestamp",
          type: "datetime",
          operator: ">=",
          value: new Date(new Date().getTime() - 1000),
        },
      ],
    );

    expect(userMetrics.length).toBe(1);
    expect(userMetrics[0]).toMatchObject({
      userId: userId,
      inputUsage: 250, // 100 + 150
      outputUsage: 450, // 200 + 250
      totalUsage: 700, // 300 + 400
      observationCount: 2,
      traceCount: 1,
      totalCost: 125, // 50 + 75
    });
  });

  // Documents the DELIBERATE lookback-bounded narrowing of the all-time (no-filter) metrics path: with
  // no UI timestamp bound we derive an observations start_time lower bound of `min(trace.timestamp) -
  // 2 DAY` so the observations scan can prune via the TIME INDEX (see deriveTraceMinTimestamp). An
  // observation that starts more than the lookback before its trace is intentionally dropped. This is
  // the same heuristic the windowed path already applies; for sane data (observation at/after its
  // trace) the dropped set is empty, as the two tests above show.
  it("drops observations starting more than the lookback before the trace (all-time path)", async () => {
    const projectId = uuidv4();
    const userId = uuidv4();
    const traceId = uuidv4();
    const now = Date.now();
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

    const trace = createTrace({
      id: traceId,
      project_id: projectId,
      user_id: userId,
      timestamp: now,
    });
    await createTracesGreptime([trace]);

    const inWindow = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      start_time: now,
      usage_details: { input: 100, output: 200, total: 300 },
      total_cost: 50,
      type: "GENERATION",
    });
    // Starts 3 days before the trace -> beyond the 2 DAY lookback -> intentionally excluded.
    const outOfWindow = createObservationObject({
      id: uuidv4(),
      trace_id: traceId,
      project_id: projectId,
      start_time: now - THREE_DAYS_MS,
      usage_details: { input: 999, output: 999, total: 999 },
      total_cost: 999,
      type: "GENERATION",
    });
    await createObservationsInClickhouse([inWindow, outOfWindow]);

    const userMetrics = await getUserMetrics(projectId, [userId], []);

    expect(userMetrics.length).toBe(1);
    expect(userMetrics[0]).toMatchObject({
      userId,
      observationCount: 1, // only the in-window observation
      traceCount: 1,
      inputUsage: 100,
      outputUsage: 200,
      totalUsage: 300,
      totalCost: 50,
    });
  });
});
