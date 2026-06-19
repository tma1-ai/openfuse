import { LangfuseNotFoundError, UnauthorizedError } from "@langfuse/shared";
import { env } from "@langfuse/shared/src/env";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import {
  buildTraceExport,
  TraceDownloadTooLargeError,
  type TraceExportSession,
} from "@/src/features/traces/server/buildTraceExport";

const {
  mockGetTraceById,
  mockGetObservationsForTrace,
  mockGetObservationCountForTrace,
  mockGetScoresAndCorrectionsForTraces,
  mockTraceSessionFindFirst,
  mockProjectFindFirst,
  mockSendAdminAccessWebhook,
} = vi.hoisted(() => ({
  mockGetTraceById: vi.fn(),
  mockGetObservationsForTrace: vi.fn(),
  mockGetObservationCountForTrace: vi.fn(),
  mockGetScoresAndCorrectionsForTraces: vi.fn(),
  mockTraceSessionFindFirst: vi.fn(),
  mockProjectFindFirst: vi.fn(),
  mockSendAdminAccessWebhook: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async () => ({
  ...(await vi.importActual("@langfuse/shared/src/server")),
  getTraceById: (...args: unknown[]) => mockGetTraceById(...args),
  getObservationsForTrace: (...args: unknown[]) =>
    mockGetObservationsForTrace(...args),
  getObservationCountForTrace: (...args: unknown[]) =>
    mockGetObservationCountForTrace(...args),
  getScoresAndCorrectionsForTraces: (...args: unknown[]) =>
    mockGetScoresAndCorrectionsForTraces(...args),
}));

vi.mock("@langfuse/shared/src/db", () => ({
  prisma: {
    traceSession: {
      findFirst: (...args: unknown[]) => mockTraceSessionFindFirst(...args),
    },
    project: {
      findFirst: (...args: unknown[]) => mockProjectFindFirst(...args),
    },
  },
}));

vi.mock("../../server/adminAccessWebhook", () => ({
  sendAdminAccessWebhook: (...args: unknown[]) =>
    mockSendAdminAccessWebhook(...args),
}));

const projectId = "project-1";
const traceId = "trace-1";
const traceTimestamp = new Date("2024-01-01T00:00:00.000Z");

const makeSession = (overrides?: {
  admin?: boolean;
  projects?: Array<{ id: string }>;
}): TraceExportSession => ({
  user: {
    email: "test@example.com",
    admin: overrides?.admin ?? false,
    organizations: [
      {
        projects: overrides?.projects ?? [{ id: projectId }],
      },
    ],
  },
});

const makeTrace = (overrides?: Record<string, unknown>) => ({
  id: traceId,
  name: "Trace 1",
  timestamp: traceTimestamp,
  environment: "default",
  tags: [],
  bookmarked: false,
  public: false,
  release: null,
  version: null,
  input: '{"prompt":"hello"}',
  output: '{"answer":"world"}',
  metadata: { foo: "bar" },
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  sessionId: null,
  userId: null,
  projectId,
  ...overrides,
});

const makeObservation = (overrides?: Record<string, unknown>) => ({
  id: "obs-1",
  traceId,
  projectId,
  userId: null,
  sessionId: null,
  environment: "default",
  type: "SPAN",
  startTime: new Date("2024-01-01T00:00:01.000Z"),
  endTime: new Date("2024-01-01T00:00:02.000Z"),
  name: "Observation 1",
  metadata: { key: "value" },
  parentObservationId: null,
  level: "DEFAULT",
  statusMessage: null,
  version: null,
  createdAt: new Date("2024-01-01T00:00:01.000Z"),
  updatedAt: new Date("2024-01-01T00:00:02.000Z"),
  model: null,
  internalModelId: null,
  modelParameters: null,
  input: '{"input":"secret"}',
  output: '{"output":"secret"}',
  completionStartTime: null,
  promptId: null,
  promptName: null,
  promptVersion: null,
  usageDetails: { input: 90, output: 45, total: 135 },
  costDetails: { total: 1.23 },
  providedCostDetails: { total: 1.5 },
  providedUsageDetails: { input: 100, output: 50, total: 150 },
  totalCost: null,
  usagePricingTierId: null,
  usagePricingTierName: null,
  toolDefinitions: null,
  toolCalls: null,
  toolCallNames: null,
  ...overrides,
});

const makeScore = (overrides?: Record<string, unknown>) => ({
  id: "score-1",
  projectId,
  environment: "default",
  name: "politeness",
  value: 1,
  source: "EVAL",
  authorUserId: null,
  comment: "helpful",
  metadata: { target_trace_id: traceId },
  configId: null,
  queueId: null,
  executionTraceId: "exec-1",
  createdAt: new Date("2024-01-01T00:00:03.000Z"),
  updatedAt: new Date("2024-01-01T00:00:04.000Z"),
  timestamp: new Date("2024-01-01T00:00:05.000Z"),
  traceId,
  sessionId: null,
  datasetRunId: null,
  observationId: null,
  longStringValue: "",
  stringValue: null,
  dataType: "NUMERIC",
  ...overrides,
});

describe("buildTraceExport", () => {
  const originalObservationLimit =
    env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES;

  beforeEach(() => {
    vi.clearAllMocks();
    env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES =
      originalObservationLimit;
    mockGetTraceById.mockResolvedValue(makeTrace());
    mockGetObservationsForTrace.mockResolvedValue([makeObservation()]);
    // Default below the omit-large-fields threshold, so the row fetch keeps IO/metadata.
    mockGetObservationCountForTrace.mockResolvedValue(1);
    mockGetScoresAndCorrectionsForTraces.mockResolvedValue([makeScore()]);
    mockTraceSessionFindFirst.mockResolvedValue(null);
    mockProjectFindFirst.mockResolvedValue({ orgId: "org-1" });
  });

  afterAll(() => {
    env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES =
      originalObservationLimit;
  });

  it("builds an export using full observation data for smaller traces", async () => {
    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(mockGetTraceById).toHaveBeenCalledWith({
      traceId,
      projectId,
      renderingProps: {
        truncated: true,
        shouldJsonParse: false,
      },
    });
    // The observation count is derived with a dedicated COUNT(*) helper (same lookback window).
    expect(mockGetObservationCountForTrace).toHaveBeenCalledWith({
      traceId,
      projectId,
      timestamp: traceTimestamp,
    });
    expect(mockGetObservationCountForTrace).toHaveBeenCalledTimes(1);
    // Below the threshold -> the single row fetch keeps full IO/metadata.
    expect(mockGetObservationsForTrace).toHaveBeenCalledTimes(1);
    expect(mockGetObservationsForTrace).toHaveBeenCalledWith({
      traceId,
      projectId,
      timestamp: traceTimestamp,
      includeIO: true,
    });
    expect(mockGetScoresAndCorrectionsForTraces).toHaveBeenCalledWith({
      projectId,
      traceIds: [traceId],
      timestamp: traceTimestamp,
    });
    expect(result.scores[0]).not.toHaveProperty("longStringValue");
    expect(result.scores[0]).not.toHaveProperty("queueId");
    expect(result.scores[0]).not.toHaveProperty("executionTraceId");
    expect(result).toMatchObject({
      scores: [
        expect.objectContaining({
          id: "score-1",
          traceId,
          value: 1,
          dataType: "NUMERIC",
        }),
      ],
      observations: [
        expect.objectContaining({
          id: "obs-1",
          traceId,
          traceName: "Trace 1",
          tags: [],
          bookmarked: false,
          public: false,
        }),
      ],
    });
  });

  it("inherits trace-level userId/sessionId/name/release for observations that lack them", async () => {
    mockGetTraceById.mockResolvedValue(
      makeTrace({
        name: "Parent Trace",
        userId: "trace-user",
        sessionId: "trace-session",
        release: "v1.2.3",
      }),
    );
    // The observation has none of these trace-level fields set.
    mockGetObservationsForTrace.mockResolvedValue([
      makeObservation({
        userId: null,
        sessionId: null,
        name: "child-observation",
        version: null,
      }),
    ]);

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      id: "obs-1",
      // Observation-level value is preserved.
      name: "child-observation",
      // Trace-level values are inherited by the exported observation rows.
      userId: "trace-user",
      sessionId: "trace-session",
      traceName: "Parent Trace",
      release: "v1.2.3",
    });
  });

  it("maps correction score text into stringValue without leaking internal fields", async () => {
    mockGetScoresAndCorrectionsForTraces.mockResolvedValue([
      makeScore({
        dataType: "CORRECTION",
        value: 0,
        stringValue: null,
        longStringValue: "corrected output",
        queueId: "queue-1",
        executionTraceId: "exec-1",
      }),
    ]);

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.scores).toEqual([
      expect.objectContaining({
        id: "score-1",
        traceId,
        dataType: "CORRECTION",
        value: 0,
        stringValue: "corrected output",
      }),
    ]);
    expect(result.scores[0]).not.toHaveProperty("longStringValue");
    expect(result.scores[0]).not.toHaveProperty("queueId");
    expect(result.scores[0]).not.toHaveProperty("executionTraceId");
  });

  it("keeps text score content in stringValue", async () => {
    mockGetScoresAndCorrectionsForTraces.mockResolvedValue([
      makeScore({
        dataType: "TEXT",
        value: 0,
        stringValue: "helpful response",
      }),
    ]);

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    expect(result.scores).toEqual([
      expect.objectContaining({
        id: "score-1",
        traceId,
        dataType: "TEXT",
        stringValue: "helpful response",
      }),
    ]);
    expect(result.scores[0]).not.toHaveProperty("value");
    expect(result.scores[0]).not.toHaveProperty("longStringValue");
  });

  it("omits IO, metadata, toolDefinitions, and toolCalls for large trace exports", async () => {
    // The count crosses the threshold, so omitLargeFields is driven by the COUNT helper, not the
    // fetched rows' length.
    mockGetObservationCountForTrace.mockResolvedValue(350);
    mockGetObservationsForTrace.mockResolvedValue(
      Array.from({ length: 350 }, (_, idx) => ({
        ...makeObservation(),
        id: `obs-${idx + 1}`,
        toolCallNames: ["read_file", "write_file"],
      })),
    );

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: makeSession(),
    });

    // Large traces fetch records without IO/metadata.
    expect(mockGetObservationsForTrace).toHaveBeenCalledTimes(1);
    expect(mockGetObservationsForTrace).toHaveBeenLastCalledWith({
      traceId,
      projectId,
      timestamp: traceTimestamp,
      includeIO: false,
    });
    expect(result.observations).toHaveLength(350);
    expect(result.observations[0]).not.toHaveProperty("input");
    expect(result.observations[0]).not.toHaveProperty("output");
    expect(result.observations[0]).not.toHaveProperty("metadata");
    expect(result.observations[0]).not.toHaveProperty("toolDefinitions");
    expect(result.observations[0]).not.toHaveProperty("toolCalls");
    expect(result.observations[0]).toHaveProperty("toolCallNames", [
      "read_file",
      "write_file",
    ]);
  });

  it("reemits the observation payload limit error as a download-safe error", async () => {
    env.LANGFUSE_API_TRACE_OBSERVATIONS_SIZE_LIMIT_BYTES = 100;
    mockGetObservationsForTrace.mockResolvedValue([
      makeObservation({
        input: "x".repeat(60),
        output: "y".repeat(60),
        metadata: { key: "z".repeat(60) },
      }),
    ]);

    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession(),
      }),
    ).rejects.toBeInstanceOf(TraceDownloadTooLargeError);
  });

  it("throws a not-found error when the trace is missing", async () => {
    mockGetTraceById.mockResolvedValue(null);

    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession(),
      }),
    ).rejects.toBeInstanceOf(LangfuseNotFoundError);
  });

  it("throws an unauthorized error when the user cannot read the trace", async () => {
    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: makeSession({ projects: [{ id: "other-project" }] }),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("allows unauthenticated access to public traces", async () => {
    mockGetTraceById.mockResolvedValue(makeTrace({ public: true }));

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: null,
    });

    expect(result).toMatchObject({
      observations: [
        expect.objectContaining({
          id: "obs-1",
          traceId,
          public: true,
        }),
      ],
    });
  });

  it("allows unauthenticated access to traces in public sessions", async () => {
    mockGetTraceById.mockResolvedValue(
      makeTrace({ public: false, sessionId: "trace-session-1" }),
    );
    mockTraceSessionFindFirst.mockResolvedValue({ public: true });

    const result = await buildTraceExport({
      traceId,
      projectId,
      session: null,
    });

    expect(mockTraceSessionFindFirst).toHaveBeenCalledWith({
      where: {
        id: "trace-session-1",
        projectId,
      },
      select: {
        public: true,
      },
    });
    expect(result).toMatchObject({
      observations: [expect.objectContaining({ id: "obs-1", traceId })],
    });
  });

  it("denies unauthenticated access to private traces", async () => {
    await expect(
      buildTraceExport({
        traceId,
        projectId,
        session: null,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("notifies on admin access", async () => {
    await buildTraceExport({
      traceId,
      projectId,
      session: makeSession({ admin: true, projects: [] }),
    });

    expect(mockSendAdminAccessWebhook).toHaveBeenCalledWith({
      email: "test@example.com",
      projectId,
      orgId: "org-1",
    });
  });
});
