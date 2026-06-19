import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  GREPTIME_RECONCILIATION_FLEET_MAX_PROJECT_PAGE_SIZE,
  GREPTIME_RECONCILIATION_MAX_BATCH_SIZE,
  GreptimeReconciliationFleetQueue,
  logger,
  QueueJobs,
} from "@langfuse/shared/src/server";
import { AdminApiAuthService } from "@/src/server/api/adminApiAuth";

const GreptimeReconciliationBackfillAllBody = z.object({
  // Projects fanned out per orchestration page before the fleet job re-enqueues itself.
  projectPageSize: z
    .number()
    .int()
    .positive()
    .max(GREPTIME_RECONCILIATION_FLEET_MAX_PROJECT_PAGE_SIZE)
    .optional(),
  // Per-project entity batch size, passed through to each enqueued reconciliation job.
  batchSize: z
    .number()
    .int()
    .positive()
    .max(GREPTIME_RECONCILIATION_MAX_BATCH_SIZE)
    .optional(),
});

/**
 * Trigger a fleet-wide GreptimeDB reconciliation backfill: enqueue one orchestration job that keyset-
 * paginates over every non-deleted project and fans out a per-project reconciliation each, replaying
 * raw_events so historical custom usage/cost keys land in the observations_usage_cost EAV table. The
 * orchestrator self-requeues until all projects are enumerated; each project then self-requeues until
 * its entities are exhausted. Idempotent: re-triggering deduplicates per project.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    if (
      !AdminApiAuthService.handleAdminAuth(req, res, {
        isAllowedOnLangfuseCloud: true,
      })
    ) {
      return;
    }

    const body = GreptimeReconciliationBackfillAllBody.safeParse(
      req.body ?? {},
    );
    if (!body.success) {
      res.status(400).json({ error: body.error });
      return;
    }

    const queue = GreptimeReconciliationFleetQueue.getInstance();
    if (!queue) {
      res
        .status(503)
        .json({ error: "Reconciliation fleet queue not available" });
      return;
    }

    await queue.add(QueueJobs.GreptimeReconciliationFleetJob, {
      timestamp: new Date(),
      id: randomUUID(),
      name: QueueJobs.GreptimeReconciliationFleetJob,
      payload: {
        projectPageSize: body.data.projectPageSize,
        batchSize: body.data.batchSize,
      },
    });

    logger.info("Greptime reconciliation fleet backfill enqueued");

    return res.status(200).json({ enqueued: true });
  } catch (e) {
    logger.error("Failed to enqueue greptime reconciliation fleet backfill", e);
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
}
