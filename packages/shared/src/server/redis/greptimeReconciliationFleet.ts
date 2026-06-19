import { QueueName, TQueueJobTypes } from "../queues";
import { Queue } from "bullmq";
import { createBullMQQueueOptionsWithRedis } from "./redis";
import { logger } from "../logger";

/**
 * On-demand orchestration queue for fleet-wide GreptimeDB reconciliation (historical EAV backfill).
 * Unlike the integration "schedule" queues this carries no repeatable pattern: an operator triggers
 * it via the admin route, the processor keyset-paginates over projects and fans out per-project
 * GreptimeReconciliationJob, then re-enqueues itself until every project is enumerated.
 */
export class GreptimeReconciliationFleetQueue {
  private static instance: Queue<
    TQueueJobTypes[QueueName.GreptimeReconciliationFleet]
  > | null = null;

  public static getInstance(): Queue<
    TQueueJobTypes[QueueName.GreptimeReconciliationFleet]
  > | null {
    if (GreptimeReconciliationFleetQueue.instance)
      return GreptimeReconciliationFleetQueue.instance;

    const queueOptionsWithRedis = createBullMQQueueOptionsWithRedis(
      QueueName.GreptimeReconciliationFleet,
    );
    GreptimeReconciliationFleetQueue.instance = queueOptionsWithRedis
      ? new Queue<TQueueJobTypes[QueueName.GreptimeReconciliationFleet]>(
          QueueName.GreptimeReconciliationFleet,
          {
            ...queueOptionsWithRedis,
            defaultJobOptions: {
              removeOnComplete: true,
              removeOnFail: 1_000,
              attempts: 2,
              backoff: {
                type: "exponential",
                delay: 30_000,
              },
            },
          },
        )
      : null;

    GreptimeReconciliationFleetQueue.instance?.on("error", (err) => {
      logger.error("GreptimeReconciliationFleetQueue error", err);
    });

    return GreptimeReconciliationFleetQueue.instance;
  }
}
