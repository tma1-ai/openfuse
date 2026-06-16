import {
  BatchExportTableName,
  BatchActionType,
  BatchTableNames,
  BatchActionStatus,
  EvalTargetObject,
  EvalTemplateType,
} from "@langfuse/shared";
import { expect, describe, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { handleBatchActionJob } from "../features/batchAction/handleBatchActionJob";
import {
  getDatabaseReadStreamPaginated,
  getTraceIdentifierStream,
} from "../features/database-read-stream/getDatabaseReadStream";
import {
  createOrgProjectAndApiKey,
  createTraceScore,
  createScoresGreptime,
  createTrace,
  createTracesGreptime,
  getScoresByIds,
  QueueJobs,
  QueueName,
  createDatasetRunItemsGreptime,
  createDatasetRunItem,
  createDatasetItem,
  createNewRedisInstance,
  getQueuePrefix,
  redisQueueRetryOptions,
  TQueueJobTypes,
} from "@langfuse/shared/src/server";

import { prisma } from "@langfuse/shared/src/db";
import { Decimal } from "decimal.js";
import waitForExpect from "wait-for-expect";
import { Queue } from "bullmq";

const withIsolatedCreateEvalQueue = async <T>(
  projectId: string,
  fn: (queue: Queue<TQueueJobTypes[QueueName.CreateEvalQueue]>) => Promise<T>,
) => {
  const queueName = `${QueueName.CreateEvalQueue}-${projectId}-${uuidv4()}`;
  const redis = createNewRedisInstance({
    enableOfflineQueue: false,
    ...redisQueueRetryOptions,
  });
  if (!redis) {
    throw new Error("Redis is not initialized");
  }

  const queue = new Queue<TQueueJobTypes[QueueName.CreateEvalQueue]>(
    queueName,
    {
      connection: redis,
      prefix: getQueuePrefix(queueName),
    },
  );

  try {
    return await fn(queue);
  } finally {
    try {
      await queue.obliterate({ force: true });
    } finally {
      try {
        await queue.close();
      } finally {
        redis.disconnect();
      }
    }
  }
};

const getCreateEvalQueueJobs = async (
  queue: Queue<TQueueJobTypes[QueueName.CreateEvalQueue]>,
) => {
  return await queue.getJobs([
    "waiting",
    "delayed",
    "paused",
    "prioritized",
    "active",
    "completed",
    "failed",
  ]);
};

const waitForCreateEvalQueueJobs = async ({
  queue,
  expectedLength,
}: {
  queue: Queue<TQueueJobTypes[QueueName.CreateEvalQueue]>;
  expectedLength: number;
}) => {
  let jobs: Awaited<ReturnType<typeof getCreateEvalQueueJobs>> = [];

  await waitForExpect(async () => {
    jobs = await getCreateEvalQueueJobs(queue);

    expect(jobs.map((job) => job.data.payload)).toHaveLength(expectedLength);
  }, 15_000);

  return jobs;
};

describe("select all test suite", () => {
  it("should schedule trace deletions via pending_deletions table", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    // Create test traces
    const traceIds = Array.from({ length: 2500 }).map(() => uuidv4());
    const traces = traceIds.map((id) =>
      createTrace({
        project_id: projectId,
        id,
        timestamp: new Date("2024-01-01").getTime(),
      }),
    );

    await createTracesGreptime(traces);

    const selectAllJob = {
      payload: {
        projectId,
        actionId: "trace-delete",
        tableName: BatchExportTableName.Traces,
        query: {
          filter: [],
          orderBy: { column: "id", order: "DESC" },
        },
        cutoffCreatedAt: new Date("2024-01-02"),
      },
    } as any;

    await handleBatchActionJob(selectAllJob);

    // Verify pending_deletions records were created for all traces
    const pendingDeletions = await prisma.pendingDeletion.findMany({
      where: {
        projectId,
        object: "trace",
      },
    });

    expect(pendingDeletions).toHaveLength(2500);
    expect(pendingDeletions.every((pd) => pd.isDeleted === false)).toBe(true);

    // Verify all trace IDs are scheduled for deletion
    const scheduledTraceIds = pendingDeletions.map((pd) => pd.objectId).sort();
    expect(scheduledTraceIds).toEqual(traceIds.sort());
  }, 30000);

  it("should schedule only filtered traces for deletion", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId1 = uuidv4();
    const traceId2 = uuidv4();
    const traces = [
      createTrace({
        project_id: projectId,
        id: traceId1,
        user_id: "user1",
        timestamp: new Date("2024-01-01").getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: traceId2,
        user_id: "user2",
        timestamp: new Date("2024-01-01").getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const selectAllJob = {
      payload: {
        projectId,
        actionId: "trace-delete",
        tableName: BatchExportTableName.Traces,
        query: {
          filter: [
            {
              type: "string",
              operator: "=",
              column: "User ID",
              value: "user1",
            },
          ],
          orderBy: { column: "timestamp", order: "DESC" },
        },
        cutoffCreatedAt: new Date("2024-01-02"),
      },
    } as any;

    await handleBatchActionJob(selectAllJob);

    // Verify only the filtered trace was scheduled for deletion
    const pendingDeletions = await prisma.pendingDeletion.findMany({
      where: {
        projectId,
        object: "trace",
      },
    });

    expect(pendingDeletions).toHaveLength(1);
    expect(pendingDeletions[0].objectId).toBe(traceId1);
    expect(pendingDeletions[0].isDeleted).toBe(false);
  });

  it("should handle score deletions", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const score = createTraceScore({ project_id: projectId });
    await createScoresGreptime([score]);

    // When
    await handleBatchActionJob({
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "score-delete",
        tableName: BatchExportTableName.Scores,
        cutoffCreatedAt: new Date(),
        query: {
          filter: null,
          orderBy: { column: "timestamp", order: "DESC" },
        },
        type: BatchActionType.Delete,
      },
    });

    // Then
    const scores = await getScoresByIds(projectId, [score.id]);
    expect(scores).toHaveLength(0);
  });

  it("should schedule only traces matching search query for deletion", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId1 = uuidv4();
    const traceId2 = uuidv4();
    const traces = [
      createTrace({
        project_id: projectId,
        id: traceId1,
        name: "search-target-trace",
        timestamp: new Date("2024-01-01").getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: traceId2,
        name: "other-trace",
        timestamp: new Date("2024-01-01").getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const selectAllJob = {
      payload: {
        projectId,
        actionId: "trace-delete",
        tableName: BatchExportTableName.Traces,
        query: {
          filter: [],
          orderBy: { column: "timestamp", order: "DESC" },
          searchQuery: "search-target",
          searchType: ["id"],
        },
        cutoffCreatedAt: new Date("2024-01-02"),
        type: BatchActionType.Delete,
      },
    } as any;

    await handleBatchActionJob(selectAllJob);

    // Verify only the matching trace was scheduled for deletion
    const pendingDeletions = await prisma.pendingDeletion.findMany({
      where: {
        projectId,
        object: "trace",
      },
    });

    expect(pendingDeletions).toHaveLength(1);
    expect(pendingDeletions[0].objectId).toBe(traceId1);
    expect(pendingDeletions[0].isDeleted).toBe(false);
  });

  it("should create eval jobs for historic traces", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceTimestamp = new Date("2024-01-01T00:00:00.000Z");
    const cutoffCreatedAt = new Date("2024-01-02T00:00:00.000Z"); // one day later
    const traceId1 = uuidv4();
    const traces = [
      createTrace({
        project_id: projectId,
        id: traceId1,
        user_id: "user1",
        timestamp: traceTimestamp.getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: uuidv4(),
        user_id: "user2",
        timestamp: traceTimestamp.getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const templateId = uuidv4();

    await prisma.evalTemplate.create({
      data: {
        id: templateId,
        projectId,
        name: "test-template",
        version: 1,
        prompt: "Please evaluate toxicity {{input}} {{output}}",
        model: "gpt-3.5-turbo",
        provider: "openai",
        modelParams: {},
        outputDefinition: {
          reasoning: "Please explain your reasoning",
          score: "Please provide a score between 0 and 1",
        },
      },
    });

    const configId = uuidv4();
    await prisma.jobConfiguration.create({
      data: {
        id: configId,
        projectId,
        filter: [
          {
            type: "string",
            value: "1",
            column: "User ID",
            operator: "contains",
          },
        ],
        jobType: "EVAL",
        delay: 0,
        sampling: new Decimal("1"),
        targetObject: EvalTargetObject.TRACE,
        scoreName: "score",
        variableMapping: JSON.parse("[]"),
        evalTemplateId: templateId,
      },
    });

    const payload = {
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "eval-create" as const,
        targetObject: EvalTargetObject.TRACE,
        configId,
        cutoffCreatedAt,
        query: {
          filter: [
            {
              type: "string" as const,
              value: "1",
              column: "User ID",
              operator: "contains" as const,
            },
          ],
          orderBy: {
            column: "timestamp",
            order: "DESC" as const,
          },
        },
      },
    };

    await waitForExpect(async () => {
      const traceStream = await getTraceIdentifierStream({
        projectId,
        cutoffCreatedAt,
        filter: payload.payload.query.filter,
        orderBy: payload.payload.query.orderBy,
      });

      const traceIds: string[] = [];
      for await (const trace of traceStream) {
        traceIds.push(trace.id);
      }

      expect(traceIds).toEqual([traceId1]);
    }, 15_000);

    await withIsolatedCreateEvalQueue(projectId, async (queue) => {
      await handleBatchActionJob(payload, { evalCreatorQueue: queue });

      const jobs = await waitForCreateEvalQueueJobs({
        queue,
        expectedLength: 1,
      });

      const job = jobs[0];

      if (!job) {
        throw new Error("No jobs found");
      }

      expect(job.data.payload.projectId).toBe(projectId);
      expect(job.data.payload.traceId).toBe(traceId1);
      expect(job.data.payload.configId).toBe(configId);
    });
  }, 30_000);

  it("should create eval jobs for historic datasets", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceTimestamp = new Date("2024-01-01T00:00:00.000Z");
    const datasetRunItemTimestamp = new Date("2024-01-01T00:00:00.000Z");
    const cutoffCreatedAt = new Date("2024-01-02T00:00:00.000Z"); // one day later
    const traceId1 = uuidv4();
    const traceId2 = uuidv4();

    const traces = [
      createTrace({
        project_id: projectId,
        id: traceId1,
        user_id: "user1",
        timestamp: traceTimestamp.getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: traceId2,
        user_id: "user2",
        timestamp: traceTimestamp.getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const datasetName = uuidv4();
    const dataset = await prisma.dataset.create({
      data: {
        id: uuidv4(),
        projectId,
        name: datasetName,
      },
    });

    const res1 = await createDatasetItem({
      projectId,
      datasetId: dataset.id,
      input: "Hello, world!",
    });

    const res2 = await createDatasetItem({
      projectId,
      datasetId: dataset.id,
      input: "Hello, world!",
    });

    if (!res1.success || !res2.success) {
      throw new Error("Failed to create dataset item");
    }
    const datasetItem1 = res1.datasetItem;
    const datasetItem2 = res2.datasetItem;

    const runId = uuidv4();

    await prisma.datasetRuns.create({
      data: {
        id: runId,
        datasetId: dataset.id,
        projectId,
        name: "test-run",
      },
    });

    const datasetRunItem1 = createDatasetRunItem({
      id: uuidv4(),
      dataset_item_id: datasetItem1.id,
      project_id: projectId,
      trace_id: traceId1,
      dataset_run_id: runId,
      dataset_id: dataset.id,
      dataset_run_created_at: datasetRunItemTimestamp.getTime(),
      created_at: datasetRunItemTimestamp.getTime(),
      updated_at: datasetRunItemTimestamp.getTime(),
      event_ts: datasetRunItemTimestamp.getTime(),
    });

    const datasetRunItem2 = createDatasetRunItem({
      id: uuidv4(),
      dataset_item_id: datasetItem2.id,
      project_id: projectId,
      trace_id: traceId2,
      dataset_run_id: runId,
      dataset_id: dataset.id,
      dataset_run_created_at: datasetRunItemTimestamp.getTime(),
      created_at: datasetRunItemTimestamp.getTime(),
      updated_at: datasetRunItemTimestamp.getTime(),
      event_ts: datasetRunItemTimestamp.getTime(),
    });

    await createDatasetRunItemsGreptime([datasetRunItem1, datasetRunItem2]);

    const templateId = uuidv4();

    await prisma.evalTemplate.create({
      data: {
        id: templateId,
        projectId,
        name: "test-template",
        version: 1,
        prompt: "Please evaluate toxicity {{input}} {{output}}",
        model: "gpt-3.5-turbo",
        provider: "openai",
        modelParams: {},
        outputDefinition: {
          reasoning: "Please explain your reasoning",
          score: "Please provide a score between 0 and 1",
        },
      },
    });

    const configId = uuidv4();
    await prisma.jobConfiguration.create({
      data: {
        id: configId,
        projectId,
        filter: [
          {
            type: "stringOptions" as const,
            value: [dataset.id],
            column: "Dataset",
            operator: "any of" as const,
          },
        ],
        jobType: "EVAL",
        delay: 0,
        sampling: new Decimal("1"),
        targetObject: EvalTargetObject.DATASET,
        scoreName: "score",
        variableMapping: JSON.parse("[]"),
        evalTemplateId: templateId,
      },
    });

    const payload = {
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "eval-create" as const,
        targetObject: EvalTargetObject.DATASET,
        configId,
        cutoffCreatedAt,
        query: {
          filter: [
            {
              type: "stringOptions" as const,
              value: [dataset.id],
              column: "Dataset",
              operator: "any of" as const,
            },
          ],
          orderBy: {
            column: "timestamp",
            order: "DESC" as const,
          },
        },
      },
    };

    await waitForExpect(async () => {
      const dbReadStream = await getDatabaseReadStreamPaginated({
        projectId,
        cutoffCreatedAt,
        filter: payload.payload.query.filter,
        orderBy: payload.payload.query.orderBy,
        tableName: BatchTableNames.DatasetRunItems,
      });

      const datasetRunItems: unknown[] = [];
      for await (const item of dbReadStream) {
        datasetRunItems.push(item);
      }

      expect(datasetRunItems).toHaveLength(2);
    }, 15_000);

    await withIsolatedCreateEvalQueue(projectId, async (queue) => {
      await handleBatchActionJob(payload, { evalCreatorQueue: queue });

      const jobs = await waitForCreateEvalQueueJobs({
        queue,
        expectedLength: 2,
      });

      const jobTraceIds = jobs.map((job) => job.data.payload.traceId);
      expect(jobTraceIds).toContain(traceId1);
      expect(jobTraceIds).toContain(traceId2);

      const jobDatasetIds = jobs.map((job) => job.data.payload.datasetItemId);
      expect(jobDatasetIds).toContain(datasetItem1.id);
      expect(jobDatasetIds).toContain(datasetItem2.id);
      const configIds = jobs.map((job) => job.data.payload.configId);
      expect(configIds).toContain(configId);
    });
  }, 30_000);

  it("should not create evals if config does not exist", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    // Create a trace
    const traceId = uuidv4();
    const traceTimestamp = new Date("2024-01-01T00:00:00.000Z");
    await createTracesGreptime([
      createTrace({
        project_id: projectId,
        id: traceId,
        timestamp: traceTimestamp.getTime(),
      }),
    ]);

    // Use a non-existent config ID
    const nonExistentConfigId = uuidv4();

    const payload = {
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "eval-create" as const,
        targetObject: EvalTargetObject.TRACE,
        configId: nonExistentConfigId,
        cutoffCreatedAt: new Date("2024-01-02T00:00:00.000Z"),
        query: {
          filter: [],
          orderBy: {
            column: "timestamp",
            order: "DESC" as const,
          },
        },
      },
    };

    await withIsolatedCreateEvalQueue(projectId, async (queue) => {
      await expect(
        handleBatchActionJob(payload, { evalCreatorQueue: queue }),
      ).resolves.not.toThrow();

      const jobs = await waitForCreateEvalQueueJobs({
        queue,
        expectedLength: 0,
      });

      expect(jobs).toHaveLength(0);
    });
  });

  it("should skip legacy eval-create for code eval templates", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = uuidv4();
    const traceTimestamp = new Date("2024-01-01T00:00:00.000Z");
    await createTracesGreptime([
      createTrace({
        project_id: projectId,
        id: traceId,
        timestamp: traceTimestamp.getTime(),
      }),
    ]);

    const templateId = uuidv4();
    await prisma.evalTemplate.create({
      data: {
        id: templateId,
        projectId,
        name: "test-code-template",
        version: 1,
        type: EvalTemplateType.CODE,
        sourceCode: "return { score: 1 };",
        modelParams: {},
      },
    });

    const configId = uuidv4();
    await prisma.jobConfiguration.create({
      data: {
        id: configId,
        projectId,
        filter: [],
        jobType: "EVAL",
        delay: 0,
        sampling: new Decimal("1"),
        targetObject: EvalTargetObject.TRACE,
        scoreName: "score",
        variableMapping: JSON.parse("[]"),
        evalTemplateId: templateId,
      },
    });

    const payload = {
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "eval-create" as const,
        targetObject: EvalTargetObject.TRACE,
        configId,
        cutoffCreatedAt: new Date("2024-01-02T00:00:00.000Z"),
        query: {
          filter: [],
          orderBy: {
            column: "timestamp",
            order: "DESC" as const,
          },
        },
      },
    };

    await withIsolatedCreateEvalQueue(projectId, async (queue) => {
      await handleBatchActionJob(payload, { evalCreatorQueue: queue });

      const jobs = await waitForCreateEvalQueueJobs({
        queue,
        expectedLength: 0,
      });

      expect(jobs).toHaveLength(0);
    });
  });

  it("should add traces to annotation queue", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId1 = uuidv4();
    const traceId2 = uuidv4();
    const traces = [
      createTrace({
        project_id: projectId,
        id: traceId1,
        timestamp: new Date("2024-01-01").getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: traceId2,
        timestamp: new Date("2024-01-01").getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const queueId = uuidv4();
    await prisma.annotationQueue.create({
      data: {
        id: queueId,
        projectId,
        name: "test-queue",
      },
    });

    await handleBatchActionJob({
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "trace-add-to-annotation-queue" as const,
        tableName: BatchExportTableName.Traces,
        cutoffCreatedAt: new Date("2024-01-02"),
        targetId: queueId,
        query: { filter: [], orderBy: { column: "timestamp", order: "DESC" } },
        type: BatchActionType.Create,
      },
    });

    const queueItems = await prisma.annotationQueueItem.findMany({
      where: { queueId, projectId },
    });

    expect(queueItems).toHaveLength(2);
    const objectIds = queueItems.map((item) => item.objectId);
    expect(objectIds).toContain(traceId1);
    expect(objectIds).toContain(traceId2);
    expect(queueItems.every((item) => item.objectType === "TRACE")).toBe(true);
  });

  it("should add sessions to annotation queue", async () => {
    const { projectId } = await createOrgProjectAndApiKey();

    const sessionId1 = uuidv4();
    const sessionId2 = uuidv4();

    // Create traces with sessions
    const traces = [
      createTrace({
        project_id: projectId,
        id: uuidv4(),
        session_id: sessionId1,
        timestamp: new Date("2024-01-01").getTime(),
      }),
      createTrace({
        project_id: projectId,
        id: uuidv4(),
        session_id: sessionId2,
        timestamp: new Date("2024-01-01").getTime(),
      }),
    ];

    await createTracesGreptime(traces);

    const queueId = uuidv4();
    await prisma.annotationQueue.create({
      data: {
        id: queueId,
        projectId,
        name: "test-queue",
      },
    });

    await handleBatchActionJob({
      id: uuidv4(),
      timestamp: new Date(),
      name: QueueJobs.BatchActionProcessingJob as const,
      payload: {
        projectId,
        actionId: "session-add-to-annotation-queue" as const,
        tableName: BatchExportTableName.Sessions,
        cutoffCreatedAt: new Date("2024-01-02"),
        targetId: queueId,
        query: { filter: [], orderBy: { column: "createdAt", order: "DESC" } },
        type: BatchActionType.Create,
      },
    });

    const queueItems = await prisma.annotationQueueItem.findMany({
      where: { queueId, projectId },
    });

    expect(queueItems).toHaveLength(2);
    const objectIds = queueItems.map((item) => item.objectId);
    expect(objectIds).toContain(sessionId1);
    expect(objectIds).toContain(sessionId2);
    expect(queueItems.every((item) => item.objectType === "SESSION")).toBe(
      true,
    );
  });
});
