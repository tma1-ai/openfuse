-- GreptimeDB index follow-up to 0006 (04-read-path.md). 0006 added bloom skipping indexes for the
-- hottest high-cardinality equality/join columns (trace_id / observation_id / session_id / user_id).
-- This migration closes two remaining gaps the read path hits at production scale:
--
--   1. scores.session_id / scores.dataset_run_id  -> BLOOM SKIPPING INDEX
--      Session-scoped and dataset-run-scoped scores are extremely sparse (a handful of rows per
--      session / run) but the read path filters scores by them constantly (getScoresFor{Sessions,
--      Experiments}, the public-API score CTE that splits trace- vs session- vs run-grain). Without
--      an index these did a full SeqScan of every SST file. Bloom prunes the files that cannot hold
--      the value -- the same rationale as 0006 (trace_id/observation_id). Equality / IN only.
--
--   2. Low-cardinality enum-like columns -> INVERTED INDEX
--      scores.{source,data_type,environment}, observations.{type,level,environment}, traces.environment.
--      These have a handful of distinct values dominated by one (e.g. source=ANNOTATION ~99%,
--      data_type=NUMERIC ~99%, environment=default ~99%). A bloom index is the wrong tool for low
--      cardinality; an INVERTED INDEX builds a per-value posting list, so selective filters on the
--      rare values (source='API', data_type='CATEGORICAL', level='ERROR', a non-default environment)
--      prune to the matching row groups. Queries on the dominant value simply do not use the index
--      (no benefit, no harm), which is the expected and correct behavior.
--
-- Range scans stay bounded by the TIME INDEX. Roll a column back with
-- `ALTER TABLE <t> MODIFY COLUMN <c> UNSET SKIPPING INDEX` / `UNSET INVERTED INDEX`.
--
-- Apply: mysql -h127.0.0.1 -P4002 -uroot openfuse < 0007_indexes_followup.sql

-- 1. sparse high-cardinality reference columns on scores -> bloom skipping
ALTER TABLE scores MODIFY COLUMN `session_id`     SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);
ALTER TABLE scores MODIFY COLUMN `dataset_run_id` SET SKIPPING INDEX WITH (granularity = 1024, type = 'BLOOM', false_positive_rate = 0.01);

-- 2. low-cardinality enum-like columns -> inverted
ALTER TABLE scores       MODIFY COLUMN `source`      SET INVERTED INDEX;
ALTER TABLE scores       MODIFY COLUMN `data_type`   SET INVERTED INDEX;
ALTER TABLE scores       MODIFY COLUMN `environment` SET INVERTED INDEX;

ALTER TABLE observations MODIFY COLUMN `type`        SET INVERTED INDEX;
ALTER TABLE observations MODIFY COLUMN `level`       SET INVERTED INDEX;
ALTER TABLE observations MODIFY COLUMN `environment` SET INVERTED INDEX;

ALTER TABLE traces       MODIFY COLUMN `environment` SET INVERTED INDEX;
