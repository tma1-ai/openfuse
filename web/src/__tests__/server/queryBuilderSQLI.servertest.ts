import { randomUUID } from "crypto";
import { executeQuery } from "@langfuse/shared/query/server";
import { type QueryType } from "@langfuse/shared/query";
import { InvalidRequestError } from "@langfuse/shared";

/**
 * SQL injection protection at the dashboard `executeQuery` boundary.
 *
 * The per-builder injection unit tests previously asserted on the SQL emitted by
 * the (now removed) ClickHouse `QueryBuilder`. The live GreptimeDB query path is
 * exercised here end-to-end via `executeQuery`; builder-level injection coverage
 * belongs to the GreptimeDB query-builder tests.
 */
describe("executeQuery SQL Injection Tests", () => {
  const projectId = randomUUID();

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600000);
  const defaultFromTime = threeDaysAgo.toISOString();
  const defaultToTime = now.toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should safely handle malicious query parameters through executeQuery", async () => {
    // Ensures SQL injection protection holds end-to-end through the dashboard
    // executeQuery path rather than allowing the injection to reach the database.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const maliciousQuery: QueryType = {
      view: "traces",
      dimensions: [],
      metrics: [
        {
          measure: "count); DELETE FROM traces; --" as any,
          aggregation: "count",
        },
      ],
      filters: [],
      timeDimension: null,
      fromTimestamp: defaultFromTime,
      toTimestamp: defaultToTime,
      orderBy: null,
    };

    await expect(executeQuery(projectId, maliciousQuery)).rejects.toThrow(
      InvalidRequestError,
    );
  });
});
