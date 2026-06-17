import {
  StorageService,
  StorageServiceFactory,
} from "@langfuse/shared/src/server";
import { env } from "../../env";

/**
 * Singleton storage client for the eval observation blob store.
 * Used by observation-eval scheduling (writes the observation snapshot) and execution (reads it).
 * Reuses the event-upload storage config and supports a local-file backend so no object store is
 * required (LANGFUSE_EVENT_STORAGE_BACKEND="local").
 */
let evalBlobStorageClient: StorageService | null = null;

/**
 * Gets the singleton storage client for eval observation blobs.
 * Creates the client on first call using environment configuration.
 */
export function getEvalBlobStorageClient(): StorageService {
  if (
    env.LANGFUSE_EVENT_STORAGE_BACKEND === "s3" &&
    !env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET
  ) {
    throw new Error(
      "LANGFUSE_S3_EVENT_UPLOAD_BUCKET must be set when LANGFUSE_EVENT_STORAGE_BACKEND is 's3' (used by eval observation blobs).",
    );
  }

  if (!evalBlobStorageClient) {
    evalBlobStorageClient = StorageServiceFactory.getInstance({
      bucketName: env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET ?? "",
      accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_EVENT_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LANGFUSE_S3_EVENT_UPLOAD_SSE,
      awsSseKmsKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID,
      useLocalFileStorage: env.LANGFUSE_EVENT_STORAGE_BACKEND === "local",
      localFileStoragePath: env.LANGFUSE_EVENT_LOCAL_PATH,
    });
  }

  return evalBlobStorageClient;
}
