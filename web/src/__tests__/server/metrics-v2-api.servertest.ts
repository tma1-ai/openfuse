import { randomUUID } from "crypto";
import {
  makeZodVerifiedAPICall,
  makeZodVerifiedAPICallSilent,
} from "@/src/__tests__/test-utils";
import { GetMetricsV2Response } from "@/src/features/public-api/types/metrics";
import {
  createTrace,
  createObservation,
  createTracesGreptime,
  createObservationsGreptime,
} from "@langfuse/shared/src/server";

/**
 * Smoke coverage for the now-always-on GET /api/public/v2/metrics endpoint.
 * The endpoint is backed by executeQuery against the GreptimeDB projection.
 * v2 excludes the "traces" view, so we exercise the "observations" view.
 */
describe("/api/public/v2/metrics API Endpoint", () => {
  const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";
  const testMetadataValue = randomUUID();

  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 3600 * 24 * 2 * 1000);
  const tomorrow = new Date(now.getTime() + 3600 * 24 * 1000);

  const observationName = `v2-smoke-${randomUUID()}`;

  beforeAll(async () => {
    const traceId = randomUUID();
    await createTracesGreptime([
      createTrace({
        id: traceId,
        name: "v2-smoke-trace",
        project_id: projectId,
        timestamp: now.getTime(),
        metadata: { test: testMetadataValue },
      }),
    ]);

    const observations = Array.from({ length: 3 }, () =>
      createObservation({
        id: randomUUID(),
        trace_id: traceId,
        project_id: projectId,
        name: observationName,
        start_time: now.getTime(),
        total_cost: 0.25,
        metadata: { test: testMetadataValue },
      }),
    );
    await createObservationsGreptime(observations);
  });

  it("returns sane aggregates for an observations query", async () => {
    const query = {
      view: "observations",
      dimensions: [{ field: "name" }],
      metrics: [
        { measure: "count", aggregation: "count" },
        { measure: "totalCost", aggregation: "sum" },
      ],
      filters: [
        {
          column: "metadata",
          operator: "contains",
          key: "test",
          value: testMetadataValue,
          type: "stringObject",
        },
      ],
      timeDimension: null,
      fromTimestamp: twoDaysAgo.toISOString(),
      toTimestamp: tomorrow.toISOString(),
      orderBy: null,
    };

    const response = await makeZodVerifiedAPICall(
      GetMetricsV2Response,
      "GET",
      `/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);

    const row = response.body.data.find(
      (item) => item.name === observationName,
    );
    expect(row).toBeDefined();
    expect(Number(row!.count_count)).toBe(3);
    expect(Number(row!.sum_totalCost)).toBeCloseTo(0.75, 5);
  });

  it("rejects the v2-unsupported 'traces' view with 400", async () => {
    const query = {
      view: "traces",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "count", aggregation: "count" }],
      fromTimestamp: twoDaysAgo.toISOString(),
      toTimestamp: tomorrow.toISOString(),
    };

    const { status } = await makeZodVerifiedAPICallSilent(
      GetMetricsV2Response,
      "GET",
      `/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(query))}`,
      undefined,
    );

    expect(status).toBe(400);
  });
});
