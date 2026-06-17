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
  // The event blob store carries OTel resourceSpans from the API to the worker. It honors the same
  // backend toggle as the eval observation blob (LANGFUSE_EVENT_STORAGE_BACKEND): "local" writes to a
  // shared filesystem volume so OTel ingestion needs no object store; "s3" requires a bucket. The
  // worker still does masking / conversion / eval scheduling — only the carrier location changes.
  const useLocalFileStorage = env.LANGFUSE_EVENT_STORAGE_BACKEND === "local";
  if (!useLocalFileStorage && !bucketName) {
    throw new Error(
      "LANGFUSE_S3_EVENT_UPLOAD_BUCKET must be set when LANGFUSE_EVENT_STORAGE_BACKEND is 's3' (used by OTel ingestion).",
    );
  }
  if (!s3EventStorageClient) {
    s3EventStorageClient = StorageServiceFactory.getInstance({
      bucketName: bucketName ?? "",
      accessKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
      endpoint: env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT,
      region: env.LANGFUSE_S3_EVENT_UPLOAD_REGION,
      forcePathStyle: env.LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
      awsSse: env.LANGFUSE_S3_EVENT_UPLOAD_SSE,
      awsSseKmsKeyId: env.LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID,
      useLocalFileStorage,
      localFileStoragePath: env.LANGFUSE_EVENT_LOCAL_PATH,
    });
  }
  return s3EventStorageClient;
};
