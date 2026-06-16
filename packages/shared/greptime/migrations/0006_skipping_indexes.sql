-- GreptimeDB bloom skipping indexes for the hottest equality / IN filter + join columns on the main
-- projection tables (04-read-path.md). 0001 created these as plain STRING; the read path filters and
-- joins on them constantly but they carried no index, so a `trace_id IN (...)` / `session_id IN (...)`
-- query did a full SeqScan of the table's SST files. A bloom skipping index lets GreptimeDB prune the
-- files that cannot contain the value (effective at production scale, where an entity's rows cluster
-- into a few time-adjacent files). Mirrors the dataset_run_items approach in 0003.
--
-- Bloom skipping indexes prune on equality / IN only (the hot patterns: observations by trace_id,
-- scores by trace_id / observation_id, traces by session_id / user_id). Range scans stay bounded by
-- the TIME INDEX. Roll a column back with `ALTER TABLE <t> MODIFY COLUMN <c> UNSET SKIPPING INDEX`.
--
-- Apply: mysql -h127.0.0.1 -P4002 -uroot openfuse < 0006_skipping_indexes.sql

ALTER TABLE observations MODIFY COLUMN `trace_id`      SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);

ALTER TABLE scores       MODIFY COLUMN `trace_id`      SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE scores       MODIFY COLUMN `observation_id` SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);

ALTER TABLE traces       MODIFY COLUMN `session_id`    SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE traces       MODIFY COLUMN `user_id`       SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
