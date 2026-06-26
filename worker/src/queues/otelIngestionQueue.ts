import { Job, Processor } from "bullmq";
import {
  createIngestionEventSchema,
  getIngestionEntityType,
  getCurrentSpan,
  getS3EventStorageClient,
  type IngestionEventType,
  logger,
  OtelIngestionProcessor,
  processEventBatch,
  QueueName,
  recordDistribution,
  recordHistogram,
  recordIncrement,
  redis,
  SecondaryOtelIngestionQueue,
  TQueueJobTypes,
  traceException,
} from "@langfuse/shared/src/server";
import { env } from "../env";
import { IngestionService } from "../services/IngestionService";
import { prisma } from "@langfuse/shared/src/db";
import { GreptimeWriter } from "../services/GreptimeWriter";
import {
  ForbiddenError,
  convertEventRecordToObservationForEval,
} from "@langfuse/shared";
import {
  fetchObservationEvalConfigs,
  scheduleObservationEvals,
  createObservationEvalSchedulerDeps,
} from "../features/evaluation/observationEval";

export const otelIngestionQueueProcessorBuilder = (
  enableRedirectToSecondaryQueue: boolean,
): Processor => {
  const projectIdsToRedirectToSecondaryQueue =
    env.LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS?.split(
      ",",
    ) ?? [];

  return async (
    job: Job<TQueueJobTypes[QueueName.OtelIngestionQueue]>,
  ): Promise<void> => {
    try {
      const projectId = job.data.payload.authCheck.scope.projectId;
      const publicKey = job.data.payload.data.publicKey;
      const fileKey = job.data.payload.data.fileKey;
      const auth = job.data.payload.authCheck;

      const span = getCurrentSpan();
      if (span) {
        span.setAttribute("messaging.bullmq.job.input.id", job.data.id);
        span.setAttribute(
          "messaging.bullmq.job.input.projectId",
          job.data.payload.authCheck.scope.projectId,
        );
        span.setAttribute(
          "messaging.bullmq.job.input.fileKey",
          job.data.payload.data.fileKey,
        );
      }
      logger.debug(`Processing ${fileKey} for project ${projectId}`);

      // Check if project should be redirected to secondary queue
      if (
        enableRedirectToSecondaryQueue &&
        projectIdsToRedirectToSecondaryQueue.includes(projectId)
      ) {
        logger.debug(
          `Redirecting otel ingestion event to secondary queue for project ${projectId}`,
        );
        const shardingKey = `${projectId}-${fileKey}`;
        const secondaryQueue = SecondaryOtelIngestionQueue.getInstance({
          shardingKey,
        });
        if (secondaryQueue) {
          await secondaryQueue.add(
            QueueName.OtelIngestionSecondaryQueue,
            job.data,
          );
          // Forwarded to secondary queue; stop processing here.
          return;
        }
      }

      // Download file from blob storage
      const resourceSpans = await getS3EventStorageClient(
        env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET,
      ).download(fileKey);

      recordHistogram(
        "langfuse.ingestion.s3_file_size_bytes",
        resourceSpans.length, // At this point it's still a string.
        {
          skippedS3List: "true",
          otel: "true",
        },
      );

      // Parse spans from S3 download
      const parsedSpans = JSON.parse(resourceSpans);

      // Generate events via OtelIngestionProcessor
      const processor = new OtelIngestionProcessor({
        projectId,
        publicKey,
      });
      const events: IngestionEventType[] =
        await processor.processToIngestionEvents(parsedSpans);
      // Here, we split the events into observations and non-observations.
      // Observations go into the IngestionService directly whereas the non-observations make another run through the processEventBatch method.
      const traces = events.filter(
        (e) => getIngestionEntityType(e.type) !== "observation",
      );
      // We need to parse each incoming observation through our ingestion schema to make use of its included transformations.
      const ingestionSchema = createIngestionEventSchema();
      const observations = events
        .filter((e) => getIngestionEntityType(e.type) === "observation")
        .map((o) => ingestionSchema.safeParse(o))
        .flatMap((o) => {
          if (!o.success) {
            logger.warn(
              `Failed to parse otel observation for project ${projectId} in ${fileKey}: ${o.error}`,
              {
                error: o.error,
                fileKey,
              },
            );
            return [];
          }
          return [o.data];
        });

      // In the next row, we only consider observations. The traces will be recorded in processEventBatch.
      recordIncrement("langfuse.ingestion.event", observations.length, {
        source: "otel",
      });
      // Record more stats specific to the Otel processing
      recordDistribution("langfuse.ingestion.otel.trace_count", traces.length);
      recordDistribution(
        "langfuse.ingestion.otel.observation_count",
        observations.length,
      );
      span?.setAttribute("langfuse.ingestion.otel.trace_count", traces.length);
      span?.setAttribute(
        "langfuse.ingestion.otel.observation_count",
        observations.length,
      );

      // Ensure required infra config is present
      if (!redis) throw new Error("Redis not available");
      if (!prisma) throw new Error("Prisma not available");

      const ingestionService = new IngestionService(
        redis,
        prisma,
        GreptimeWriter.getInstance(),
      );

      // Decide whether observations should be processed via new flow (directly to events table)
      // or via the dual write (staging table and batch job to events).
      //
      // Route traces AND observations through processEventBatch: it writes raw_events
      // (post-sampling) and enqueues per-entity merge jobs that rebuild each projection from the
      // full raw_events history (rebuildFromHistory=true => deterministic
      // created_at=min(ingested_at)). Observations no longer use an inline read-merge-write
      // against a ClickHouse baseline.
      await processEventBatch([...traces, ...observations], auth, {
        delay: 0,
        source: "otel",
      });

      // Schedule observation-level evals for the parsed spans. This requires
      // enriched event records with trace-level attributes (userId, sessionId,
      // tags, release) that processToEvent provides.
      const eventInputs = processor.processToEvent(parsedSpans);

      if (eventInputs.length === 0) {
        return;
      }

      const evalConfigs = await fetchObservationEvalConfigs(projectId).catch(
        (error) => {
          traceException(error);
          logger.warn(
            `Failed to fetch observation eval configs for project ${projectId}`,
            error,
          );

          return [];
        },
      );

      // Nothing to schedule without eval configs.
      if (evalConfigs.length === 0) {
        return;
      }

      const evalSchedulerDeps = createObservationEvalSchedulerDeps();

      await Promise.all(
        // Process each event independently
        eventInputs.map(async (eventInput) => {
          // Build the enriched, normalized event record for eval scheduling.
          let eventRecord;
          try {
            eventRecord = await ingestionService.createNormalizedEventRecord(
              eventInput,
              fileKey,
            );
          } catch (error) {
            traceException(error);
            logger.error(
              `Failed to create event record for project ${eventInput.projectId} and observation ${eventInput.spanId}`,
              { error, fileKey },
            );

            return;
          }

          try {
            const observation =
              convertEventRecordToObservationForEval(eventRecord);

            await scheduleObservationEvals({
              observation,
              configs: evalConfigs,
              schedulerDeps: evalSchedulerDeps,
            });
          } catch (error) {
            traceException(error);

            logger.error(
              `Failed to schedule observation evals for project ${eventInput.projectId} and observation ${eventInput.spanId}`,
              { error, fileKey },
            );
          }
        }),
      );
    } catch (e) {
      const fileKey = job.data.payload.data.fileKey;
      if (e instanceof ForbiddenError) {
        traceException(e);
        logger.warn(`Failed to parse otel observation: ${e.message}`, {
          error: e,
          fileKey,
        });
        return;
      }

      logger.error(
        `Failed job otel ingestion processing for ${job.data.payload.authCheck.scope.projectId}`,
        { error: e, fileKey },
      );
      traceException(e);
      throw e;
    }
  };
};
