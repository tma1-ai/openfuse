-- The `migrateEventLogToBlobStorageRefTable` background migration backfilled the ClickHouse
-- blob_storage_file_log table from the legacy event_log table. Both tables are retired on the
-- GreptimeDB backend (S3 event files are managed by bucket lifecycle policy, not a tracking
-- table), and the migration script has been removed. Drop its seed row so the background
-- migration runner does not try to load a script that no longer exists.
DELETE FROM background_migrations
WHERE id = 'c19b91d9-f9a2-468b-8209-95578f970c5b';
