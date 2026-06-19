import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks shared between the vi.mock factories and the assertions.
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  reconcileAddBulk: vi.fn(),
  fleetAdd: vi.fn(),
  recordIncrement: vi.fn(),
}));

vi.mock("@langfuse/shared/src/db", () => ({
  prisma: { project: { findMany: mocks.findMany } },
}));

vi.mock("@langfuse/shared/src/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@langfuse/shared/src/server")>();
  return {
    ...actual,
    recordIncrement: mocks.recordIncrement,
    GreptimeReconciliationQueue: {
      getInstance: () => ({ addBulk: mocks.reconcileAddBulk }),
    },
    GreptimeReconciliationFleetQueue: {
      getInstance: () => ({ add: mocks.fleetAdd }),
    },
  };
});

import { QueueJobs } from "@langfuse/shared/src/server";
import { handleGreptimeReconciliationFleet } from "./handleGreptimeReconciliationFleet";

const projectRows = (ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.reconcileAddBulk.mockReset();
  mocks.fleetAdd.mockReset();
  mocks.recordIncrement.mockReset();
});

describe("handleGreptimeReconciliationFleet", () => {
  it("fans out one reconciliation job per project, deduped, with batchSize passthrough", async () => {
    mocks.findMany.mockResolvedValue(projectRows(["p1", "p2"]));

    await handleGreptimeReconciliationFleet({ batchSize: 250 });

    // Soft-deleted projects excluded; first page has no cursor; probes pageSize + 1.
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    const findArgs = mocks.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ deletedAt: null });
    expect(findArgs.orderBy).toEqual({ id: "asc" });
    expect(findArgs.take).toBe(51); // default page size 50 + 1 probe

    expect(mocks.reconcileAddBulk).toHaveBeenCalledTimes(1);
    const bulk = mocks.reconcileAddBulk.mock.calls[0][0];
    expect(bulk).toHaveLength(2);
    expect(bulk[0]).toMatchObject({
      name: QueueJobs.GreptimeReconciliationJob,
      data: {
        name: QueueJobs.GreptimeReconciliationJob,
        payload: { projectId: "p1", batchSize: 250 },
      },
      opts: { jobId: "greptime-backfill:p1", removeOnFail: true },
    });
    expect(bulk[1]).toMatchObject({
      opts: { jobId: "greptime-backfill:p2" },
      data: { payload: { projectId: "p2", batchSize: 250 } },
    });

    expect(mocks.recordIncrement).toHaveBeenCalledWith(
      "langfuse.greptime_reconciliation.fleet_projects_enqueued",
      2,
    );

    // All projects fit on one page -> no self-requeue.
    expect(mocks.fleetAdd).not.toHaveBeenCalled();
  });

  it("self-requeues with the last project id as cursor when more pages remain", async () => {
    // pageSize 2 -> probe returns 3 rows -> hasMore, only first 2 are enqueued.
    mocks.findMany.mockResolvedValue(projectRows(["p1", "p2", "p3"]));

    await handleGreptimeReconciliationFleet({
      projectPageSize: 2,
      batchSize: 100,
    });

    const bulk = mocks.reconcileAddBulk.mock.calls[0][0];
    expect(
      bulk.map(
        (j: { data: { payload: { projectId: string } } }) =>
          j.data.payload.projectId,
      ),
    ).toEqual(["p1", "p2"]);

    expect(mocks.fleetAdd).toHaveBeenCalledTimes(1);
    expect(mocks.fleetAdd.mock.calls[0][0]).toBe(
      QueueJobs.GreptimeReconciliationFleetJob,
    );
    expect(mocks.fleetAdd.mock.calls[0][1]).toMatchObject({
      name: QueueJobs.GreptimeReconciliationFleetJob,
      payload: {
        cursor: { projectId: "p2" },
        projectPageSize: 2,
        batchSize: 100,
      },
    });
  });

  it("applies the keyset cursor on subsequent pages", async () => {
    mocks.findMany.mockResolvedValue(projectRows(["p3"]));

    await handleGreptimeReconciliationFleet({
      cursor: { projectId: "p2" },
      projectPageSize: 2,
    });

    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: null,
      id: { gt: "p2" },
    });
    // Last page (1 <= pageSize) -> no further requeue.
    expect(mocks.fleetAdd).not.toHaveBeenCalled();
  });

  it("does not enqueue or requeue when there are no projects", async () => {
    mocks.findMany.mockResolvedValue([]);

    await handleGreptimeReconciliationFleet({});

    expect(mocks.reconcileAddBulk).not.toHaveBeenCalled();
    expect(mocks.fleetAdd).not.toHaveBeenCalled();
    expect(mocks.recordIncrement).toHaveBeenCalledWith(
      "langfuse.greptime_reconciliation.fleet_projects_enqueued",
      0,
    );
  });
});
