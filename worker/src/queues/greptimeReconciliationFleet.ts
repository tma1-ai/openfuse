import { Job, Processor } from "bullmq";
import { QueueName, TQueueJobTypes } from "@langfuse/shared/src/server";

import { handleGreptimeReconciliationFleet } from "../features/greptime-reconciliation/handleGreptimeReconciliationFleet";

export const greptimeReconciliationFleetProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.GreptimeReconciliationFleet]>,
): Promise<void> => {
  await handleGreptimeReconciliationFleet(job.data.payload);
};
