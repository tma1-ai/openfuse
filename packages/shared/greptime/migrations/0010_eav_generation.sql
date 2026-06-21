-- EAV generation columns: eliminate the per-write EAV DELETE (write amplification + GreptimeDB
-- tombstone/compaction pressure that saturated the cluster under live load).
--
-- Each rebuild stamps a monotonic `generation` (the rebuild's max raw_events ingested_at, ms) on every
-- EAV row and a matching `eav_generation` on the projection row. The mito `last_non_null` merge keeps,
-- per (project, entity, key), the latest-written generation; a key that DROPS out of an updated entity
-- simply has no row at the new generation, so a read that correlates `eav.generation =
-- projection.eav_generation` excludes it WITHOUT any up-front delete. ClickHouse got the same effect
-- from reading the whole Map off the latest ReplacingMergeTree row.
--
-- DEFAULT 0: rows written before this migration (and any backfilled existing row) read as generation 0
-- and match each other (0 = 0), so legacy data — which the old DELETE path kept consistent — stays
-- readable. Real generations are ms-epoch (~1.7e12 > 0), so the first post-migration rebuild of a
-- legacy entity supersedes its 0-generation rows and a dropped key's 0-generation row is excluded.
--
-- Apply: mysql -h127.0.0.1 -P4002 -uroot openfuse < 0010_eav_generation.sql

-- Projection tables: the generation of the entity's CURRENT EAV set.
ALTER TABLE traces       ADD COLUMN `eav_generation` BIGINT DEFAULT 0;
ALTER TABLE observations ADD COLUMN `eav_generation` BIGINT DEFAULT 0;
ALTER TABLE scores       ADD COLUMN `eav_generation` BIGINT DEFAULT 0;

-- EAV derived-index tables: the generation each row was written at.
ALTER TABLE traces_metadata               ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE observations_metadata         ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE scores_metadata               ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE traces_tags                   ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE observations_usage_cost       ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE observations_tool_definitions ADD COLUMN `generation` BIGINT DEFAULT 0;
ALTER TABLE observations_tool_calls       ADD COLUMN `generation` BIGINT DEFAULT 0;
