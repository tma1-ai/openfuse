import { expect, describe, it, beforeAll } from "vitest";
import {
  createObservation,
  createObservationsGreptime,
  createOrgProjectAndApiKey,
  createTraceScore,
  createScoresGreptime,
  createTrace,
  createTracesGreptime,
  getObservationsForTrace,
  getScoresForTraces,
  getTracesByIds,
  StorageService,
  StorageServiceFactory,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";
import { processClickhouseTraceDelete } from "../features/traces/processClickhouseTraceDelete";
import { env } from "../env";
import { prisma } from "@langfuse/shared/src/db";

describe("trace deletion", () => {
  let mediaStorageService: StorageService;

  beforeAll(() => {
    mediaStorageService = StorageServiceFactory.getInstance({
      accessKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      bucketName: String(env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET),
      endpoint: env.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
    });
  });

  it("should delete all traces, observations, and scores from Clickhouse", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = randomUUID();
    await createTracesGreptime([createTrace({ id: traceId })]);
    await createObservationsGreptime([createObservation({ trace_id: traceId })]);
    await createScoresGreptime([createTraceScore({ trace_id: traceId })]);

    // When
    await processClickhouseTraceDelete("projectId", [traceId]);

    // Then
    const traces = await getTracesByIds([traceId], projectId);
    expect(traces).toHaveLength(0);

    const observations = await getObservationsForTrace({
      traceId,
      projectId,
      includeIO: true,
    });
    expect(observations).toHaveLength(0);

    const scores = await getScoresForTraces({
      projectId,
      traceIds: [traceId],
    });
    expect(scores).toHaveLength(0);
  });

  it("should delete S3 media files for deleted traces", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = randomUUID();
    const observationId = randomUUID();

    await createTracesGreptime([createTrace({ id: traceId, project_id: projectId })]);
    await createObservationsGreptime([
      createObservation({
        id: observationId,
        trace_id: traceId,
        project_id: projectId,
      }),
    ]);

    const fileType = "text/plain";
    const data = "Hello, world!";

    await Promise.all([
      mediaStorageService.uploadFile({
        fileName: `${projectId}/trace-${traceId}.txt`,
        fileType,
        data,
      }),
      mediaStorageService.uploadFile({
        fileName: `${projectId}/observation-${observationId}.txt`,
        fileType,
        data,
      }),
    ]);

    const traceMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: traceMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/trace-${traceId}.txt`,
        bucketName: String(env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId,
        mediaId: traceMediaId,
        field: "test",
      },
    });

    const observationMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: observationMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/observation-${observationId}.txt`,
        bucketName: String(env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    await prisma.observationMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        observationId,
        traceId,
        mediaId: observationMediaId,
        field: "test",
      },
    });

    // When
    await processClickhouseTraceDelete(projectId, [traceId]);

    // Then
    const files = await mediaStorageService.listFiles(projectId);
    expect(files).toHaveLength(0);

    const media = await prisma.media.findMany({
      where: {
        projectId,
      },
    });
    expect(media).toHaveLength(0);

    await expect(
      prisma.traceMedia.findMany({ where: { projectId } }),
    ).resolves.toHaveLength(0);
    await expect(
      prisma.observationMedia.findMany({ where: { projectId } }),
    ).resolves.toHaveLength(0);
  });

  it("should NOT delete S3 media files for deleted traces if referenced by other entity", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId1 = randomUUID();
    const traceId2 = randomUUID();

    await createTracesGreptime([
      createTrace({ id: traceId1, project_id: projectId }),
      createTrace({ id: traceId2, project_id: projectId }),
    ]);

    const fileType = "text/plain";
    const data = "Hello, world!";

    await mediaStorageService.uploadFile({
      fileName: `${projectId}/trace-${traceId1}.txt`,
      fileType,
      data,
    });

    const traceMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: traceMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/trace-${traceId1}.txt`,
        bucketName: String(env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    // Create TWO references to media item
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId: traceId1,
        mediaId: traceMediaId,
        field: "test",
      },
    });
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId: traceId2,
        mediaId: traceMediaId,
        field: "test",
      },
    });

    // When
    await processClickhouseTraceDelete(projectId, [traceId1]);

    // Then
    const files = await mediaStorageService.listFiles(projectId);
    expect(files).toHaveLength(1);

    const media = await prisma.media.findMany({
      where: {
        projectId,
      },
    });
    expect(media).toHaveLength(1);

    const traceMedia = await prisma.traceMedia.findMany({
      where: {
        projectId,
      },
    });
    expect(traceMedia).toHaveLength(1);
  });
});
