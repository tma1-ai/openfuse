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

      // Coalesce redundant rebuilds. raw_events are written before the job is enqueued, so
      // `job.data.timestamp` >= the max ingested_at of this job's events. If a prior rebuild already
      // covered a watermark >= this timestamp, it provably read all of this job's events (and any
      // tombstone among them) and — being a full-history idempotent rebuild — made this job redundant;
      // skipping avoids the expensive full-history read. Conservative: never skips an uncovered event.
      const coalesceKey = `langfuse:ingestion:rebuilt-watermark:${projectId}:${job.data.payload.data.type}:${entityId}`;
      if (env.LANGFUSE_INGESTION_COALESCE_REBUILDS === "true" && redis) {
        const watermark = await redis.get(coalesceKey);
        if (watermark && Number(watermark) >= job.data.timestamp.getTime()) {
          recordIncrement("langfuse.ingestion.coalesced_rebuild_skipped", 1, {
            kind: clickhouseEntityType,
          });
          return;
        }
      }

      const rawRows = await readRawEventsForEntity({
        projectId,
        entityType: clickhouseEntityType,
        entityId,
      });
      let { events, minIngestedAtMs, maxIngestedAtMs, eavGeneration, deleted } =
        parseRawEventHistory(rawRows);

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
        eavGeneration,
      );

      // Publish the watermark = max ingested_at this rebuild covered after the rebuild was accepted by
      // the writer. Plain SET: same-entity jobs are sharded in order so it is monotonic in practice,
      // and a rare lower value only costs a redundant rebuild. `redis` is non-null here (guarded above).
      if (env.LANGFUSE_INGESTION_COALESCE_REBUILDS === "true") {
        await redis
          .set(
            coalesceKey,
            String(maxIngestedAtMs),
            "EX",
            env.LANGFUSE_INGESTION_COALESCE_WATERMARK_TTL_SECONDS,
          )
          .catch((e) =>
            logger.warn(`Failed to set rebuild watermark for ${entityId}`, e),
          );
      }

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
