import { logger } from "@langfuse/shared/src/server";
import { redis } from "@langfuse/shared/src/server";

import { GreptimeWriter } from "../services/GreptimeWriter";
import { terminateFlushWorkerPool } from "../services/GreptimeWriter/flushWorkerPool";
import { setSigtermReceived } from "../features/health";
import { server } from "../index";
import { freeAllTokenizers } from "../features/tokenisation/usage";
import { getTokenCountWorkerManager } from "../features/tokenisation/async-usage";
import { WorkerManager } from "../queues/workerManager";
import { prisma } from "@langfuse/shared/src/db";
import { BackgroundMigrationManager } from "../backgroundMigrations/backgroundMigrationManager";
import {
  batchProjectCleaners,
  mediaRetentionCleaner,
  batchProjectMediaCleaner,
  batchTraceDeletionCleaner,
  queueMetricsRunner,
  greptimeStatsRunner,
  greptimeRawEventsFlushRunner,
  monitorRunners,
} from "../app";

export const onShutdown: NodeJS.SignalsListener = async (signal) => {
  logger.info(`Received ${signal}, closing server...`);
  setSigtermReceived();

  // Stop accepting new connections
  server?.close();
  logger.info("Server has been closed.");

  // Stop batch project cleaners
  for (const cleaner of batchProjectCleaners) {
    cleaner.stop();
  }

  // Stop media retention cleaner
  mediaRetentionCleaner?.stop();

  // Stop batch project media cleaner
  batchProjectMediaCleaner?.stop();

  // Stop batch trace deletion cleaner
  batchTraceDeletionCleaner?.stop();

  // Stop queue metrics runner
  queueMetricsRunner?.stop();

  // Stop GreptimeDB region-statistics sampler
  greptimeStatsRunner?.stop();
  greptimeRawEventsFlushRunner?.stop();

  // Stop monitor runners
  for (const runner of monitorRunners) {
    runner.stop();
  }

  // Shutdown workers (https://docs.bullmq.io/guide/going-to-production#gracefully-shut-down-workers)
  await WorkerManager.closeWorkers();

  // Shutdown background migrations
  await BackgroundMigrationManager.close();

  // Flush all pending GreptimeDB writes AFTER closing the ingestion queue worker that feeds them.
  // GreptimeDB is the sole projection backend, so buffered writes must not be dropped on shutdown.
  await GreptimeWriter.getInstance().shutdown();
  logger.info("GreptimeDB writer has been shut down.");

  // The writer's final drain has settled, so no flush is in flight; tear down the offload pool's
  // worker threads (each holds its own gRPC client) so the process can exit cleanly.
  try {
    await terminateFlushWorkerPool();
    logger.info("GreptimeDB flush worker pool has been terminated.");
  } catch (error) {
    logger.error("Error terminating GreptimeDB flush worker pool", error);
  }

  redis?.disconnect();
  logger.info("Redis connection has been closed.");

  await prisma.$disconnect();
  logger.info("Prisma connection has been closed.");

  // Shutdown tokenization worker threads
  try {
    await getTokenCountWorkerManager().terminate();
    logger.info("Token count worker threads have been terminated.");
  } catch (error) {
    logger.error("Error terminating token count worker threads", error);
  }

  freeAllTokenizers();
  logger.info("All tokenizers are cleaned up from memory.");

  logger.info("Shutdown complete, exiting process...");
};
