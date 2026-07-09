import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  greptimeQuery: vi.fn(),
  greptimeWrite: vi.fn(),
  writeRawEvents: vi.fn(),
}));

vi.mock("./client", () => ({
  greptimeQuery: mocks.greptimeQuery,
  getGreptimeIngestClient: () => ({
    write: mocks.greptimeWrite,
  }),
}));

vi.mock("./rawEvents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rawEvents")>()),
  writeRawEvents: mocks.writeRawEvents,
}));

import {
  deleteEntitiesFromGreptime,
  deleteProjectFromGreptime,
  deleteTracesFromGreptime,
  getProjectDeletedAt,
  isParentTraceDeleted,
} from "./deletion";
import { TOMBSTONE_EVENT_TYPE } from "./converters";

describe("Greptime deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.greptimeQuery.mockResolvedValue([]);
    mocks.greptimeWrite.mockResolvedValue(undefined);
    mocks.writeRawEvents.mockResolvedValue(undefined);
  });

  describe("isParentTraceDeleted", () => {
    const liveRow = (eventId: string, ingestedAt: number) => ({
      ingested_at: new Date(ingestedAt),
      event_id: eventId,
      event_type: "trace-create",
      event_ts: new Date(ingestedAt),
      body: JSON.stringify({ id: "t1", timestamp: ingestedAt }),
    });
    const tombstoneRow = (ingestedAt: number) => ({
      ingested_at: new Date(ingestedAt),
      event_id: `tombstone-${ingestedAt}`,
      event_type: TOMBSTONE_EVENT_TYPE,
      event_ts: new Date(ingestedAt),
      body: JSON.stringify({ id: "t1", deletedAt: ingestedAt }),
    });

    it("returns false for an empty traceId without querying", async () => {
      expect(await isParentTraceDeleted("p1", "")).toBe(false);
      expect(await isParentTraceDeleted("p1", null)).toBe(false);
      expect(mocks.greptimeQuery).not.toHaveBeenCalled();
    });

    it("returns true when the trace's latest raw event is a tombstone", async () => {
      mocks.greptimeQuery.mockResolvedValueOnce([liveRow("e1", 100), tombstoneRow(200)]);
      expect(await isParentTraceDeleted("p1", "t1")).toBe(true);
    });

    it("returns false when the trace has live events and no tombstone", async () => {
      mocks.greptimeQuery.mockResolvedValueOnce([liveRow("e1", 100)]);
      expect(await isParentTraceDeleted("p1", "t1")).toBe(false);
    });

    it("returns false when a live event is ingested after the tombstone (re-create)", async () => {
      mocks.greptimeQuery.mockResolvedValueOnce([
        liveRow("e1", 100),
        tombstoneRow(200),
        liveRow("e2", 300),
      ]);
      expect(await isParentTraceDeleted("p1", "t1")).toBe(false);
    });
  });

  it("deletes entity projection and EAV rows with project scoping", async () => {
    await deleteEntitiesFromGreptime({
      projectId: "project-1",
      entityType: "score",
      entityIds: ["score-1"],
    });

    expect(mocks.writeRawEvents).toHaveBeenCalledOnce();
    expect(mocks.writeRawEvents.mock.calls[0]?.[0]).toMatchObject([
      {
        projectId: "project-1",
        entityType: "score",
        entityId: "score-1",
        eventType: "langfuse-tombstone",
      },
    ]);
    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(3);
    expect(mocks.greptimeQuery.mock.calls.map(([arg]) => arg.params)).toEqual([
      ["project-1", "score-1"],
      ["project-1", "score-1"],
      ["project-1", "score-1"],
    ]);
    expect(mocks.greptimeQuery.mock.calls.map(([arg]) => arg.query)).toEqual([
      "DELETE FROM `scores` WHERE `project_id` = ? AND `id` = ?",
      "DELETE FROM `scores_metadata` WHERE `project_id` = ? AND `entity_id` = ?",
      "DELETE FROM `scores_tags` WHERE `project_id` = ? AND `entity_id` = ?",
    ]);
  });

  it("deletes an observation's projection + all EAV tables incl. tool tables", async () => {
    await deleteEntitiesFromGreptime({
      projectId: "project-1",
      entityType: "observation",
      entityIds: ["obs-1"],
    });

    expect(mocks.greptimeQuery.mock.calls.map(([arg]) => arg.query)).toEqual([
      "DELETE FROM `observations` WHERE `project_id` = ? AND `id` = ?",
      "DELETE FROM `observations_metadata` WHERE `project_id` = ? AND `entity_id` = ?",
      "DELETE FROM `observations_tags` WHERE `project_id` = ? AND `entity_id` = ?",
      "DELETE FROM `observations_usage_cost` WHERE `project_id` = ? AND `entity_id` = ?",
      "DELETE FROM `observations_tool_definitions` WHERE `project_id` = ? AND `entity_id` = ?",
      "DELETE FROM `observations_tool_calls` WHERE `project_id` = ? AND `entity_id` = ?",
    ]);
  });

  it("deletes traces and child observations/scores resolved from projections", async () => {
    mocks.greptimeQuery
      .mockResolvedValueOnce([{ id: "obs-1" }, { id: "obs-2" }])
      .mockResolvedValueOnce([{ id: "score-1" }])
      .mockResolvedValue([]);

    await deleteTracesFromGreptime({
      projectId: "project-1",
      traceIds: ["trace-1"],
    });

    expect(mocks.greptimeQuery.mock.calls[0]?.[0]).toMatchObject({
      params: ["project-1", "trace-1"],
      readOnly: true,
    });
    expect(mocks.greptimeQuery.mock.calls[0]?.[0].query).toContain(
      "FROM `observations`",
    );
    expect(mocks.greptimeQuery.mock.calls[1]?.[0]).toMatchObject({
      params: ["project-1", "trace-1"],
      readOnly: true,
    });
    expect(mocks.greptimeQuery.mock.calls[1]?.[0].query).toContain(
      "FROM `scores`",
    );
    const tombstonedEntityIds = mocks.writeRawEvents.mock.calls
      .flatMap(([rows]) => rows)
      .map((row) => row.entityId)
      .sort();
    expect(tombstonedEntityIds).toEqual([
      "obs-1",
      "obs-2",
      "score-1",
      "trace-1",
    ]);
  });

  it("deletes every project-scoped projection table for project deletion", async () => {
    await deleteProjectFromGreptime("project-1");

    expect(mocks.greptimeWrite).toHaveBeenCalledOnce();
    // 3 trace + 6 observation (incl. usage_cost + tool_definitions + tool_calls) + 3 score +
    // 1 dataset_run_items.
    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(13);
    expect(mocks.greptimeQuery.mock.calls).toEqual(
      expect.arrayContaining([
        [
          {
            query: "DELETE FROM `traces` WHERE `project_id` = ?",
            params: ["project-1"],
          },
        ],
        [
          {
            query:
              "DELETE FROM `observations_usage_cost` WHERE `project_id` = ?",
            params: ["project-1"],
          },
        ],
        [
          {
            query:
              "DELETE FROM `observations_tool_definitions` WHERE `project_id` = ?",
            params: ["project-1"],
          },
        ],
        [
          {
            query:
              "DELETE FROM `observations_tool_calls` WHERE `project_id` = ?",
            params: ["project-1"],
          },
        ],
        [
          {
            query: "DELETE FROM `dataset_run_items` WHERE `project_id` = ?",
            params: ["project-1"],
          },
        ],
      ]),
    );
  });

  describe("getProjectDeletedAt (D3 project tombstone)", () => {
    it("returns null when the project has no tombstone", async () => {
      mocks.greptimeQuery.mockResolvedValueOnce([]);
      expect(await getProjectDeletedAt("project-1")).toBeNull();

      mocks.greptimeQuery.mockResolvedValueOnce([{ deleted_at: null }]);
      expect(await getProjectDeletedAt("project-1")).toBeNull();
    });

    it("parses the latest deleted_at to ms epoch from a Date", async () => {
      const at = new Date("2024-05-01T00:00:00.000Z");
      mocks.greptimeQuery.mockResolvedValueOnce([{ deleted_at: at }]);
      expect(await getProjectDeletedAt("project-1")).toBe(at.getTime());
    });

    it("parses the latest deleted_at to ms epoch from a string", async () => {
      mocks.greptimeQuery.mockResolvedValueOnce([
        { deleted_at: "2024-05-01 00:00:00.000" },
      ]);
      expect(await getProjectDeletedAt("project-1")).toBe(
        new Date("2024-05-01 00:00:00.000").getTime(),
      );
    });
  });
});
