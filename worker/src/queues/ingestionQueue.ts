import { Job, Processor } from "bullmq";
import {
  getIngestionEntityType,
  getCurrentSpan,
  logger,
  parseRawEventHistory,
  getProjectDeletedAt,
  QueueName,
  readRawEventsForEntity,
  recordDistribution,
  recordIncrement,
  redis,
  SecondaryIngestionQueue,
  TQueueJobTypes,
  traceException,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

import { env } from "../env";
import { IngestionService } from "../services/IngestionService";
import { GreptimeWriter } from "../services/GreptimeWriter";

export const ingestionQueueProcessorBuilder = (
  enableRedirectToSecondaryQueue: boolean,
): Processor => {
  const projectIdsToRedirectToSecondaryQueue =
    env.LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS?.split(",") ??
    [];

  return async (job: Job<TQueueJobTypes[QueueName.IngestionQueue]>) => {
    try {
      const span = getCurrentSpan();
      if (span) {
        span.setAttribute("messaging.bullmq.job.input.id", job.data.id);
        span.setAttribute(
          "messaging.bullmq.job.input.projectId",
          job.data.payload.authCheck.scope.projectId,
        );
        span.setAttribute(
          "messaging.bullmq.job.input.eventBodyId",
          job.data.payload.data.eventBodyId,
        );
        span.setAttribute(
          "messaging.bullmq.job.input.type",
          job.data.payload.data.type,
        );
      }

      // Batch-level seen-cache: if this batch for this entity was processed within the last
      // minutes, skip the redundant rebuild. Keyed on batchId. The full-history rebuild is
      // idempotent, so this is an optimization, not a correctness guard.
      const seenToken = job.data.payload.data.batchId;
      if (
        env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE === "true" &&
        redis &&
        seenToken
      ) {
        const key = `langfuse:ingestion:recently-processed:${job.data.payload.authCheck.scope.projectId}:${job.data.payload.data.type}:${job.data.payload.data.eventBodyId}:${seenToken}`;
        const exists = await redis.exists(key);
        if (exists) {
          recordIncrement("langfuse.ingestion.recently_processed_cache", 1, {
            type: job.data.payload.data.type,
            skipped: "true",
          });
          logger.debug(
            `Skipping already-processed batch ${seenToken} for project ${job.data.payload.authCheck.scope.projectId}`,
          );
          return;
        }
        recordIncrement("langfuse.ingestion.recently_processed_cache", 1, {
          type: job.data.payload.data.type,
          skipped: "false",
        });
        // NOTE: the seen key is set only AFTER a successful merge below — not here. Setting it
        // before the secondary-queue redirect would make the redirected job's reprocessing hit
        // the key and silently skip, dropping the entity.
      }

      // Check if project should be redirected to secondary queue (high-throughput separation).
      const projectId = job.data.payload.authCheck.scope.projectId;
      const shouldRedirectEnv =
        projectIdsToRedirectToSecondaryQueue.includes(projectId);

      if (enableRedirectToSecondaryQueue && shouldRedirectEnv) {
        logger.debug(
          `Redirecting ingestion event to secondary queue for project ${projectId}`,
        );
        const shardingKey = `${projectId}-${job.data.payload.data.eventBodyId}`;
        const secondaryQueue = SecondaryIngestionQueue.getInstance({
          shardingKey,
        });
        if (secondaryQueue) {
          await secondaryQueue.add(QueueName.IngestionSecondaryQueue, job.data);
          // If we don't redirect, we continue with the ingestion. Otherwise, we finish here.
          return;
        }
      }

      logger.debug(
        `Processing ingestion event ${
          enableRedirectToSecondaryQueue ? "" : "secondary"
        }`,
        {
          projectId: job.data.payload.authCheck.scope.projectId,
          payload: job.data.payload.data,
        },
      );

      // GreptimeDB primary path (02-write-path.md, decision 2): rebuild the entity snapshot from
      // its full raw_events history instead of downloading per-invocation S3 files. Out-of-order
      // delivery resolves naturally because every write replays the complete, deterministically
      // sorted history from scratch. `projectId` is already in scope from the redirect check above.
      const entityId = job.data.payload.data.eventBodyId;
      const clickhouseEntityType = getIngestionEntityType(
        job.data.payload.data.type,
      );

      const rawRows = await readRawEventsForEntity({
        projectId,
        entityType: clickhouseEntityType,
        entityId,
      });
      let { events, minIngestedAtMs, deleted } = parseRawEventHistory(rawRows);

      // Number of (deduped) events replayed per rebuild. Renamed from the old
      // "count_files_distribution" S3-file metric, whose semantics no longer apply.
      recordDistribution(
        "langfuse.ingestion.rebuild_event_count_distribution",
        events.length,
        { kind: clickhouseEntityType },
      );
      span?.setAttribute("langfuse.ingestion.event.kind", clickhouseEntityType);
      span?.setAttribute("langfuse.ingestion.raw_events_count", rawRows.length);

      if (events.length === 0) {
        logger.warn(
          `No events found for project ${projectId} and entity ${entityId}`,
        );
        return;
      }

      // Project-level deletion guard: a deleted project has no re-create semantics. Once a project
      // tombstone exists, every entity rebuild for that project stays soft-deleted so late appends
      // during the delete window cannot resurrect projections. Cheap MAX over the tiny
      // project_tombstones table; caching on this hot path is a perf follow-up.
      const projectDeletedAt = await getProjectDeletedAt(projectId);
      if (projectDeletedAt !== null) {
        deleted = true;
      }

      // Perform merge of those events
      if (!redis) throw new Error("Redis not available");
      if (!prisma) throw new Error("Prisma not available");

      await new IngestionService(
        redis,
        prisma,
        GreptimeWriter.getInstance(),
      ).mergeAndWrite(
        clickhouseEntityType,
        projectId,
        entityId,
        new Date(minIngestedAtMs),
        events,
        deleted,
      );

      // Mark this batch seen only after a successful merge, so a redirected or retried job is
      // never skipped before it actually wrote. The rebuild is idempotent, so a duplicate that
      // races past the check above merely costs one extra (harmless) rebuild.
      if (
        env.LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE === "true" &&
        redis &&
        seenToken
      ) {
        const key = `langfuse:ingestion:recently-processed:${projectId}:${job.data.payload.data.type}:${entityId}:${seenToken}`;
        await redis
          .set(key, "1", "EX", 60 * 5)
          .catch((e) =>
            logger.warn(`Failed to set seen-cache for batch ${seenToken}`, e),
          );
      }
    } catch (e) {
      logger.error(
        `Failed job ingestion processing for ${job.data.payload.authCheck.scope.projectId}`,
        e,
      );
      traceException(e);
      throw e;
    }
  };
};
