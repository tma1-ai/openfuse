import { Job, Processor } from "bullmq";
import { QueueName, TQueueJobTypes } from "@langfuse/shared/src/server";

import { handleGreptimeReconciliation } from "../features/greptime-reconciliation/handleGreptimeReconciliation";

export const greptimeReconciliationProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.GreptimeReconciliation]>,
): Promise<void> => {
  await handleGreptimeReconciliation(job.data.payload);
};
