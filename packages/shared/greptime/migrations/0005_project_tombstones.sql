-- 0005_project_tombstones.sql (03-... project-delete guard)
--
-- Project-level deletion marker. `deleteProjectFromGreptime` appends one row per project delete.
-- The rebuild / reconciliation path treats every entity in a tombstoned project as soft-deleted, so
-- a TTL-window reprocess-all or late append during deletion cannot resurrect a deleted project's
-- projections. This is the project-scope sibling of the per-entity raw_events tombstone (unified
-- deletion predicate).
--
-- append_mode: markers are only appended. Intentionally NOT given a TTL — the marker must outlive
-- the raw_events it guards, so it is retained indefinitely (tiny: one row per deleted project).
CREATE TABLE IF NOT EXISTS project_tombstones (
    `deleted_at`  TIMESTAMP(3) NOT NULL TIME INDEX,   -- ingestion-time of the project delete (ms)
    `project_id`  STRING NOT NULL,
    PRIMARY KEY (project_id)
) WITH ('append_mode' = 'true');
