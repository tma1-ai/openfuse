import { QueueName, TQueueJobTypes } from "../queues";
import { Queue } from "bullmq";
import { createBullMQQueueOptionsWithRedis } from "./redis";
import { logger } from "../logger";

export class GreptimeReconciliationQueue {
  private static instance: Queue<
    TQueueJobTypes[QueueName.GreptimeReconciliation]
  > | null = null;

  public static getInstance(): Queue<
    TQueueJobTypes[QueueName.GreptimeReconciliation]
  > | null {
    if (GreptimeReconciliationQueue.instance)
      return GreptimeReconciliationQueue.instance;

    const queueOptionsWithRedis = createBullMQQueueOptionsWithRedis(
      QueueName.GreptimeReconciliation,
    );
    GreptimeReconciliationQueue.instance = queueOptionsWithRedis
      ? new Queue<TQueueJobTypes[QueueName.GreptimeReconciliation]>(
          QueueName.GreptimeReconciliation,
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

    GreptimeReconciliationQueue.instance?.on("error", (err) => {
      logger.error("GreptimeReconciliationQueue error", err);
    });

    return GreptimeReconciliationQueue.instance;
  }
}
