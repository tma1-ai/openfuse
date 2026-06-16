import { expect, describe, it, vi } from "vitest";
import { IngestionService } from "../../IngestionService";
import {
  convertDateToClickhouseDateTime,
  eventTypes,
  type ObservationEvent,
} from "@langfuse/shared/src/server";
import { GreptimeTable } from "../../GreptimeWriter";

/** Build a synthetic score-snapshot event (the D1 UI-mutation replay shape). */
const snapshotEvent = (
  overrides: {
    eventId?: string;
    timestamp?: string;
    value?: number;
    createdAt?: string;
    updatedAt?: string;
  } = {},
) => {
  const ts = overrides.timestamp ?? "2024-10-12T12:13:14.123Z";
  return {
    id: overrides.eventId ?? "evt-1",
    timestamp: ts,
    type: eventTypes.SCORE_SNAPSHOT,
    body: {
      id: "score-id",
      name: "quality",
      value: overrides.value ?? 0.42,
      source: "ANNOTATION",
      dataType: "NUMERIC",
      stringValue: null,
      longStringValue: "",
      comment: "looks good",
      metadata: { origin: "annotation" },
      traceId: "trace-id",
      observationId: null,
      sessionId: null,
      datasetRunId: null,
      executionTraceId: null,
      configId: null,
      queueId: null,
      authorUserId: "user-1",
      environment: "default",
      timestamp: ts,
      createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? ts,
    },
  };
};

/** Run processScoreEventList with a fake writer and return the merged Scores record. */
const runScoreSnapshots = async (
  events: ReturnType<typeof snapshotEvent>[],
  opts: { createdAtTimestamp?: Date; deleted?: boolean } = {},
) => {
  const addToQueue = vi.fn();
  const svc = new IngestionService({} as any, {} as any, { addToQueue } as any);
  await (svc as any).processScoreEventList({
    projectId: "project-id",
    entityId: "score-id",
    // Intentionally distinct from any body.createdAt so a leak of this value is caught.
    createdAtTimestamp:
      opts.createdAtTimestamp ?? new Date("2024-06-01T00:00:00.000Z"),
    scoreEventList: events,
    deleted: opts.deleted,
  });
  return addToQueue.mock.calls.find(
    ([table]) => table === GreptimeTable.Scores,
  )?.[1];
};

describe("IngestionService unit tests", () => {
  it("correctly sorts events in ascending order by timestamp", async () => {
    const firstTrace = { timestamp: 1, type: "observation-create" };
    const secondTrace = { timestamp: 1, type: "observation-update" };
    const thirdTrace = { timestamp: 3, type: "observation-update" };

    const records = [thirdTrace, secondTrace, firstTrace];

    const sortedEventList = (IngestionService as any).toTimeSortedEventList(
      records,
    );

    expect(sortedEventList).toEqual([firstTrace, secondTrace, thirdTrace]);
    expect(sortedEventList).not.toBe(records); // Ensure that the original array is not mutated
  });

  it("correctly convert Date to Clickhouse DateTime", async () => {
    const date = new Date("2024-10-12T12:13:14.123Z");

    const clickhouseDateTime = convertDateToClickhouseDateTime(date);

    expect(clickhouseDateTime).toEqual("2024-10-12 12:13:14.123");
  });

  it("keeps observation metadata values stringified after moving tool definitions to input", async () => {
    const addToQueue = vi.fn();
    const ingestionService = new IngestionService(
      {} as any,
      {} as any,
      { addToQueue } as any,
    );
    const tool = {
      type: "function",
      name: "get_weather",
      description: "Get weather.",
    };
    const timestamp = "2024-10-12T12:13:14.123Z";
    const observationEventList: ObservationEvent[] = [
      {
        id: "event-id",
        timestamp,
        type: "generation-create",
        body: {
          id: "observation-id",
          traceId: "trace-id",
          startTime: timestamp,
          input: [{ role: "user", content: "Need weather" }],
          metadata: {
            attributes: {
              "ai.prompt.tools": [tool],
              "custom.attribute": "keep-me",
            },
          },
          environment: "default",
        },
      },
    ];

    vi.spyOn(ingestionService as any, "getPrompt").mockResolvedValue(null);
    vi.spyOn(ingestionService as any, "getGenerationUsage").mockResolvedValue(
      {},
    );

    await (ingestionService as any).processObservationEventList({
      projectId: "project-id",
      entityId: "observation-id",
      createdAtTimestamp: new Date(timestamp),
      observationEventList,
    });

    const observationRecord = addToQueue.mock.calls.find(
      ([table]) => table === GreptimeTable.Observations,
    )?.[1];

    expect(observationRecord?.metadata).toEqual({
      attributes: JSON.stringify({ "custom.attribute": "keep-me" }),
    });
  });

  describe("score snapshot replay (D1)", () => {
    it("maps a score-snapshot straight to a projection record, bypassing validateAndInflateScore", async () => {
      const record = await runScoreSnapshots([snapshotEvent({ value: 0.42 })]);

      // A pure-snapshot replay never calls validateAndInflateScore (which would reject an ANNOTATION
      // score with no configId), so the already-inflated body fields land verbatim.
      expect(record).toMatchObject({
        id: "score-id",
        project_id: "project-id",
        name: "quality",
        value: 0.42,
        source: "ANNOTATION",
        data_type: "NUMERIC",
        trace_id: "trace-id",
        comment: "looks good",
        long_string_value: "",
        author_user_id: "user-1",
        environment: "default",
        is_deleted: 0,
      });
      expect(record.metadata).toEqual({ origin: "annotation" });
    });

    it("preserves the snapshot's createdAt instead of the ingestion-derived timestamp", async () => {
      const record = await runScoreSnapshots(
        [snapshotEvent({ createdAt: "2024-01-01T00:00:00.000Z" })],
        // min(ingested_at) the rebuild would otherwise stamp — must NOT win for a snapshot.
        { createdAtTimestamp: new Date("2024-06-01T00:00:00.000Z") },
      );

      expect(record.created_at).toBe(
        new Date("2024-01-01T00:00:00.000Z").getTime(),
      );
    });

    it("applies last-write-wins across multiple edits while keeping the original createdAt", async () => {
      const record = await runScoreSnapshots([
        snapshotEvent({
          eventId: "evt-old",
          timestamp: "2024-10-12T12:00:00.000Z",
          value: 0.1,
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
        snapshotEvent({
          eventId: "evt-new",
          timestamp: "2024-10-12T12:05:00.000Z",
          value: 0.9,
          createdAt: "2024-02-02T00:00:00.000Z",
        }),
      ]);

      // value is mutable -> latest edit wins; created_at is an immutable merge key -> earliest wins.
      expect(record.value).toBe(0.9);
      expect(record.created_at).toBe(
        new Date("2024-01-01T00:00:00.000Z").getTime(),
      );
    });

    it("rebuilds soft-deleted when a tombstone is present", async () => {
      const record = await runScoreSnapshots([snapshotEvent()], {
        deleted: true,
      });

      expect(record.is_deleted).toBe(1);
    });
  });
});
