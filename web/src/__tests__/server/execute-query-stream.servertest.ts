import { v4 } from "uuid";
import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import {
  createOrgProjectAndApiKey,
  createTrace,
  createTracesGreptime,
  type TraceRecordInsertType,
} from "@langfuse/shared/src/server";
import handler from "../../pages/api/dashboard/execute-query-stream";

// --- Auth mock (only thing we need to mock — no real session in tests) ---

const mockGetServerAuthSession = vi.fn();
vi.mock("../../server/auth", () => ({
  getServerAuthSession: (...args: unknown[]) =>
    mockGetServerAuthSession(...args),
}));

// Admin webhook — not relevant to streaming logic, just suppress side-effects
const mockSendAdminAccessWebhook = vi.fn();
vi.mock("../../server/adminAccessWebhook", () => ({
  sendAdminAccessWebhook: (...args: unknown[]) =>
    mockSendAdminAccessWebhook(...args),
}));

// --- Helpers ---

function createPostMocks(body: unknown) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: "POST",
    body,
  });
  // node-mocks-http doesn't implement flushHeaders
  res.flushHeaders = vi.fn();
  return { req, res };
}

// --- Test setup ---

describe("execute-query-stream handler", () => {
  let projectId: string;
  let orgId: string;
  let fromTimestamp: string;
  let toTimestamp: string;

  beforeAll(async () => {
    const org = await createOrgProjectAndApiKey();
    projectId = org.projectId;
    orgId = org.orgId;

    const baseTime = new Date("2024-06-15T12:00:00Z").getTime();
    const TRACE_COUNT = 5;

    const traces: TraceRecordInsertType[] = [];
    for (let i = 0; i < TRACE_COUNT; i++) {
      traces.push(
        createTrace({
          id: v4(),
          project_id: projectId,
          name: `test-trace-${i}`,
          timestamp: baseTime + i * 60_000,
          environment: "default",
          tags: [],
          metadata: {},
          created_at: baseTime + i * 60_000,
          updated_at: baseTime + i * 60_000,
          event_ts: baseTime + i * 60_000,
        }),
      );
    }

    await createTracesGreptime(traces);

    fromTimestamp = new Date(baseTime - 60 * 60 * 1000).toISOString();
    toTimestamp = new Date(baseTime + 60 * 60 * 1000).toISOString();
  });

  function makeSession(overrides?: {
    admin?: boolean;
    projects?: Array<{ id: string }>;
  }) {
    return {
      user: {
        id: "user-1",
        email: "test@example.com",
        admin: overrides?.admin ?? false,
        organizations: [
          {
            id: orgId,
            projects: overrides?.projects ?? [{ id: projectId }],
          },
        ],
      },
    };
  }

  function makeBody(queryOverrides?: Record<string, unknown>) {
    return {
      projectId,
      query: {
        view: "traces" as const,
        dimensions: [],
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [],
        timeDimension: null,
        fromTimestamp,
        toTimestamp,
        orderBy: null,
        ...queryOverrides,
      },
    };
  }

  it("should return 400 because streaming dashboard queries are no longer supported", async () => {
    mockGetServerAuthSession.mockResolvedValue(makeSession());
    const { req, res } = createPostMocks(makeBody());

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toMatchObject({
      message: "Streaming is only supported for v4-enabled dashboard queries",
    });
  });

  // --- Auth tests (mocks are appropriate here) ---

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(405);
  });

  it("should return 401 when no session", async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    const { req, res } = createPostMocks(makeBody());

    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(JSON.parse(res._getData())).toMatchObject({
      message: "Unauthorized",
    });
  });

  it("should return 403 when user is not a project member", async () => {
    mockGetServerAuthSession.mockResolvedValue(
      makeSession({ projects: [{ id: "other-project" }] }),
    );
    const { req, res } = createPostMocks(makeBody());

    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(JSON.parse(res._getData())).toMatchObject({
      message: "Not a member of this project",
    });
  });

  it("should return 400 for invalid input", async () => {
    mockGetServerAuthSession.mockResolvedValue(makeSession());
    const { req, res } = createPostMocks({ projectId: 123 });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getData())).toMatchObject({
      message: "Invalid input",
    });
  });

  it("should return 404 when admin accesses non-existent project", async () => {
    mockGetServerAuthSession.mockResolvedValue(
      makeSession({ admin: true, projects: [] }),
    );
    const { req, res } = createPostMocks({
      ...makeBody(),
      projectId: v4(), // random non-existent project
    });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getData())).toMatchObject({
      message: "Project not found",
    });
  });

  it("should allow admin access to project they are not a member of and send webhook", async () => {
    mockGetServerAuthSession.mockResolvedValue(
      makeSession({ admin: true, projects: [] }),
    );
    const { req, res } = createPostMocks(makeBody());

    await handler(req, res);

    expect(mockSendAdminAccessWebhook).toHaveBeenCalledWith({
      email: "test@example.com",
      projectId,
      orgId,
    });
  });
});
