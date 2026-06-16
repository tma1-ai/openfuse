import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  GREPTIME_RECONCILIATION_MAX_BATCH_SIZE,
  GreptimeReconciliationQueue,
  logger,
  QueueJobs,
} from "@langfuse/shared/src/server";
import { AdminApiAuthService } from "@/src/ee/features/admin-api/server/adminApiAuth";

const GreptimeReconciliationBody = z.object({
  projectId: z.string().min(1),
  batchSize: z
    .number()
    .int()
    .positive()
    .max(GREPTIME_RECONCILIATION_MAX_BATCH_SIZE)
    .optional(),
});

/**
 * Manually trigger a per-project GreptimeDB reconciliation: re-run the idempotent per-entity rebuild
 * over every entity in raw_events so any projection drift self-heals. Enqueues the first job; the
 * worker self-requeues with the next keyset cursor until the project is exhausted.
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

    const body = GreptimeReconciliationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error });
      return;
    }

    const queue = GreptimeReconciliationQueue.getInstance();
    if (!queue) {
      res.status(503).json({ error: "Reconciliation queue not available" });
      return;
    }

    await queue.add(QueueJobs.GreptimeReconciliationJob, {
      timestamp: new Date(),
      id: randomUUID(),
      name: QueueJobs.GreptimeReconciliationJob,
      payload: {
        projectId: body.data.projectId,
        batchSize: body.data.batchSize,
      },
    });

    logger.info(
      `Greptime reconciliation enqueued for project ${body.data.projectId}`,
    );

    return res.status(200).json({ enqueued: true });
  } catch (e) {
    logger.error("Failed to enqueue greptime reconciliation", e);
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
}
