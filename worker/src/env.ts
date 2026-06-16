import { removeEmptyEnvVariables } from "@langfuse/shared";
import { z } from "zod";

const EnvSchema = z.object({
  BUILD_ID: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string(),
  HOSTNAME: z.string().default("0.0.0.0"),
  PORT: z.coerce
    .number() // ".env files convert numbers to strings, therefore we have to enforce them to be numbers"
    .positive()
    .max(65536, `options.port should be >= 0 and < 65536`)
    .default(3030),

  NEXTAUTH_URL: z.string().optional(),

  NEXT_PUBLIC_LANGFUSE_CLOUD_REGION: z
    .enum(["US", "EU", "STAGING", "DEV", "HIPAA", "JP"])
    .optional(),

  STRIPE_SECRET_KEY: z.string().optional(),

  LANGFUSE_CACHE_AUTOMATIONS_ENABLED: z.enum(["true", "false"]).default("true"),
  LANGFUSE_CACHE_AUTOMATIONS_TTL_SECONDS: z.coerce.number().default(60),
  LANGFUSE_S3_BATCH_EXPORT_ENABLED: z.enum(["true", "false"]).default("false"),
  LANGFUSE_S3_BATCH_EXPORT_BUCKET: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_PREFIX: z.string().default(""),
  LANGFUSE_S3_BATCH_EXPORT_REGION: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_ENDPOINT: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: z.string().optional(),
  LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_S3_BATCH_EXPORT_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LANGFUSE_S3_BATCH_EXPORT_SSE_KMS_KEY_ID: z.string().optional(),

  LANGFUSE_S3_EVENT_UPLOAD_BUCKET: z.string({
    error: "Langfuse requires a bucket name for S3 Event Uploads.",
  }),
  LANGFUSE_S3_EVENT_UPLOAD_PREFIX: z.string().default(""),
  LANGFUSE_S3_EVENT_UPLOAD_REGION: z.string().optional(),
  LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: z.string().optional(),
  LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_S3_EVENT_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LANGFUSE_S3_EVENT_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),

  BATCH_EXPORT_PAGE_SIZE: z.coerce.number().positive().default(500),
  BATCH_EXPORT_ROW_LIMIT: z.coerce.number().positive().default(1_500_000),
  BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS: z.coerce
    .number()
    .positive()
    .default(24),
  BATCH_EXPORT_S3_PART_SIZE_MIB: z.coerce.number().min(5).max(100).default(10),
  BATCH_ACTION_EXPORT_ROW_LIMIT: z.coerce.number().positive().default(50_000),
  LANGFUSE_MAX_HISTORIC_EVAL_CREATION_LIMIT: z.coerce
    .number()
    .positive()
    .default(50_000),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  SMTP_CONNECTION_URL: z.string().optional(),
  CLOUD_CRM_EMAIL: z.string().optional(),
  LANGFUSE_OTEL_INGESTION_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_OTEL_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(1),
  LANGFUSE_SECONDARY_OTEL_INGESTION_QUEUE_ENABLED_PROJECT_IDS: z
    .string()
    .optional(),
  LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(20),
  LANGFUSE_INGESTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_SECONDARY_INGESTION_QUEUE_ENABLED_PROJECT_IDS: z.string().optional(),
  LANGFUSE_INGESTION_WRITE_BATCH_SIZE: z.coerce
    .number()
    .positive()
    .default(1000),
  LANGFUSE_INGESTION_WRITE_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(1000),
  LANGFUSE_INGESTION_WRITE_MAX_ATTEMPTS: z.coerce
    .number()
    .positive()
    .default(3),

  LANGFUSE_USE_AZURE_BLOB: z.enum(["true", "false"]).default("false"),

  // GreptimeDB write path (02-write-path.md). See packages/shared/src/env.ts for semantics.
  GREPTIME_GRPC_URL: z.string().default("localhost:4001"),
  GREPTIME_SQL_HOST: z.string().default("localhost"),
  GREPTIME_SQL_PORT: z.coerce.number().int().positive().default(4002),
  GREPTIME_SQL_READ_ONLY_HOST: z.string().optional(),
  GREPTIME_DB: z.string().default("openfuse"),
  GREPTIME_USER: z.string().default(""),
  GREPTIME_PASSWORD: z.string().default(""),
  GREPTIME_SQL_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(25),
  GREPTIME_RAW_EVENTS_TABLE: z.string().default("raw_events"),
  // Per-field byte cap applied only reactively: when a single isolated row still fails the write as
  // oversized (gRPC RESOURCE_EXHAUSTED), its large string/JSON fields are truncated to this size and
  // the row is retried once before being dropped. Generous default — it only ever bites rows the
  // server already refused, so it never silently truncates a row that would have written.
  LANGFUSE_GREPTIME_WRITE_MAX_FIELD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000_000),
  // Entities enumerated + rebuilt per reconciliation job before it re-enqueues itself with the next
  // keyset cursor. Conservative default; bound by raw_events read + projection write throughput.
  LANGFUSE_GREPTIME_RECONCILIATION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  LANGFUSE_GREPTIME_RECONCILIATION_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(1),
  LANGFUSE_EVAL_CREATOR_LIMITER_DURATION: z.coerce
    .number()
    .positive()
    .default(500),
  LANGFUSE_EVAL_CREATOR_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(2),
  LANGFUSE_TRACE_UPSERT_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(25),
  LANGFUSE_TRACE_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LANGFUSE_SCORE_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  // Delay (ms) inserted after each Mixpanel flush to throttle analytics exports
  // and avoid overwhelming the target instance (see issue #12786).
  LANGFUSE_MIXPANEL_FLUSH_DELAY_MS: z.coerce.number().min(0).default(100),
  LANGFUSE_DATASET_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LANGFUSE_PROJECT_DELETE_CONCURRENCY: z.coerce.number().positive().default(1),
  LANGFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_LLM_AS_JUDGE_EXECUTION_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_CODE_EVAL_EXECUTION_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_EVAL_EXECUTION_SECONDARY_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_SECONDARY_EVAL_EXECUTION_QUEUE_ENABLED_PROJECT_IDS: z
    .string()
    .optional(),
  LANGFUSE_EXPERIMENT_CREATOR_WORKER_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),

  // Skip the baseline read within the Ingestion pipeline for the given project
  // ids. Applicable for projects that were created after the S3 write was
  // activated and which don't rely on historic updates.
  LANGFUSE_SKIP_INGESTION_READ_PROJECT_IDS: z.string().default(""),
  // Set a date after which S3 was active. Projects created after this date do
  // perform a baseline read as part of the ingestion pipeline.
  LANGFUSE_SKIP_INGESTION_READ_MIN_PROJECT_CREATE_DATE: z.iso
    .date()
    .optional(),

  // Otel
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  OTEL_SERVICE_NAME: z.string().default("worker"),

  LANGFUSE_ENABLE_BACKGROUND_MIGRATIONS: z
    .enum(["true", "false"])
    .default("true"),

  LANGFUSE_ENABLE_REDIS_SEEN_EVENT_CACHE: z
    .enum(["true", "false"])
    .default("false"),

  LANGFUSE_BLOB_STORAGE_FAILURE_NOTIFICATION_COOLDOWN_HOURS: z.coerce
    .number()
    .positive()
    .default(24),

  // Comma-separated list of project IDs that should only export traces table (skip observations and scores)
  LANGFUSE_BLOB_STORAGE_EXPORT_TRACE_ONLY_PROJECT_IDS: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((id) => id.trim()) : [])),

  LANGFUSE_MONITOR_SCHEDULER_ENABLED: z.enum(["true", "false"]).default("true"),
  LANGFUSE_MONITOR_SCHEDULERS: z.coerce.number().int().min(1).default(1),

  // Flags to toggle queue consumers on or off.
  QUEUE_CONSUMER_MONITOR_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CLOUD_SPEND_ALERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_INGESTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BATCH_EXPORT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BATCH_ACTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EVAL_EXECUTION_SECONDARY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CODE_EVAL_EXECUTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_TRACE_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_SCORE_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_GREPTIME_RECONCILIATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DATASET_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_PROJECT_DELETE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DATASET_RUN_ITEM_UPSERT_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_EXPERIMENT_CREATE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_POSTHOG_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_MIXPANEL_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_BLOB_STORAGE_INTEGRATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_OTEL_INGESTION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_OTEL_INGESTION_SECONDARY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_INGESTION_SECONDARY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_DEAD_LETTER_RETRY_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  QUEUE_CONSUMER_WEBHOOK_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_ENTITY_CHANGE_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  QUEUE_CONSUMER_NOTIFICATION_QUEUE_IS_ENABLED: z
    .enum(["true", "false"])
    .default("true"),

  // Core data S3 upload - Langfuse Cloud
  LANGFUSE_S3_CORE_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_S3_CORE_DATA_UPLOAD_BUCKET: z.string().optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_PREFIX: z.string().default(""),
  LANGFUSE_S3_CORE_DATA_UPLOAD_REGION: z.string().optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_ENDPOINT: z.string().optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_S3_CORE_DATA_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LANGFUSE_S3_CORE_DATA_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),

  // Media upload
  LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: z.string().optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_PREFIX: z.string().default(""),
  LANGFUSE_S3_MEDIA_UPLOAD_REGION: z.string().optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: z.string().optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: z.string().optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: z.string().optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_S3_MEDIA_UPLOAD_SSE: z.enum(["AES256", "aws:kms"]).optional(),
  LANGFUSE_S3_MEDIA_UPLOAD_SSE_KMS_KEY_ID: z.string().optional(),
  LANGFUSE_MEDIA_STORAGE_BACKEND: z.enum(["s3", "local"]).default("s3"),
  LANGFUSE_MEDIA_LOCAL_PATH: z.string().optional(),

  // Metering data Postgres export - Langfuse Cloud
  LANGFUSE_POSTGRES_METERING_DATA_EXPORT_IS_ENABLED: z
    .enum(["true", "false"])
    .default("false"),

  // When disabled: Usage is still tracked in DB but no emails are sent and no orgs are blocked
  // When enabled: Full enforcement (emails + blocking)
  LANGFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED: z
    .enum(["true", "false"])
    .default("false"),

  LANGFUSE_S3_CONCURRENT_READS: z.coerce.number().positive().default(50),
  LANGFUSE_PROJECT_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes
  LANGFUSE_TRACE_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(120_000), // 2 minutes
  LANGFUSE_DATASET_DELETION_CONCURRENCY_DURATION_MS: z.coerce
    .number()
    .positive()
    .default(120_000), // 2 minutes

  // Batch Project Cleaner configuration
  LANGFUSE_BATCH_PROJECT_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_BATCH_PROJECT_CLEANER_CHECK_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between checks after successful processing
  LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour sleep when there is no data to process
  LANGFUSE_BATCH_PROJECT_CLEANER_PROJECT_LIMIT: z.coerce
    .number()
    .positive()
    .default(1000), // Max projects per batch
  LANGFUSE_BATCH_PROJECT_CLEANER_DELETE_TIMEOUT_MS: z.coerce
    .number()
    .positive()
    .default(3_600_000), // 1 hour for DELETE operations

  // Batch Project Media Cleaner configuration (S3/PostgreSQL)
  LANGFUSE_BATCH_PROJECT_MEDIA_CLEANER_BATCH_SIZE: z.coerce
    .number()
    .positive()
    .default(5000), // Media items per chunk

  // Media Retention Cleaner configuration (S3/PostgreSQL)
  LANGFUSE_MEDIA_RETENTION_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_MEDIA_RETENTION_CLEANER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between runs
  LANGFUSE_MEDIA_RETENTION_CLEANER_ITEM_LIMIT: z.coerce
    .number()
    .positive()
    .default(10_000), // Max items (media files) to process per batch

  // Batch Trace Deletion Cleaner configuration
  LANGFUSE_BATCH_TRACE_DELETION_CLEANER_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
  LANGFUSE_BATCH_TRACE_DELETION_CLEANER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(600_000), // 10 minutes between runs
  LANGFUSE_BATCH_TRACE_DELETION_CLEANER_LOCK_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(7200), // 2 hours to handle worst-case deletions

  LANGFUSE_WEBHOOK_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(5),
  LANGFUSE_WEBHOOK_TIMEOUT_MS: z.coerce.number().positive().default(10000),
  LANGFUSE_WEBHOOK_MAX_REDIRECTS: z.coerce.number().positive().default(10),
  LANGFUSE_ENTITY_CHANGE_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(2),
  LANGFUSE_MONITOR_QUEUE_PROCESSING_CONCURRENCY: z.coerce
    .number()
    .positive()
    .default(10),
  LANGFUSE_DELETE_BATCH_SIZE: z.coerce.number().positive().default(2000),
  LANGFUSE_TOKEN_COUNT_WORKER_POOL_SIZE: z.coerce
    .number()
    .positive()
    .default(2),
  LANGFUSE_QUEUE_METRICS_SAMPLE_RATE: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.3), // Probability for recording sharded queue depth metrics
  LANGFUSE_QUEUE_METRICS_INTERVAL_MS: z.coerce.number().min(100).default(1000),
  LANGFUSE_QUEUE_METRICS_ENABLED: z.enum(["true", "false"]).default("true"),
});

type ParsedEnv = z.infer<typeof EnvSchema>;

const parseEnv = (): ParsedEnv => {
  return EnvSchema.parse(removeEmptyEnvVariables(process.env));
};

export const env: ParsedEnv =
  process.env.DOCKER_BUILD === "1" // eslint-disable-line turbo/no-undeclared-env-vars
    ? (process.env as any)
    : parseEnv();
