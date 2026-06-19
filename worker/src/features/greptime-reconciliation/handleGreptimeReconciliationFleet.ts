import { randomUUID } from "crypto";
import {
  GREPTIME_RECONCILIATION_FLEET_MAX_PROJECT_PAGE_SIZE,
  type GreptimeReconciliationFleetEventType,
  GreptimeReconciliationFleetQueue,
  GreptimeReconciliationQueue,
  logger,
  QueueJobs,
  recordIncrement,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

import { env } from "../../env";

/**
 * Fleet-wide reconciliation orchestrator: a one-shot historical backfill that fans the existing
 * per-project reconciliation out over every (non-deleted) project. This is the only piece the
 * historical EAV backfill was missing -- the per-project rebuild already replays raw_events through
 * `buildGreptimeRowsForRecord`, which populates `observations_usage_cost` for the long-tail custom
 * usage/cost keys (standard keys are served from the JSON columns and never depend on the EAV table).
 *
 * One job processes a single keyset page (projectPageSize projects), enqueues one
 * GreptimeReconciliationJob per project, and re-enqueues itself with the next project cursor until
 * all projects are enumerated. It does no rebuild work itself; the per-project processor self-requeues
 * per entity-page and drains each project. Orchestration stays cheap and bounded per job.
 */
export async function handleGreptimeReconciliationFleet(
  payload: GreptimeReconciliationFleetEventType,
): Promise<void> {
  // Clamp to [1, ceiling] like the per-project handler so neither an oversized env default / forged
  // payload blows one orchestration page into a huge project scan, nor a zero/negative value leaves
  // the page empty while `hasMore` is true (which would crash on the next-cursor computation).
  const projectPageSize = Math.max(
    1,
    Math.min(
      payload.projectPageSize ??
        env.LANGFUSE_GREPTIME_RECONCILIATION_FLEET_PROJECT_PAGE_SIZE,
      GREPTIME_RECONCILIATION_FLEET_MAX_PROJECT_PAGE_SIZE,
    ),
  );

  if (!prisma) throw new Error("Prisma not available");

  const reconciliationQueue = GreptimeReconciliationQueue.getInstance();
  if (!reconciliationQueue) {
    throw new Error("Greptime reconciliation queue not available");
  }

  // Keyset over projects ordered by id, skipping soft-deleted ones (the per-entity rebuild still
  // guards with getProjectDeletedAt; this just avoids enqueuing no-op work). Probe one extra row so
  // we can tell whether a next page exists without a second round-trip.
  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      ...(payload.cursor ? { id: { gt: payload.cursor.projectId } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: projectPageSize + 1,
  });
  const hasMore = projects.length > projectPageSize;
  const pageProjects = hasMore ? projects.slice(0, projectPageSize) : projects;

  if (pageProjects.length > 0) {
    await reconciliationQueue.addBulk(
      pageProjects.map((project) => ({
        name: QueueJobs.GreptimeReconciliationJob,
        data: {
          timestamp: new Date(),
          id: randomUUID(),
          name: QueueJobs.GreptimeReconciliationJob,
          payload: {
            projectId: project.id,
            batchSize: payload.batchSize,
          },
        },
        opts: {
          // Deduplicate by project so re-triggering the backfill (or a self-requeue overlap) does not
          // stack a second in-flight reconciliation chain for the same project. removeOnFail clears
          // failed jobs immediately so they don't block re-queuing on a later run. The per-project
          // processor's own self-requeues intentionally carry no jobId, so a project still drains
          // fully once started.
          jobId: `greptime-backfill:${project.id}`,
          removeOnFail: true,
        },
      })),
    );
  }

  recordIncrement(
    "langfuse.greptime_reconciliation.fleet_projects_enqueued",
    pageProjects.length,
  );

  if (hasMore) {
    const lastProject = pageProjects[pageProjects.length - 1]!;
    const fleetQueue = GreptimeReconciliationFleetQueue.getInstance();
    if (!fleetQueue) {
      throw new Error("Greptime reconciliation fleet queue not available");
    }
    await fleetQueue.add(QueueJobs.GreptimeReconciliationFleetJob, {
      timestamp: new Date(),
      id: randomUUID(),
      name: QueueJobs.GreptimeReconciliationFleetJob,
      payload: {
        cursor: { projectId: lastProject.id },
        projectPageSize: payload.projectPageSize,
        batchSize: payload.batchSize,
      },
    });
  } else {
    logger.info(
      `Greptime reconciliation fleet backfill exhausted all projects (last page ${pageProjects.length})`,
    );
  }
}
