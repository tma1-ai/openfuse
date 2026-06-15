import { expect, it, describe, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "../env";
import { randomUUID } from "crypto";
import {
  createObservation,
  createObservationsGreptime,
  createTraceScore,
  createScoresGreptime,
  createTrace,
  createTracesGreptime,
  getObservationById,
  getScoreById,
  getTraceById,
  StorageService,
  StorageServiceFactory,
  deleteTracesByProjectId,
  deleteObservationsByProjectId,
  deleteScoresByProjectId,
  deleteEventsByProjectId,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { Job } from "bullmq";
import { projectDeleteProcessor } from "../queues/projectDelete";

describe("ProjectDeletionProcessingJob", () => {
  let storageService: StorageService;
  let s3Prefix: string | null = null;
  const orgId = "seed-org-id";

  beforeAll(() => {
    storageService = StorageServiceFactory.getInstance({
      accessKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      bucketName: String(env.LANGFUSE_S3_MEDIA_UPLOAD_BUCKET),
      endpoint: env.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
    });
  });

  afterEach(async () => {
    // Clean up all files created during this test
    if (!s3Prefix) return;

    const files = await storageService.listFiles(s3Prefix);

    if (files.length == 0) return;

    await storageService.deleteFiles(files.map((f) => f.file));
    s3Prefix = null;
  });

  it("should delete the project record after processing has completed", async () => {
    // Setup
    const projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        orgId,
        name: `Project-${randomUUID()}`,
      },
    });

    // When
    await projectDeleteProcessor({
      data: { payload: { projectId, orgId } },
    } as Job);

    // Then
    const projects = await prisma.project.findMany({
      where: {
        id: projectId,
      },
    });
    expect(projects).toHaveLength(0);
  });

  it("should delete related table data via Prisma dependencies", async () => {
    // Setup
    const projectId = randomUUID();
    const mediaId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        orgId,
        name: `Project-${randomUUID()}`,
      },
    });
    // Create a dummy dataset for the projectId
    await prisma.dataset.create({
      data: {
        id: randomUUID(),
        projectId,
        name: "Dataset",
      },
    });
    await Promise.all([
      prisma.traceMedia.create({
        data: {
          id: randomUUID(),
          projectId,
          traceId: randomUUID(),
          mediaId,
          field: "input",
        },
      }),
      prisma.observationMedia.create({
        data: {
          id: randomUUID(),
          projectId,
          traceId: randomUUID(),
          observationId: randomUUID(),
          mediaId,
          field: "output",
        },
      }),
    ]);

    // When
    await projectDeleteProcessor({
      data: { payload: { projectId, orgId } },
    } as Job);

    // Then
    const datasets = await prisma.dataset.findMany({
      where: {
        projectId,
      },
    });
    expect(datasets).toHaveLength(0);
    await expect(
      prisma.traceMedia.findMany({ where: { projectId } }),
    ).resolves.toHaveLength(0);
    await expect(
      prisma.observationMedia.findMany({ where: { projectId } }),
    ).resolves.toHaveLength(0);
  });

  it("should delete clickhouse event data on project delete", async () => {
    // Setup
    const projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        orgId,
        name: `Project-${randomUUID()}`,
      },
    });

    const baseId = randomUUID();
    await Promise.all([
      createTracesGreptime([
        createTrace({
          id: `${baseId}-trace`,
          project_id: projectId,
        }),
      ]),
      createObservationsGreptime([
        createObservation({
          id: `${baseId}-observation`,
          trace_id: `${baseId}-trace`,
          project_id: projectId,
        }),
      ]),
      createScoresGreptime([
        createTraceScore({
          id: `${baseId}-score`,
          trace_id: `${baseId}-trace`,
          project_id: projectId,
        }),
      ]),
    ]);

    // When
    await projectDeleteProcessor({
      data: { payload: { projectId, orgId } },
    } as Job);

    // Then
    const trace = await getTraceById({
      traceId: `${baseId}-trace`,
      projectId,
    });
    expect(trace).toBeUndefined();
    expect(() =>
      getObservationById({ id: `${baseId}-observation`, projectId }),
    ).rejects.toThrowError("not found");
    const score = await getScoreById({
      projectId,
      scoreId: `${baseId}-score`,
    });
    expect(score).toBeUndefined();
  });

  it("should delete all media assets for the project", async () => {
    // Setup
    const projectId = randomUUID();
    s3Prefix = `${randomUUID()}/`;
    await prisma.project.create({
      data: {
        id: projectId,
        orgId,
        name: `Project-${randomUUID()}`,
      },
    });

    const fileName = `${s3Prefix}${randomUUID()}.txt`;
    const fileType = "text/plain";
    const data = "Hello, world!";

    await storageService.uploadFile({
      fileName,
      fileType,
      data,
    });

    const mediaId = randomUUID();
    const traceId = randomUUID();
    await prisma.media.create({
      data: {
        id: mediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(),
        bucketPath: fileName,
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
        mediaId,
        field: "test",
      },
    });
    await prisma.observationMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId,
        observationId: randomUUID(),
        mediaId,
        field: "test",
      },
    });

    // When
    await projectDeleteProcessor({
      data: { payload: { projectId, orgId } },
    } as Job);

    // Then
    const files = await storageService.listFiles(s3Prefix);
    expect(files.map((file) => file.file)).not.toContain(fileName);

    const media = await prisma.media.findUnique({
      where: { projectId_id: { id: mediaId, projectId } },
    });
    expect(media).toBeNull();

    const traceMedia = await prisma.traceMedia.findFirst({
      where: { mediaId },
    });
    expect(traceMedia).toBeNull();
    const observationMedia = await prisma.observationMedia.findFirst({
      where: { mediaId },
    });
    expect(observationMedia).toBeNull();
  });

  describe("delete functions with hasAny probe", () => {
    it("should return false when no traces exist for project", async () => {
      const emptyProjectId = randomUUID();
      const result = await deleteTracesByProjectId(emptyProjectId);
      expect(result).toBe(false);
    });

    it("should return false when no observations exist for project", async () => {
      const emptyProjectId = randomUUID();
      const result = await deleteObservationsByProjectId(emptyProjectId);
      expect(result).toBe(false);
    });

    it("should return false when no scores exist for project", async () => {
      const emptyProjectId = randomUUID();
      const result = await deleteScoresByProjectId(emptyProjectId);
      expect(result).toBe(false);
    });

    maybeEventsIt(
      "should return false when no events exist for project",
      async () => {
        const emptyProjectId = randomUUID();
        const result = await deleteEventsByProjectId(emptyProjectId);
        expect(result).toBe(false);
      },
    );

    it("should return true and delete when traces exist", async () => {
      const projectId = randomUUID();
      const traceId = randomUUID();

      await createTracesGreptime([
        createTrace({ id: traceId, project_id: projectId }),
      ]);

      const traceBefore = await getTraceById({ traceId, projectId });
      expect(traceBefore).toBeDefined();

      const result = await deleteTracesByProjectId(projectId);
      expect(result).toBe(true);

      const traceAfter = await getTraceById({ traceId, projectId });
      expect(traceAfter).toBeUndefined();
    });

    it("should return true and delete when observations exist", async () => {
      const projectId = randomUUID();
      const traceId = randomUUID();
      const observationId = randomUUID();

      await createObservationsGreptime([
        createObservation({
          id: observationId,
          trace_id: traceId,
          project_id: projectId,
        }),
      ]);

      await expect(
        getObservationById({ id: observationId, projectId }),
      ).toBeDefined();

      const result = await deleteObservationsByProjectId(projectId);
      expect(result).toBe(true);

      await expect(
        getObservationById({ id: observationId, projectId }),
      ).rejects.toThrowError("not found");
    });

    it("should return true and delete when scores exist", async () => {
      const projectId = randomUUID();
      const traceId = randomUUID();
      const scoreId = randomUUID();

      await createScoresGreptime([
        createTraceScore({
          id: scoreId,
          trace_id: traceId,
          project_id: projectId,
        }),
      ]);

      const scoreBefore = await getScoreById({ projectId, scoreId });
      expect(scoreBefore).toBeDefined();

      const result = await deleteScoresByProjectId(projectId);
      expect(result).toBe(true);

      const scoreAfter = await getScoreById({ projectId, scoreId });
      expect(scoreAfter).toBeUndefined();
    });
  });
});
