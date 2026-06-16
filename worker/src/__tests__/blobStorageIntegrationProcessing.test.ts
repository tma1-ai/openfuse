import {
  expect,
  it,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";

const originalCloudRegion = vi.hoisted(() => {
  const cloudRegion = process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION;
  delete process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION;
  return cloudRegion;
});

import { env } from "../env";
import { randomUUID } from "crypto";
import {
  createObservation,
  createObservationsGreptime,
  createOrgProjectAndApiKey,
  createTraceScore,
  createSessionScore,
  createDatasetRunScore,
  createScoresGreptime,
  createTrace,
  createTracesGreptime,
  StorageService,
  StorageServiceFactory,
} from "@langfuse/shared/src/server";

import { prisma } from "@langfuse/shared/src/db";
import { Job } from "bullmq";
import {
  handleBlobStorageIntegrationProjectJob,
  BLOB_STORAGE_LAG_BUFFER_MS,
} from "../features/blobstorage/handleBlobStorageIntegrationProjectJob";
import {
  BlobStorageIntegrationType,
  BlobStorageIntegrationFileType,
} from "@langfuse/shared";
import { encrypt } from "@langfuse/shared/encryption";

// Skip tests that use Azurite in Azure mode due to known Azurite limitations
// with multipart uploads. These tests use MinIO explicitly or are skipped.
// Unfortunately, this is necessary as we don't have a good way to skip empty file uploads
// and at least azurite doesn't handle them gracefully.
const maybeIt = env.LANGFUSE_USE_AZURE_BLOB === "true" ? it.skip : it;

describe("BlobStorageIntegrationProcessingJob", () => {
  let storageService: StorageService;
  let s3StorageService: StorageService;
  let s3Prefix: string | null = null;
  const bucketName = env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET || "";
  const accessKeyId = env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID || "";
  const secretAccessKey = env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY || "";
  const endpoint = env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT || undefined;
  const region = env.LANGFUSE_S3_EVENT_UPLOAD_REGION || undefined;
  const minioAccessKeyId = "minio";
  const minioAccessKeySecret = "miniosecret";
  const minioEndpoint = "http://localhost:9090";

  beforeAll(async () => {
    storageService = StorageServiceFactory.getInstance({
      accessKeyId,
      secretAccessKey,
      bucketName,
      endpoint,
      region,
      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
    });
    s3StorageService = StorageServiceFactory.getInstance({
      accessKeyId: minioAccessKeyId,
      secretAccessKey: minioAccessKeySecret,
      bucketName,
      endpoint: minioEndpoint,
      region,
      forcePathStyle: true,
      useAzureBlob: false,
    });
  });

  afterAll(() => {
    if (originalCloudRegion) {
      process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION = originalCloudRegion;
    } else {
      delete process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION;
    }
  });

  afterEach(async () => {
    // Clean up all files created during this test
    if (!s3Prefix) return;

    const files = await s3StorageService.listFiles(s3Prefix);

    if (files.length == 0) return;

    await s3StorageService.deleteFiles(files.map((f) => f.file));
    s3Prefix = null;
  });

  it("should not process when blob storage integration is disabled", async () => {
    const { projectId } = await createOrgProjectAndApiKey();
    s3Prefix = projectId;

    // Setup an integration but disabled
    await prisma.blobStorageIntegration.create({
      data: {
        projectId,
        type: BlobStorageIntegrationType.S3,
        bucketName,
        prefix: s3Prefix,
        accessKeyId,
        secretAccessKey: encrypt(secretAccessKey),
        region: region ? region : "auto",
        endpoint: endpoint ? endpoint : null,
        forcePathStyle:
          env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
        enabled: false,
        exportFrequency: "hourly",
        compressed: false,
      },
    });

    // When
    await handleBlobStorageIntegrationProjectJob({
      data: { payload: { projectId } },
    } as Job);

    // Then
    const files = await storageService.listFiles(s3Prefix);
    expect(files.filter((f) => f.file.includes(projectId))).toHaveLength(0);
  });
  describe("legacy observations export field groups", () => {
    it("should exclude columns for deselected exportFieldGroups in the legacy observations export", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      s3Prefix = projectId;
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const dataTime = now.getTime() - 90 * 60 * 1000;

      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          type: BlobStorageIntegrationType.S3,
          bucketName,
          prefix: s3Prefix,
          accessKeyId: minioAccessKeyId,
          secretAccessKey: encrypt(minioAccessKeySecret),
          region: region ? region : "auto",
          endpoint: minioEndpoint,
          forcePathStyle:
            env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
          enabled: true,
          exportFrequency: "hourly",
          exportSource: "TRACES_OBSERVATIONS",
          exportFieldGroups: ["core", "io"],
          nextSyncAt: twoHoursAgo,
          lastSyncAt: twoHoursAgo,
          compressed: false,
          fileType: BlobStorageIntegrationFileType.JSONL,
        },
      });

      const traceId = randomUUID();
      await createObservationsGreptime([
        createObservation({
          id: randomUUID(),
          trace_id: traceId,
          project_id: projectId,
          start_time: dataTime,
          end_time: dataTime + 5000,
          name: "Legacy Observation",
          metadata: { secret: "should-not-appear" },
          usage_details: { input: 100, output: 200, total: 300 },
        }),
      ]);

      await handleBlobStorageIntegrationProjectJob({
        data: { payload: { projectId } },
      } as Job);

      const files = await s3StorageService.listFiles(s3Prefix);
      const observationFile = files.find((f) =>
        f.file.includes("/observations/"),
      );
      expect(observationFile).toBeDefined();

      if (observationFile) {
        const content = await s3StorageService.download(observationFile.file);
        const row = JSON.parse(content.trim().split("\n")[0]);

        // core + io fields should be present
        expect(row).toHaveProperty("id");
        expect(row).toHaveProperty("trace_id");
        expect(row).toHaveProperty("input");
        expect(row).toHaveProperty("output");

        // metadata group not selected → must not leak
        expect(row).not.toHaveProperty("metadata");

        // metrics group not selected → computed fields must not appear
        expect(row).not.toHaveProperty("latency");
        expect(row).not.toHaveProperty("time_to_first_token");

        // model group not selected → no model id or pricing enrichment
        expect(row).not.toHaveProperty("model_id");
        expect(row).not.toHaveProperty("input_price");

        // other non-selected groups must not appear
        expect(row).not.toHaveProperty("name");
        expect(row).not.toHaveProperty("level");
        expect(row).not.toHaveProperty("usage_details");
      }
    });
  });

  describe("BlobStorageExportMode minTimestamp behavior", () => {
    maybeIt(
      "should export old data for FULL_HISTORY mode when data exists",
      async () => {
        const { projectId } = await createOrgProjectAndApiKey();
        s3Prefix = projectId;

        // Create trace with old timestamp that's far enough in the past
        // but not so old that it might not be found by ClickHouse
        const now = new Date();
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const oldTrace = createTrace({
          project_id: projectId,
          timestamp: twoDaysAgo.getTime(),
          name: "Old Trace",
        });
        await createTracesGreptime([oldTrace]);

        // Create integration with FULL_HISTORY mode and no lastSyncAt
        await prisma.blobStorageIntegration.create({
          data: {
            projectId,
            type: BlobStorageIntegrationType.S3,
            bucketName,
            prefix: s3Prefix,
            accessKeyId,
            secretAccessKey: encrypt(secretAccessKey),
            region: region ? region : "auto",
            endpoint: endpoint ? endpoint : null,
            forcePathStyle:
              env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
            enabled: true,
            exportFrequency: "hourly",
            exportMode: "FULL_HISTORY",
            exportStartDate: null,
            lastSyncAt: null, // First export
            compressed: false,
          },
        });

        await handleBlobStorageIntegrationProjectJob({
          data: { payload: { projectId } },
        } as Job);

        // If data was found and exported, check the files
        const files = await storageService.listFiles(s3Prefix);
        const projectFiles = files.filter((f) => f.file.includes(projectId));

        // With FULL_HISTORY mode, if the ClickHouse query finds the old data,
        // it should export starting from that timestamp
        if (projectFiles.length > 0) {
          const traceFile = projectFiles.find((f) =>
            f.file.includes("/traces/"),
          );
          expect(traceFile).toBeDefined();

          if (traceFile) {
            const content = await storageService.download(traceFile.file);
            expect(content).toContain(oldTrace.id);
          }
        }

        // Verify integration was updated if export happened
        const updatedIntegration =
          await prisma.blobStorageIntegration.findUnique({
            where: { projectId },
          });

        // If files were exported, lastSyncAt should be set
        if (projectFiles.length > 0) {
          expect(updatedIntegration?.lastSyncAt).toBeDefined();
        }
      },
    );

    it("should use current date for FROM_TODAY mode on first export", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      s3Prefix = projectId;
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const veryOldTrace = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

      // Create traces from different time periods
      const oldTrace = createTrace({
        project_id: projectId,
        timestamp: yesterday.getTime(),
        name: "Old Trace",
      });
      const veryOldTraceObj = createTrace({
        project_id: projectId,
        timestamp: veryOldTrace.getTime(),
        name: "Very Old Trace",
      });
      await createTracesGreptime([oldTrace, veryOldTraceObj]);

      // Create integration with FROM_TODAY mode
      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          type: BlobStorageIntegrationType.S3,
          bucketName,
          prefix: s3Prefix,
          accessKeyId,
          secretAccessKey: encrypt(secretAccessKey),
          region: region ? region : "auto",
          endpoint: endpoint ? endpoint : null,
          forcePathStyle:
            env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
          enabled: true,
          exportFrequency: "hourly",
          exportMode: "FROM_TODAY" as any,
          exportStartDate: new Date(), // Use current date
          lastSyncAt: null, // First export
          compressed: false,
        },
      });

      await handleBlobStorageIntegrationProjectJob({
        data: { payload: { projectId } },
      } as Job);

      const files = await storageService.listFiles(s3Prefix);
      const projectFiles = files.filter((f) => f.file.includes(projectId));
      const traceFile = projectFiles.find((f) => f.file.includes("/traces/"));

      // On azure the empty file is not created, for others we proceed to check that it's empty.
      if (traceFile) {
        const content = await storageService.download(traceFile.file);
        // With FROM_TODAY mode and a current exportStartDate, the minTimestamp is set to the provided date (current time)
        // which means only traces within the last 30 minutes would be exported
        // Our test traces are older, so content should be empty or not contain old traces
        expect(content).not.toContain(oldTrace.id);
        expect(content).not.toContain(veryOldTraceObj.id);
      }
    });

    it("should use custom date for FROM_CUSTOM_DATE mode on first export", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      s3Prefix = projectId;
      const now = new Date();
      const customDate = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12 hours ago
      const beforeCustomDate = new Date(customDate.getTime() - 60 * 60 * 1000); // 13 hours ago
      // With chunking, first export covers customDate to customDate + 1 hour
      // So we need data within that first hour window
      const afterCustomDate = new Date(customDate.getTime() + 30 * 60 * 1000); // 30 minutes after custom date

      // Create traces before and after custom date
      const oldTrace = createTrace({
        project_id: projectId,
        timestamp: beforeCustomDate.getTime(),
        name: "Before Custom Date Trace",
      });
      const recentTrace = createTrace({
        project_id: projectId,
        timestamp: afterCustomDate.getTime(),
        name: "After Custom Date Trace",
      });
      await createTracesGreptime([oldTrace, recentTrace]);

      // Create integration with FROM_CUSTOM_DATE mode
      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          type: BlobStorageIntegrationType.S3,
          bucketName,
          prefix: s3Prefix,
          accessKeyId: minioAccessKeyId,
          secretAccessKey: encrypt(minioAccessKeySecret),
          region: region ? region : "auto",
          endpoint: minioEndpoint,
          forcePathStyle:
            env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
          enabled: true,
          exportFrequency: "hourly",
          exportMode: "FROM_CUSTOM_DATE" as any,
          exportStartDate: customDate,
          lastSyncAt: null, // First export
          compressed: false,
        },
      });

      await handleBlobStorageIntegrationProjectJob({
        data: { payload: { projectId } },
      } as Job);

      const files = await s3StorageService.listFiles(s3Prefix);
      const projectFiles = files.filter((f) => f.file.includes(projectId));
      const traceFile = projectFiles.find((f) => f.file.includes("/traces/"));

      expect(traceFile).toBeDefined();

      // Should only include traces from custom date onwards
      if (traceFile) {
        const content = await s3StorageService.download(traceFile.file);
        expect(content).not.toContain(oldTrace.id);
        expect(content).toContain(recentTrace.id);
      }
    });
  });

  describe("Chunked historic exports", () => {
    maybeIt(
      "should cap maxTimestamp to one frequency period ahead for FULL_HISTORY mode",
      async () => {
        const { projectId } = await createOrgProjectAndApiKey();
        s3Prefix = projectId;
        const now = new Date();
        const veryOldTimestamp = new Date(
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ); // 7 days ago

        // Create trace from 7 days ago
        const oldTrace = createTrace({
          project_id: projectId,
          timestamp: veryOldTimestamp.getTime(),
          name: "Old Trace",
        });
        await createTracesGreptime([oldTrace]);

        // Create integration with FULL_HISTORY and hourly frequency (first export)
        await prisma.blobStorageIntegration.create({
          data: {
            projectId,
            type: BlobStorageIntegrationType.S3,
            bucketName,
            prefix: s3Prefix,
            accessKeyId,
            secretAccessKey: encrypt(secretAccessKey),
            region: region ? region : "auto",
            endpoint: endpoint ? endpoint : null,
            forcePathStyle:
              env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
            enabled: true,
            exportFrequency: "hourly",
            exportMode: "FULL_HISTORY",
            exportStartDate: null,
            lastSyncAt: null,
            compressed: false,
          },
        });

        // When
        await handleBlobStorageIntegrationProjectJob({
          data: { payload: { projectId } },
        } as Job);

        // Then
        const updatedIntegration =
          await prisma.blobStorageIntegration.findUnique({
            where: { projectId },
          });

        expect(updatedIntegration).toBeDefined();

        // Check if files were exported (meaning data was found)
        const files = await storageService.listFiles(s3Prefix);
        const projectFiles = files.filter((f) => f.file.includes(projectId));

        // If data was found and exported, verify chunking behavior
        if (projectFiles.length > 0 && updatedIntegration?.lastSyncAt) {
          // When ClickHouse finds the old data, it should start from that timestamp
          // and cap the export to 1 hour (frequency interval)
          // lastSyncAt should be capped to 1 hour after the found timestamp
          const minExpectedTime = veryOldTimestamp.getTime();
          const maxExpectedTime = veryOldTimestamp.getTime() + 60 * 60 * 1000; // +1 hour
          const tolerance = 2000; // 2 second tolerance

          expect(
            updatedIntegration.lastSyncAt.getTime(),
          ).toBeGreaterThanOrEqual(minExpectedTime);
          expect(updatedIntegration.lastSyncAt.getTime()).toBeLessThanOrEqual(
            maxExpectedTime + tolerance,
          );
        }
        // If no data was found (fallback to current time), the time window would be invalid
        // and no export would happen, which is acceptable behavior
      },
    );

    it("should immediately schedule next chunk when in catch-up mode", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      s3Prefix = projectId;
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      // Create traces over 2 days
      const trace1 = createTrace({
        project_id: projectId,
        timestamp: twoDaysAgo.getTime(),
        name: "Old Trace 1",
      });
      const trace2 = createTrace({
        project_id: projectId,
        timestamp: twoDaysAgo.getTime() + 60 * 60 * 1000, // 1 hour later
        name: "Old Trace 2",
      });
      await createTracesGreptime([trace1, trace2]);

      // Create integration with hourly frequency starting 2 days ago
      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          type: BlobStorageIntegrationType.S3,
          bucketName,
          prefix: s3Prefix,
          accessKeyId: minioAccessKeyId,
          secretAccessKey: encrypt(minioAccessKeySecret),
          region: region ? region : "auto",
          endpoint: minioEndpoint,
          forcePathStyle:
            env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
          enabled: true,
          exportFrequency: "hourly",
          lastSyncAt: twoDaysAgo, // Start from 2 days ago
          compressed: false,
        },
      });

      // When
      await handleBlobStorageIntegrationProjectJob({
        data: { payload: { projectId } },
      } as Job);

      // Then
      const updatedIntegration = await prisma.blobStorageIntegration.findUnique(
        {
          where: { projectId },
        },
      );

      expect(updatedIntegration).toBeDefined();
      if (!updatedIntegration?.nextSyncAt) {
        expect.fail("nextSyncAt should be set");
      }

      // nextSyncAt should be immediate (within a few seconds of now)
      const timeDiff = Math.abs(
        updatedIntegration.nextSyncAt.getTime() - now.getTime(),
      );
      expect(timeDiff).toBeLessThan(5000); // Within 5 seconds
    });

    it("should schedule normally when caught up", async () => {
      const { projectId } = await createOrgProjectAndApiKey();
      s3Prefix = projectId;
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Create recent trace
      const trace = createTrace({
        project_id: projectId,
        timestamp: now.getTime() - 40 * 60 * 1000, // 40 minutes ago
        name: "Recent Trace",
      });
      await createTracesGreptime([trace]);

      // Create integration with lastSyncAt 1 hour ago (within normal range)
      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          type: BlobStorageIntegrationType.S3,
          bucketName,
          prefix: s3Prefix,
          accessKeyId: minioAccessKeyId,
          secretAccessKey: encrypt(minioAccessKeySecret),
          region: region ? region : "auto",
          endpoint: minioEndpoint,
          forcePathStyle:
            env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
          enabled: true,
          exportFrequency: "hourly",
          lastSyncAt: oneHourAgo,
          compressed: false,
        },
      });

      // When
      await handleBlobStorageIntegrationProjectJob({
        data: { payload: { projectId } },
      } as Job);

      // Then
      const updatedIntegration = await prisma.blobStorageIntegration.findUnique(
        {
          where: { projectId },
        },
      );

      expect(updatedIntegration).toBeDefined();
      if (!updatedIntegration?.nextSyncAt || !updatedIntegration?.lastSyncAt) {
        expect.fail("nextSyncAt and lastSyncAt should be set");
      }

      // nextSyncAt should be 1 hour after lastSyncAt (normal scheduling)
      const expectedNextSync = new Date(
        updatedIntegration.lastSyncAt.getTime() + 60 * 60 * 1000,
      );
      const tolerance = 1000; // 1 second tolerance

      expect(
        Math.abs(
          updatedIntegration.nextSyncAt.getTime() - expectedNextSync.getTime(),
        ),
      ).toBeLessThan(tolerance);

      // nextSyncAt should be in the future
      expect(updatedIntegration.nextSyncAt.getTime()).toBeGreaterThan(
        now.getTime(),
      );
    });
  });

  describe("gzip compression", () => {
    maybeIt(
      "should produce .csv.gz files when compressed is true",
      async () => {
        const { projectId } = await createOrgProjectAndApiKey();
        s3Prefix = `${projectId}/`;
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        await prisma.blobStorageIntegration.create({
          data: {
            projectId,
            type: BlobStorageIntegrationType.S3,
            bucketName,
            prefix: s3Prefix,
            accessKeyId: minioAccessKeyId,
            secretAccessKey: encrypt(minioAccessKeySecret),
            region: region ? region : "auto",
            endpoint: minioEndpoint,
            forcePathStyle:
              env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
            enabled: true,
            exportFrequency: "hourly",
            fileType: BlobStorageIntegrationFileType.CSV,
            compressed: true,
            lastSyncAt: oneHourAgo,
          },
        });

        const traceId = randomUUID();
        await createTracesGreptime([
          createTrace({
            id: traceId,
            project_id: projectId,
            timestamp: now.getTime() - 40 * 60 * 1000,
            name: "Compressed Trace",
          }),
        ]);

        await handleBlobStorageIntegrationProjectJob({
          data: { payload: { projectId } },
        } as Job);

        const files = await s3StorageService.listFiles(s3Prefix);
        const projectFiles = files.filter((f) => f.file.includes(projectId));

        expect(projectFiles.length).toBeGreaterThan(0);
        expect(projectFiles.every((f) => f.file.endsWith(".csv.gz"))).toBe(
          true,
        );
      },
    );

    maybeIt(
      "should produce plain .csv files when compressed is false",
      async () => {
        const { projectId } = await createOrgProjectAndApiKey();
        s3Prefix = `${projectId}/`;
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        await prisma.blobStorageIntegration.create({
          data: {
            projectId,
            type: BlobStorageIntegrationType.S3,
            bucketName,
            prefix: s3Prefix,
            accessKeyId: minioAccessKeyId,
            secretAccessKey: encrypt(minioAccessKeySecret),
            region: region ? region : "auto",
            endpoint: minioEndpoint,
            forcePathStyle:
              env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
            enabled: true,
            exportFrequency: "hourly",
            fileType: BlobStorageIntegrationFileType.CSV,
            compressed: false,
            lastSyncAt: oneHourAgo,
          },
        });

        const traceId = randomUUID();
        await createTracesGreptime([
          createTrace({
            id: traceId,
            project_id: projectId,
            timestamp: now.getTime() - 40 * 60 * 1000,
            name: "Uncompressed Trace",
          }),
        ]);

        await handleBlobStorageIntegrationProjectJob({
          data: { payload: { projectId } },
        } as Job);

        const files = await s3StorageService.listFiles(s3Prefix);
        const projectFiles = files.filter((f) => f.file.includes(projectId));

        expect(projectFiles.length).toBeGreaterThan(0);
        expect(
          projectFiles.every(
            (f) => f.file.endsWith(".csv") && !f.file.endsWith(".csv.gz"),
          ),
        ).toBe(true);

        // Verify content is plain text (readable)
        const traceFile = projectFiles.find((f) => f.file.includes("/traces/"));
        if (traceFile) {
          const content = await s3StorageService.download(traceFile.file);
          expect(content).toContain(traceId);
          expect(content).toContain("Uncompressed Trace");
        }
      },
    );

    maybeIt(
      "should produce .jsonl.gz files when compressed with JSONL format",
      async () => {
        const { projectId } = await createOrgProjectAndApiKey();
        s3Prefix = `${projectId}/`;
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        await prisma.blobStorageIntegration.create({
          data: {
            projectId,
            type: BlobStorageIntegrationType.S3,
            bucketName,
            prefix: s3Prefix,
            accessKeyId: minioAccessKeyId,
            secretAccessKey: encrypt(minioAccessKeySecret),
            region: region ? region : "auto",
            endpoint: minioEndpoint,
            forcePathStyle:
              env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
            enabled: true,
            exportFrequency: "hourly",
            fileType: BlobStorageIntegrationFileType.JSONL,
            compressed: true,
            lastSyncAt: oneHourAgo,
          },
        });

        const traceId = randomUUID();
        await createTracesGreptime([
          createTrace({
            id: traceId,
            project_id: projectId,
            timestamp: now.getTime() - 40 * 60 * 1000,
            name: "JSONL Compressed Trace",
          }),
        ]);

        await handleBlobStorageIntegrationProjectJob({
          data: { payload: { projectId } },
        } as Job);

        const files = await s3StorageService.listFiles(s3Prefix);
        const projectFiles = files.filter((f) => f.file.includes(projectId));

        expect(projectFiles.length).toBeGreaterThan(0);
        expect(projectFiles.every((f) => f.file.endsWith(".jsonl.gz"))).toBe(
          true,
        );
      },
    );
  });
});
