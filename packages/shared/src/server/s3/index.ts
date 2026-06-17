import { env } from "../../env";
import {
  StorageService,
  StorageServiceFactory,
} from "../services/StorageService";

let s3MediaStorageClient: StorageService;
let s3EventStorageClient: StorageService;

export const getS3MediaStorageClient = (bucketName: string): StorageService => {
  if (!s3MediaStorageClient) {
    s3MediaStorageClient = StorageServiceFactory.getInstance({
      bucketName,
      accessKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LANGFUSE_S3_MEDIA_UPLOAD_SSE,
      awsSseKmsKeyId: env.LANGFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID,
      useLocalFileStorage: env.LANGFUSE_MEDIA_STORAGE_BACKEND === "local",
      localFileStoragePath: env.LANGFUSE_MEDIA_LOCAL_PATH,
    });
  }
  return s3MediaStorageClient;
};

export const getS3EventStorageClient = (
  bucketName: string | undefined,
): StorageService => {
  if (!bucketName) {
    // The event bucket is optional now that ingestion uses GreptimeDB raw_events. The only
    // remaining consumer of this S3 client is OTel ingestion (until the OTel de-S3 migration), so a
    // missing bucket there is a misconfiguration, not the default path.
    throw new Error(
      "LANGFUSE_S3_EVENT_UPLOAD_BUCKET must be set to use the event blob store (required for OTel ingestion).",
    );
  }
  if (!s3EventStorageClient) {
    s3EventStorageClient = StorageServiceFactory.getInstance({
      bucketName,
      accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_EVENT_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LANGFUSE_S3_EVENT_UPLOAD_SSE,
      awsSseKmsKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID,
    });
  }
  return s3EventStorageClient;
};
